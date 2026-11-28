(() => {
  "use strict";
  const button = document.getElementById("app-force-refresh");
  const status = document.getElementById("app-refresh-status");
  let refreshing = false, version, checking;

  async function refreshApp() {
    if (refreshing) return;
    refreshing = true; button.disabled = true; button.textContent = "Refreshing…"; status.hidden = true;
    try {
      const url = new URL(location.href);
      url.searchParams.delete("key");
      url.searchParams.set("_refresh", String(Date.now()));
      // Verify connectivity before clearing app caches or navigating away.
      const response = await fetch(url, { cache: "reload", credentials: "same-origin" });
      if (!response.ok) throw new Error("Refresh unavailable");
      const cleanup = [];
      if ("caches" in window) cleanup.push(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("workout-tracker-")).map((key) => caches.delete(key)))));
      if ("serviceWorker" in navigator) cleanup.push(navigator.serviceWorker.getRegistrations().then((entries) => Promise.all(entries.filter((entry) => {
        const worker = entry.active || entry.waiting || entry.installing;
        return worker && new URL(worker.scriptURL).pathname.startsWith("/api/app-assets/");
      }).map((entry) => entry.unregister()))));
      await Promise.allSettled(cleanup);
      // Keep localStorage: the API key and theme are preferences, not cached app files.
      location.replace(url.href);
    } catch {
      refreshing = false; button.disabled = false; button.textContent = "↻ Refresh app";
      status.textContent = "Could not refresh. Check your connection and try again."; status.hidden = false;
    }
  }
  button.onclick = null;
  button.addEventListener("click", refreshApp);
  async function checkVersion() {
    if (checking || refreshing || document.visibilityState === "hidden") return;
    checking = true;
    try {
      const response = await fetch("/api/app-assets/app-version.json", { cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()).version;
      if (typeof next !== "string") return;
      if (version && version !== next) {
        // Do not interrupt an open editor or a key being entered.
        if (document.querySelector("dialog[open]") || (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "") && document.activeElement.getClientRects().length > 0)) {
          button.textContent = "↻ Update available";
        } else await refreshApp();
      } else version = next;
    } catch { /* Offline reopening keeps the current page and its refresh control. */ }
    finally { checking = false; }
  }
  checkVersion();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkVersion(); });
  addEventListener("pageshow", (event) => { if (event.persisted) checkVersion(); });
  addEventListener("online", checkVersion);
  const url = new URL(location.href);
  if (url.searchParams.has("_refresh")) { url.searchParams.delete("_refresh"); history.replaceState(null, "", url.pathname + url.search + url.hash); }
})();
