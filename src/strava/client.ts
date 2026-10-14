import type { SettingsRepository } from "../storage/settingsRepository.js";
import type { StravaActivity, StravaPhoto } from "../domain/strava.js";

/**
 * The slice of Strava's API this app uses, with the OAuth tokens kept in the settings
 * table — Strava rotates the refresh token on every refresh, so it cannot live in an app
 * setting. Read scope only (`activity:read_all` for private activities too).
 */

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  athleteId?: number;
  athleteName?: string;
}

export const TOKENS_KEY = "strava.tokens";
export const CURSOR_KEY = "strava.cursor";
const API = "https://www.strava.com/api/v3";

export class StravaError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "StravaError"; }
}

export function authoriseUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, approval_prompt: "auto", scope: "read,activity:read_all", state });
  return `https://www.strava.com/oauth/authorize?${q}`;
}

export class StravaClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly settings: SettingsRepository,
  ) {}

  async exchangeCode(code: string): Promise<StravaTokens> {
    const t = await this.token({ grant_type: "authorization_code", code });
    await this.settings.set(TOKENS_KEY, t);
    return t;
  }

  async tokens(): Promise<StravaTokens | undefined> {
    return this.settings.get<StravaTokens>(TOKENS_KEY);
  }

  private async accessToken(): Promise<string> {
    let t = await this.tokens();
    if (!t) throw new StravaError("Strava is not connected — open /api/strava/connect first");
    if (t.expiresAt - 60 < Date.now() / 1000) {
      t = await this.token({ grant_type: "refresh_token", refresh_token: t.refreshToken }, t);
      await this.settings.set(TOKENS_KEY, t);
    }
    return t.accessToken;
  }

  private async token(params: Record<string, string>, previous?: StravaTokens): Promise<StravaTokens> {
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params });
    const r = await fetch("https://www.strava.com/oauth/token", { method: "POST", body });
    if (!r.ok) throw new StravaError(`Strava token request failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`, r.status);
    const j = (await r.json()) as { access_token: string; refresh_token: string; expires_at: number; athlete?: { id?: number; firstname?: string; lastname?: string } };
    return {
      accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: j.expires_at,
      ...(j.athlete?.id !== undefined ? { athleteId: j.athlete.id } : previous?.athleteId !== undefined ? { athleteId: previous.athleteId } : {}),
      ...(j.athlete?.firstname ? { athleteName: `${j.athlete.firstname} ${j.athlete.lastname ?? ""}`.trim() } : previous?.athleteName ? { athleteName: previous.athleteName } : {}),
    };
  }

  private async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const token = await this.accessToken();
    const q = new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])));
    const r = await fetch(`${API}${path}?${q}`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 429) throw new StravaError("Strava rate limit reached (200 requests per 15 minutes); try again later", 429);
    if (!r.ok) throw new StravaError(`Strava ${path} failed: ${r.status}`, r.status);
    return (await r.json()) as T;
  }

  /** Activities started after `after` (Unix seconds), oldest first, all pages. */
  async activitiesAfter(after: number, maxPages = 10): Promise<StravaActivity[]> {
    const out: StravaActivity[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<StravaActivity[]>("/athlete/activities", { after, per_page: 200, page });
      out.push(...batch);
      if (batch.length < 200) break;
    }
    return out.sort((a, b) => a.start_date.localeCompare(b.start_date));
  }

  async photos(id: number): Promise<StravaPhoto[]> {
    return this.get<StravaPhoto[]>(`/activities/${id}/photos`, { size: 1024, photo_sources: "true" });
  }
}
