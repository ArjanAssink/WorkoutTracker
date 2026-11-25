import { randomUUID } from "node:crypto";
import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { config } from "../config/index.js";
import {
  advanceReadMarker, NOTIFICATION_ID, NOTIFICATION_LINKS, notificationId, presentNotification, titleOf, unreadCount,
  type AppNotification, type Delivery, type NotificationKind,
} from "../domain/notifications.js";
import { readJsonBody } from "../http/jsonBody.js";
import { isAuthorised } from "../http/auth.js";
import { badRequest, ok, serverError, unauthorised } from "../http/responses.js";
import { getNotificationRepository, getSettingsRepository } from "./shared.js";

/**
 * The one way a message leaves the app. It is delivered to every configured channel
 * (Telegram today; a native app's push would be another `Delivery`), then stored with the
 * outcome, so the Notifications page — and later the app — shows exactly what was sent and
 * whether it arrived.
 *
 * Storing never blocks sending, and a failed store never fails the caller: the message has
 * gone out either way. A failed *send* is stored too, then rethrown, so callers keep their
 * existing behaviour (the HTTP endpoints answer 502; milestones are not marked as sent).
 */
export async function notify(
  message: { kind: NotificationKind; html: string; meta?: Record<string, string | string[]> },
  context: InvocationContext,
  what: string,
  now = new Date(),
): Promise<AppNotification> {
  const deliveries: Delivery[] = [];
  let failure: unknown;
  if (config().telegram) {
    try {
      await sendTelegram(message.html);
      deliveries.push({ channel: "telegram", status: "sent", at: new Date().toISOString() });
      context.log(`${what} sent to Telegram`);
    } catch (error) {
      failure = error;
      deliveries.push({ channel: "telegram", status: "failed", at: new Date().toISOString(), error: String(error instanceof Error ? error.message : error).slice(0, 300) });
    }
  }

  const notification: AppNotification = {
    id: notificationId(now, randomUUID().slice(0, 8)),
    kind: message.kind,
    title: titleOf(message.html),
    html: message.html,
    createdAt: now.toISOString(),
    link: NOTIFICATION_LINKS[message.kind],
    deliveries,
    ...(message.meta ? { meta: message.meta } : {}),
  };
  try {
    await (await getNotificationRepository()).save(notification);
  } catch (error) {
    context.error(`${what}: could not store the notification`, error);
  }
  if (failure) throw failure;
  return notification;
}

async function sendTelegram(text: string): Promise<void> {
  const { telegram } = config();
  if (!telegram) throw new Error("Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  const response = await fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: telegram.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!response.ok) {
    // Telegram's error body says what is wrong (bad chat id, HTML parse error…); the
    // token is in the URL, never in the message, so this is safe to log and store.
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram responded ${response.status}: ${body.slice(0, 300)}`);
  }
}

const MAX_LIMIT = 100;
/** Where the read marker lives: one id, shared by every browser and, later, the app. */
const READ_KEY = "notifications.readThrough";
/** A badge says "99+" past this; counting further would scan the whole table for nothing. */
const UNREAD_SCAN = 100;

async function readState(): Promise<{ readThrough: string | undefined; unread: number }> {
  const readThrough = await (await getSettingsRepository()).get<string>(READ_KEY);
  const recent = await (await getNotificationRepository()).list(UNREAD_SCAN);
  return { readThrough, unread: unreadCount(recent.map((n) => n.id), readThrough) };
}

/**
 * `GET /api/notifications?limit=&after=` — newest first. Each row carries the composed
 * HTML, the same message as `spans` (styled runs a page or an iOS AttributedString renders
 * without parsing HTML), plain `text`, a `title` for a banner, the `link` to open, and one
 * delivery per channel. `unread` counts rows newer than `readThrough` (capped at 100);
 * `next` is the cursor for the following page, absent on the last.
 */
export async function listNotifications(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 0) return badRequest("'limit' must be a non-negative integer");
  const after = params.get("after") ?? undefined;
  if (after !== undefined && !NOTIFICATION_ID.test(after)) return badRequest("'after' is not a notification id");
  try {
    const take = Math.min(limit, MAX_LIMIT);
    const [rows, state] = await Promise.all([
      take > 0 ? (await getNotificationRepository()).list(take + 1, after) : Promise.resolve([]),
      readState(),
    ]);
    const page = rows.slice(0, take);
    return ok({
      unread: state.unread,
      ...(state.readThrough ? { readThrough: state.readThrough } : {}),
      notifications: page.map(presentNotification),
      ...(rows.length > page.length ? { next: page[page.length - 1]!.id } : {}),
    });
  } catch (error) {
    context.error("Failed to list notifications", error);
    return serverError("Failed to list notifications");
  }
}

/**
 * `POST /api/notifications/read` `{ "through": "<id>" }` — everything at or older than that
 * notification is read. The marker never moves backwards, so a stale tab cannot un-read.
 */
export async function markNotificationsRead(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthorised(request, config().ingestApiKey)) return unauthorised();
  let body: unknown;
  try { body = await readJsonBody(request); }
  catch (error) { return badRequest(error instanceof Error ? error.message : "Invalid body"); }
  const through = (body as { through?: unknown } | null)?.through;
  if (typeof through !== "string" || !NOTIFICATION_ID.test(through)) return badRequest("'through' must be a notification id");
  try {
    const settings = await getSettingsRepository();
    const next = advanceReadMarker(await settings.get<string>(READ_KEY), through);
    await settings.set(READ_KEY, next);
    const state = await readState();
    return ok({ readThrough: next, unread: state.unread });
  } catch (error) {
    context.error("Failed to mark notifications read", error);
    return serverError("Failed to mark notifications read");
  }
}

/** The page it replaced; the list is a panel on every page now. Kept so old links land somewhere. */
export async function inboxRedirect(): Promise<HttpResponseInit> {
  return { status: 302, headers: { location: "/api/dashboard?notifications" } };
}

app.http("listNotifications", { route: "api/notifications", methods: ["GET"], authLevel: "anonymous", handler: listNotifications });
app.http("markNotificationsRead", { route: "api/notifications/read", methods: ["POST"], authLevel: "anonymous", handler: markNotificationsRead });
app.http("inboxRedirect", { route: "api/inbox", methods: ["GET"], authLevel: "anonymous", handler: inboxRedirect });
