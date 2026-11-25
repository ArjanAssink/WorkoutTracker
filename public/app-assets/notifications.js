/*
 * Notifications: a bell at the top of every page's header, with the unread count as a
 * badge, opening a panel over the page. Every message the app has sent (weekly summary,
 * check-ins, milestones, alerts) is listed there, rendered from the API's `spans` — styled
 * runs, never HTML — so a native app can draw the same records the same way.
 *
 * Read state is one server-side marker (`POST /api/notifications/read`), so a phone and a
 * laptop agree on what is new. Opening the panel marks everything shown as read.
 *
 * `?notifications` opens the panel on load; `?notification=<id>` opens it on that message —
 * what a push notification's tap will link to.
 */
(() => {
  "use strict";
  const KEY_STORAGE = "workout-tracker.apiKey";
  const PAGE = 30;
  const KIND = { weekly: "Weekly summary", checkin: "Thursday check-in", milestones: "Milestone", stale: "Alert" };
  const LINK = { "/api/dashboard": "Open dashboard", "/api/recovery": "Open recovery", "/api/history": "Open workouts" };
  const state = { unread: 0, items: [], next: undefined, seenBefore: undefined, open: false, loading: false, target: "", returnFocus: null };

  const key = () => { try { return localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; } };
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v); }
    for (const c of children) if (c !== null && c !== undefined) e.append(c);
    return e;
  }
  const svg = (paths) => {
    const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
    for (const d of paths) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.append(p); }
    return s;
  };

  /* ---- styles: page variables with fallbacks, so every page themes it without new tokens ---- */
  const css = `
.wn-bell { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; flex: none; align-self: center;
  border-radius: 10px; border: 1px solid var(--border, rgba(11,11,11,.1)); background: var(--surface-1, #fff); color: var(--text-secondary, #52514e); cursor: pointer; padding: 0; }
.wn-bell:hover { background: var(--hover-wash, rgba(11,11,11,.04)); color: var(--text-primary, #0b0b0b); }
.wn-bell:focus-visible, .wn-close:focus-visible, .wn-more:focus-visible, .wn-card a:focus-visible { outline: 2px solid var(--series-1, #2a78d6); outline-offset: 2px; }
.wn-badge { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; box-sizing: border-box;
  background: #d03b3b; color: #fff; font: 600 11px/18px system-ui, -apple-system, sans-serif; text-align: center; box-shadow: 0 0 0 2px var(--page, #f9f9f7); }
.wn-badge[hidden] { display: none; }
.wn-backdrop { position: fixed; inset: 0; z-index: 10001; background: rgba(0,0,0,.32); opacity: 0; transition: opacity 160ms ease; }
.wn-panel { position: fixed; z-index: 10002; top: 0; right: 0; bottom: 0; width: min(440px, 100vw); display: flex; flex-direction: column;
  background: var(--page, #f9f9f7); color: var(--text-primary, #0b0b0b); box-shadow: -8px 0 32px rgba(0,0,0,.18);
  transform: translateX(100%); transition: transform 200ms cubic-bezier(.2,.7,.3,1); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
.wn-root[data-open="1"] .wn-backdrop { opacity: 1; } .wn-root[data-open="1"] .wn-panel { transform: none; }
@media (prefers-reduced-motion: reduce) { .wn-backdrop, .wn-panel { transition: none; } }
.wn-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border, rgba(11,11,11,.1)); }
.wn-head h2 { margin: 0; font-size: 16px; font-weight: 600; flex: 1; } .wn-head .wn-sub { font-size: 12px; color: var(--text-muted, #898781); font-weight: 400; margin-left: 6px; }
.wn-close { width: 36px; height: 36px; border-radius: 10px; border: 0; background: none; color: var(--text-secondary, #52514e); cursor: pointer; font-size: 22px; line-height: 1; }
.wn-close:hover { background: var(--hover-wash, rgba(11,11,11,.04)); }
.wn-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 12px 12px 20px; display: flex; flex-direction: column; gap: 10px; }
.wn-day { font-size: 12px; font-weight: 600; color: var(--text-secondary, #52514e); margin: 8px 4px 0; }
.wn-card { background: var(--surface-1, #fff); border: 1px solid var(--border, rgba(11,11,11,.1)); border-radius: 10px; padding: 12px 14px 10px; scroll-margin: 12px; }
.wn-card.wn-target { border-color: var(--series-1, #2a78d6); box-shadow: 0 0 0 1px var(--series-1, #2a78d6); }
.wn-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 12px; color: var(--text-muted, #898781); }
.wn-kind { font-weight: 600; font-size: 11px; color: var(--text-secondary, #52514e); text-transform: uppercase; letter-spacing: .04em; }
.wn-new { width: 8px; height: 8px; border-radius: 50%; background: var(--series-1, #2a78d6); align-self: center; flex: none; }
.wn-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; font-size: 13.5px; }
.wn-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: var(--hover-wash, rgba(11,11,11,.04)); border-radius: 4px; padding: 1px 4px; }
.wn-body code.wn-block { display: block; padding: 8px 10px; margin: 4px 0; overflow-x: auto; white-space: pre; }
.wn-body a, .wn-foot a { color: var(--series-1, #2a78d6); }
.wn-foot { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 8px; font-size: 12px; color: var(--text-muted, #898781); }
.wn-delivery { display: inline-flex; align-items: center; gap: 6px; } .wn-delivery::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--grid, #e1e0d9); }
.wn-delivery[data-status="sent"]::before { background: var(--status-good, #0ca30c); }
.wn-delivery[data-status="failed"] { color: var(--status-bad, #d03b3b); } .wn-delivery[data-status="failed"]::before { background: var(--status-bad, #d03b3b); }
.wn-empty, .wn-err { text-align: center; color: var(--text-muted, #898781); padding: 40px 16px; font-size: 13px; } .wn-err { color: var(--status-bad, #d03b3b); }
.wn-more { align-self: center; font: inherit; font-size: 13px; color: var(--text-secondary, #52514e); background: var(--surface-1, #fff); border: 1px solid var(--border, rgba(11,11,11,.1)); border-radius: 8px; padding: 6px 12px; cursor: pointer; margin-top: 4px; }
html.wn-lock, html.wn-lock body { overflow: hidden; }
`;

  /* ---- the bell ---- */
  const badge = el("span", { class: "wn-badge", hidden: "" });
  const bell = el("button", { class: "wn-bell", type: "button", "aria-haspopup": "dialog", "aria-controls": "wn-panel", "aria-expanded": "false", title: "Notifications" },
    svg(["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"]), badge);

  function setUnread(n) {
    state.unread = n;
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
    bell.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
  }

  /* ---- the panel ---- */
  const list = el("div", { class: "wn-list" });
  const sub = el("span", { class: "wn-sub" });
  const close = el("button", { class: "wn-close", type: "button", "aria-label": "Close notifications", text: "×" });
  const panel = el("aside", { class: "wn-panel", id: "wn-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "wn-title" },
    el("div", { class: "wn-head" }, el("h2", { id: "wn-title" }, "Notifications", sub), close), list);
  const backdrop = el("div", { class: "wn-backdrop" });
  const root = el("div", { class: "wn-root", hidden: "" }, backdrop, panel);

  /* Spans are the message. A multi-line code span is a block, which already breaks the line. */
  function renderSpans(input) {
    const spans = input.map((s) => ({ ...s }));
    spans.forEach((s, i) => {
      if (!s.code || !s.text.includes("\n")) return;
      if (spans[i - 1]?.text.endsWith("\n")) spans[i - 1].text = spans[i - 1].text.slice(0, -1);
      if (spans[i + 1]?.text.startsWith("\n")) spans[i + 1].text = spans[i + 1].text.slice(1);
    });
    const frag = document.createDocumentFragment();
    for (const s of spans) {
      let node = document.createTextNode(s.text);
      const wrap = (tag, attrs) => { const w = el(tag, attrs); w.append(node); node = w; };
      if (s.code) wrap("code", s.text.includes("\n") ? { class: "wn-block" } : {});
      if (s.bold) wrap("strong");
      if (s.italic) wrap("em");
      if (s.underline) wrap("u");
      if (s.strike) wrap("s");
      if (s.href && /^https?:\/\//i.test(s.href)) wrap("a", { href: s.href, target: "_blank", rel: "noopener noreferrer" });
      frag.append(node);
    }
    return frag;
  }

  const when = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const dayOf = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const channel = (c) => (c === "telegram" ? "Telegram" : c);

  function card(n) {
    const isNew = state.seenBefore === undefined || n.id < state.seenBefore;
    const deliveries = n.deliveries.length
      ? n.deliveries.map((d) => el("span", { class: "wn-delivery", "data-status": d.status, title: d.error ?? "",
          text: d.status === "sent" ? `Sent to ${channel(d.channel)}` : `${channel(d.channel)} failed${d.error ? `: ${d.error}` : ""}` }))
      : [el("span", { class: "wn-delivery", text: "Not delivered" })];
    const here = n.link === location.pathname;
    const link = el("a", { href: n.link, text: `${LINK[n.link] ?? "Open"} →` });
    if (here) link.addEventListener("click", (e) => { e.preventDefault(); hide(); });
    return el("article", { class: n.id === state.target ? "wn-card wn-target" : "wn-card", id: `wn-${n.id}`, "aria-label": `${isNew ? "New. " : ""}${KIND[n.kind] ?? n.kind}: ${n.title}` },
      el("div", { class: "wn-meta" }, isNew ? el("span", { class: "wn-new", title: "New" }) : null, el("span", { class: "wn-kind", text: KIND[n.kind] ?? n.kind }), el("time", { datetime: n.createdAt, text: when(n.createdAt) })),
      el("div", { class: "wn-body" }, renderSpans(n.spans)),
      el("div", { class: "wn-foot" }, ...deliveries, here ? null : link));
  }

  function render() {
    const nodes = [];
    let day = "";
    for (const n of state.items) {
      const d = dayOf(n.createdAt);
      if (d !== day) { day = d; nodes.push(el("h3", { class: "wn-day", text: d })); }
      nodes.push(card(n));
    }
    if (!state.items.length) nodes.push(el("div", { class: "wn-empty", text: "Nothing yet. Every summary, check-in, milestone and alert the app sends appears here." }));
    if (state.next) {
      const more = el("button", { class: "wn-more", type: "button", text: "Load older" });
      more.addEventListener("click", async () => { more.disabled = true; await fetchPage(); render(); });
      nodes.push(more);
    }
    list.replaceChildren(...nodes);
    const fresh = state.items.filter((n) => state.seenBefore === undefined || n.id < state.seenBefore).length;
    sub.textContent = fresh ? `${fresh} new` : "";
  }

  async function api(path, init = {}) {
    const k = key();
    if (!k) return null;
    const r = await fetch(path, { ...init, headers: { "x-api-key": k, ...(init.body ? { "content-type": "application/json" } : {}) } });
    if (r.status === 401) return null;
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  async function refreshCount() {
    try { const data = await api("/api/notifications?limit=0"); setUnread(data ? data.unread : 0); }
    catch { /* the badge is a convenience; a failed poll leaves it as it was */ }
  }

  async function fetchPage() {
    const q = new URLSearchParams({ limit: String(PAGE), ...(state.next ? { after: state.next } : {}) });
    const data = await api(`/api/notifications?${q}`);
    if (!data) return false;
    if (!state.items.length) state.seenBefore = data.readThrough;
    state.items.push(...data.notifications);
    state.next = data.next;
    return true;
  }

  async function show(targetId = "") {
    if (state.open) return;
    state.open = true; state.target = targetId; state.items = []; state.next = undefined; state.seenBefore = undefined;
    state.returnFocus = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add("wn-lock");
    bell.setAttribute("aria-expanded", "true");
    list.replaceChildren(el("div", { class: "wn-empty", text: "Loading…" }));
    requestAnimationFrame(() => { root.dataset.open = "1"; close.focus(); });
    try {
      if (!(await fetchPage())) { list.replaceChildren(el("div", { class: "wn-err", text: "Enter your key on the page first." })); return; }
      // A deep link to an older message pages back until it is loaded.
      for (let i = 0; targetId && i < 10 && state.next && !state.items.some((n) => n.id === targetId); i++) await fetchPage();
      render();
      if (targetId) document.getElementById(`wn-${targetId}`)?.scrollIntoView({ block: "start" });
      const newest = state.items[0]?.id;
      if (newest && (state.seenBefore === undefined || newest < state.seenBefore)) {
        const result = await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ through: newest }) });
        setUnread(result ? result.unread : 0);
      }
    } catch (e) {
      list.replaceChildren(el("div", { class: "wn-err", text: `Could not load notifications: ${e.message}` }));
    }
  }

  function hide() {
    if (!state.open) return;
    state.open = false;
    delete root.dataset.open;
    bell.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("wn-lock");
    const done = () => { if (!state.open) root.hidden = true; };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) done(); else setTimeout(done, 220);
    (state.returnFocus && document.contains(state.returnFocus) ? state.returnFocus : bell).focus?.();
  }

  bell.addEventListener("click", () => (state.open ? hide() : show()));
  close.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); hide(); return; }
    if (e.key !== "Tab") return;
    // Keep focus inside the panel while it is modal.
    const focusable = [...panel.querySelectorAll("button, a[href]")].filter((x) => !x.disabled);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  function mount() {
    const header = document.querySelector("header");
    if (!header || header.querySelector(".wn-bell")) return;
    document.head.append(el("style", { text: css }));
    header.prepend(bell);
    document.body.append(root);
    refreshCount();
    const params = new URLSearchParams(location.search);
    if (params.has("notifications") || params.has("notification")) {
      const target = params.get("notification") ?? "";
      params.delete("notifications"); params.delete("notification");
      history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
      if (key()) show(target);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  // Pages announce themselves once loaded (and on sign-out); the key may have just been entered.
  document.addEventListener("workout-app-ready", refreshCount);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshCount(); });
  setInterval(() => { if (document.visibilityState === "visible" && !state.open) refreshCount(); }, 5 * 60_000);
  window.workoutNotifications = { open: show, close: hide, refresh: refreshCount };
})();
