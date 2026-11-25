/**
 * Every message the app sends, kept as a record that does not depend on where it went.
 *
 * Telegram is one channel; a push to a native app would be another. Each send produces one
 * {@link AppNotification}: the text as composed (Telegram's HTML subset, which is what every
 * composer writes), the same text as portable {@link Span}s that a web page or an iOS
 * `AttributedString` can render without parsing HTML, and one {@link Delivery} per channel.
 */

export type NotificationKind = "weekly" | "checkin" | "milestones" | "stale";

/** A run of text with its formatting. `\n` inside `text` is a line break. */
export interface Span {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  /** Monospace; a code block keeps its line breaks and alignment. */
  code?: true;
  /** Only http(s) links survive; anything else is kept as plain text. */
  href?: string;
}

export type DeliveryChannel = "telegram";

export interface Delivery {
  channel: DeliveryChannel;
  status: "sent" | "failed";
  at: string;
  /** Bounded; never contains a token. */
  error?: string;
}

export interface AppNotification {
  /** Sorts newest-first as a string; see {@link notificationId}. */
  id: string;
  kind: NotificationKind;
  /** First line of the message, as plain text — what a push banner or a list row shows. */
  title: string;
  /** The message as composed, Telegram HTML. */
  html: string;
  createdAt: string;
  /** Where tapping it should go, as an app-relative path (`/api/dashboard`). */
  link: string;
  deliveries: Delivery[];
  /** What it was about — the week it reviews, the milestone keys. */
  meta?: Record<string, string | string[]>;
}

/** Where each kind points when opened. One table, so web and app agree. */
export const NOTIFICATION_LINKS: Record<NotificationKind, string> = {
  weekly: "/api/dashboard",
  checkin: "/api/dashboard",
  milestones: "/api/dashboard",
  stale: "/api/recovery",
};

const MAX_TIME = 9_999_999_999_999;

/**
 * Newest-first ids: Table Storage returns rows in RowKey order, so the key is the time
 * remaining until the year 2286, zero-padded, plus a suffix that keeps two messages sent in
 * the same millisecond apart.
 */
export function notificationId(createdAt: Date, suffix: string): string {
  return `${String(MAX_TIME - createdAt.getTime()).padStart(13, "0")}-${suffix}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

type Style = Omit<Span, "text">;
const STYLE_OF: Record<string, Exclude<keyof Style, "href">> = {
  b: "bold", strong: "bold", i: "italic", em: "italic", u: "underline", ins: "underline",
  s: "strike", strike: "strike", del: "strike", code: "code", pre: "code",
};

/**
 * Telegram's HTML subset → spans. Unknown tags are dropped (their text kept), so a composer
 * that grows a new tag degrades to plain text rather than to markup on screen.
 */
export function toSpans(html: string): Span[] {
  const spans: Span[] = [];
  const stack: { tag: string; style: Style }[] = [];
  const current = (): Style => Object.assign({}, ...stack.map((s) => s.style)) as Style;
  const push = (raw: string) => {
    const text = decodeEntities(raw);
    if (!text) return;
    const style = current();
    const last = spans[spans.length - 1];
    if (last && sameStyle(last, style)) last.text += text;
    else spans.push({ text, ...style });
  };

  const tag = /<\s*(\/)?\s*([a-z][a-z0-9-]*)([^>]*)>/gi;
  let at = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    push(html.slice(at, m.index));
    at = m.index + m[0].length;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (closing) {
      const i = stack.map((s) => s.tag).lastIndexOf(name);
      if (i >= 0) stack.splice(i);
      continue;
    }
    if (name === "br") { push("\n"); continue; }
    const style: Style = {};
    const flag = STYLE_OF[name];
    if (flag) style[flag] = true;
    if (name === "a") {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[3] ?? "");
      const url = href ? decodeEntities(href[2] ?? href[3] ?? "") : "";
      if (/^https?:\/\//i.test(url)) style.href = url;
    }
    stack.push({ tag: name, style });
  }
  push(html.slice(at));
  return spans;
}

function sameStyle(a: Span, b: Style): boolean {
  const keys: (keyof Style)[] = ["bold", "italic", "underline", "strike", "code", "href"];
  return keys.every((k) => a[k] === b[k]);
}

export function plainText(spans: Span[]): string {
  return spans.map((s) => s.text).join("");
}

/** The first non-empty line, trimmed and bounded — a push banner's title. */
export function titleOf(html: string, max = 120): string {
  const line = plainText(toSpans(html)).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What the API returns: the stored record plus the forms a client renders. */
export function presentNotification(n: AppNotification): AppNotification & { spans: Span[]; text: string } {
  const spans = toSpans(n.html);
  return { ...n, spans, text: plainText(spans) };
}
