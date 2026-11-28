/*
 * Page navigation and the dark-mode switch, shared by every page's header.
 *
 * Wide screens: the pages sit inline as one segmented control, the current one marked.
 * Narrow screens (≤ 860px): the same links fold into a hamburger menu that drops down
 * under the header. Header controls marked `data-nav-menu` (the dashboard's "Forget key")
 * travel with the links, so they live in the menu on a phone and inline on a laptop. The
 * "Refresh app" button (app-shell.js) joins them; until this script mounts it floats in
 * the corner, so a page whose navigation fails to load can still be refreshed.
 *
 * The switch flips `data-theme` on <html> and stores the choice under the same key the
 * pages already read at start-up. Pages that draw colours in script (the map) listen for
 * `workout-theme-change` on document to repaint. aria-checked follows the effective theme,
 * including the system preference while nothing is stored.
 */
(() => {
  "use strict";
  const THEME_STORAGE = "workout-tracker.theme";
  const PAGES = [
    { href: "/api/dashboard", label: "Dashboard", also: ["/"] },
    { href: "/api/history", label: "Workouts" },
    { href: "/api/strength", label: "Strength" },
    { href: "/api/recovery", label: "Recovery" },
    { href: "/api/map", label: "Routes" },
  ];
  const NARROW = "(max-width: 860px)";

  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v); }
    for (const c of children) if (c !== null && c !== undefined) e.append(c);
    return e;
  };
  const svg = (paths, extra = {}) => {
    const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", ...extra })) s.setAttribute(k, v);
    for (const d of paths) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.append(p); }
    return s;
  };
  const SUN = ["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8", "M12 2v2", "M12 20v2", "M4.93 4.93l1.41 1.41", "M17.66 17.66l1.41 1.41", "M2 12h2", "M20 12h2", "M6.34 17.66l-1.41 1.41", "M19.07 4.93l-1.41 1.41"];
  const MOON = ["M12 3a6 6 0 0 0 9 9a9 9 0 1 1-9-9"];

  /* ---- styles: page variables with fallbacks, like the notifications bell ---- */
  const css = `
header { position: relative; }
.an-menu { order: 1; display: flex; align-items: center; gap: 10px; align-self: center; }
.an-links { display: flex; gap: 2px; background: var(--surface-1, #fff); border: 1px solid var(--border, rgba(11,11,11,.1)); border-radius: 10px; padding: 2px; }
.an-links a { font-size: 13px; color: var(--text-secondary, #52514e); text-decoration: none; border-radius: 8px; padding: 6px 11px; white-space: nowrap; }
.an-links a:hover { background: var(--hover-wash, rgba(11,11,11,.04)); color: var(--text-primary, #0b0b0b); }
.an-links a[aria-current="page"] { background: var(--series-1, #2a78d6); color: #fff; }
.an-extra { display: flex; align-items: center; gap: 8px; }
.an-extra:empty { display: none; }
/* Inline (wide) the label would push the theme switch onto a second row: show only the
   arrow there; the text stays the accessible name and returns in the narrow menu. */
.an-extra > .an-refresh { font: inherit; font-size: 0; color: var(--text-secondary, #52514e); cursor: pointer; white-space: nowrap;
  width: 32px; height: 32px; padding: 0; border-radius: 50%; background: var(--surface-1, #fff); border: 1px solid var(--border, rgba(11,11,11,.1)); }
.an-extra > .an-refresh::before { content: "↻"; font-size: 16px; }
.an-extra > .an-refresh:hover { background: var(--hover-wash, rgba(11,11,11,.04)); color: var(--text-primary, #0b0b0b); }
.an-extra > .an-refresh:disabled { opacity: .7; cursor: wait; }
.an-theme { order: 2; align-self: center; flex: none; position: relative; width: 56px; height: 32px; padding: 0; border-radius: 16px; cursor: pointer;
  border: 1px solid var(--border, rgba(11,11,11,.1)); background: var(--surface-1, #fff); color: var(--text-muted, #898781); }
.an-theme .an-track { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; }
.an-theme .an-track svg { width: 14px; height: 14px; }
.an-theme .an-knob { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--text-primary, #0b0b0b); color: var(--page, #f9f9f7); transition: transform 160ms cubic-bezier(.2,.7,.3,1); }
.an-theme .an-knob svg { width: 14px; height: 14px; }
.an-theme[aria-checked="true"] .an-knob { transform: translateX(24px); }
.an-theme:hover { background: var(--hover-wash, rgba(11,11,11,.04)); }
.an-burger { order: 3; display: none; align-self: center; flex: none; width: 36px; height: 36px; padding: 0; border-radius: 10px; cursor: pointer; align-items: center; justify-content: center;
  border: 1px solid var(--border, rgba(11,11,11,.1)); background: var(--surface-1, #fff); color: var(--text-secondary, #52514e); }
.an-burger:hover { background: var(--hover-wash, rgba(11,11,11,.04)); color: var(--text-primary, #0b0b0b); }
.an-links a:focus-visible, .an-theme:focus-visible, .an-burger:focus-visible { outline: 2px solid var(--series-1, #2a78d6); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .an-theme .an-knob { transition: none; } }
@media ${NARROW} {
  .an-burger { display: inline-flex; }
  /* Title, bell and controls on one row; the page's subtitle drops beneath it. */
  header > .subtitle { order: 4; flex-basis: 100%; }
  .an-menu { position: absolute; z-index: 1000; top: calc(100% + 6px); right: 0; width: min(280px, calc(100vw - 32px)); box-sizing: border-box;
    flex-direction: column; align-items: stretch; gap: 0; padding: 6px; border-radius: 12px;
    background: var(--surface-1, #fff); border: 1px solid var(--border, rgba(11,11,11,.1)); box-shadow: 0 12px 32px rgba(0,0,0,.18); }
  .an-menu:not([data-open]) { display: none; }
  .an-links { flex-direction: column; border: 0; padding: 0; background: none; gap: 2px; }
  .an-links a { font-size: 15px; padding: 11px 12px; }
  .an-extra { flex-direction: column; align-items: stretch; border-top: 1px solid var(--border, rgba(11,11,11,.1)); margin-top: 6px; padding-top: 6px; }
  .an-extra > *, .an-extra > .an-refresh { text-align: left; font-size: 15px; padding: 11px 12px; border: 0; background: none; border-radius: 8px; }
  .an-extra > .an-refresh { width: auto; height: auto; color: inherit; }
  .an-extra > .an-refresh::before { content: none; }
}
`;

  /* ---- theme ---- */
  const root = document.documentElement;
  const prefersDark = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => { const t = root.getAttribute("data-theme"); return t ? t === "dark" : prefersDark.matches; };
  const store = (value) => { try { localStorage.setItem(THEME_STORAGE, value); } catch { /* private mode */ } };
  try { const t = localStorage.getItem(THEME_STORAGE); if (t) root.setAttribute("data-theme", t); } catch { /* private mode */ }

  const theme = el("button", { class: "an-theme", type: "button", role: "switch", "aria-label": "Dark mode", title: "Dark mode" },
    el("span", { class: "an-track" }, svg(SUN), svg(MOON)),
    el("span", { class: "an-knob" }));
  function syncTheme() {
    const dark = isDark();
    theme.setAttribute("aria-checked", String(dark));
    theme.querySelector(".an-knob").replaceChildren(svg(dark ? MOON : SUN));
  }
  theme.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store(next);
    document.dispatchEvent(new CustomEvent("workout-theme-change", { detail: { theme: next } }));
  });
  // Pages also set data-theme at start-up; follow the attribute rather than the click.
  new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  prefersDark.addEventListener("change", syncTheme);

  /* ---- navigation ---- */
  const here = location.pathname.replace(/\/+$/, "") || "/";
  const links = el("nav", { class: "an-links", "aria-label": "Pages" },
    ...PAGES.map((p) => {
      const a = el("a", { href: p.href, text: p.label });
      if (p.href === here || p.also?.includes(here)) a.setAttribute("aria-current", "page");
      return a;
    }));
  const extra = el("div", { class: "an-extra" });
  const menu = el("div", { class: "an-menu", id: "an-menu" }, links, extra);
  const burger = el("button", { class: "an-burger", type: "button", "aria-controls": "an-menu", "aria-expanded": "false", "aria-label": "Menu", title: "Menu" },
    svg(["M4 6h16", "M4 12h16", "M4 18h16"]));

  const narrow = matchMedia(NARROW);
  function setOpen(open, { focus = false } = {}) {
    if (open) menu.setAttribute("data-open", ""); else menu.removeAttribute("data-open");
    burger.setAttribute("aria-expanded", String(open));
    burger.replaceChildren(svg(open ? ["M6 6l12 12", "M18 6L6 18"] : ["M4 6h16", "M4 12h16", "M4 18h16"]));
    if (open && focus) (links.querySelector('[aria-current="page"]') ?? links.querySelector("a"))?.focus();
  }
  const isOpen = () => menu.hasAttribute("data-open");
  burger.addEventListener("click", () => setOpen(!isOpen(), { focus: true }));
  menu.addEventListener("click", (e) => { if (narrow.matches && e.target.closest("a, button")) setOpen(false); });
  // composedPath, not contains: the burger swaps its icon on click, detaching the target.
  document.addEventListener("click", (e) => { const path = e.composedPath(); if (isOpen() && !path.includes(menu) && !path.includes(burger)) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) { setOpen(false); burger.focus(); } });
  narrow.addEventListener("change", () => setOpen(false));
  // A page restored from the back-forward cache must not come back with the menu open.
  addEventListener("pageshow", () => setOpen(false));

  function mount() {
    const header = document.querySelector("header");
    if (!header || header.querySelector(".an-menu")) return;
    document.head.append(el("style", { text: css }));
    for (const node of header.querySelectorAll("[data-nav-menu]")) extra.append(node);
    const refresh = document.getElementById("app-force-refresh");
    if (refresh) { refresh.classList.add("an-refresh"); refresh.title = "Refresh app: " + refresh.title; extra.append(refresh); }
    header.append(menu, theme, burger);
    syncTheme();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
})();
