#!/usr/bin/env node
/**
 * Screenshots a page of the app in headless Chromium and prints a few facts about it.
 * Used to *look at* a change rather than trust it — every rendering bug so far was caught
 * this way, not by tests.
 *
 *   node scripts/dev/screenshot.cjs <url> <out.png> [light|dark] [width] [clickSelector[;clickSelector…]]
 *
 * The page's key gate is filled from WORKOUT_KEY (the ingest API key); the preview server
 * accepts "preview". Needs `chromium` on PATH. Zero npm dependencies.
 *
 * Chromium does not fire `focus` on an SVG element focused programmatically; drive keyboard
 * checks with Input.dispatchKeyEvent (a real Tab) instead.
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");

const [, , url, out, theme = "light", width = "1180", clickSel] = process.argv;
if (!url || !out) { console.error("usage: screenshot.cjs <url> <out.png> [light|dark] [width] [clickSelector[;clickSelector…]]"); process.exit(1); }
const key = process.env.WORKOUT_KEY ?? "preview";
const W = Number(width);
const port = 9300 + Math.floor(Math.random() * 500);

const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${W},2200`, "about:blank"], { stdio: "ignore" });
const get = (p) => new Promise((res, rej) => { http.get({ host: "127.0.0.1", port, path: p }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let targets;
  for (let i = 0; i < 60; i++) { try { targets = await get("/json/list"); break; } catch { await sleep(250); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  const send = (method, params = {}) => new Promise((res) => { const m = ++id; pending.set(m, res); ws.send(JSON.stringify({ id: m, method, params })); });
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: 1400, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url }); await sleep(1200);
  await send("Runtime.evaluate", { expression: `const k=document.getElementById('gate-key'); if(k){k.value=${JSON.stringify(key)};document.getElementById('gate-go').click();}` });
  await sleep(url.includes("localhost") ? 1800 : 3500);
  // Several selectors separated by ";" are clicked in order (family, then range, …).
  for (const sel of (clickSel ?? "").split(";").map((x) => x.trim()).filter(Boolean)) { await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)}).click()` }); await sleep(1800); }
  const { result } = await send("Runtime.evaluate", { returnByValue: true, expression: `JSON.stringify({
    height: document.querySelector('.wrap')?.scrollHeight ?? document.body.scrollHeight,
    error: (()=>{const e=document.getElementById('error'); return e && !e.hidden ? e.textContent : null})(),
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    tiles: document.querySelectorAll('.tile').length, svgs: document.querySelectorAll('svg').length })` });
  const info = JSON.parse(result.value);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: Math.ceil(info.height) + 60, deviceScaleFactor: 2, mobile: false }); await sleep(400);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(JSON.stringify({ wrote: out, ...info, consoleErrors: errors }, null, 1));
  ws.close(); chrome.kill(); process.exit(info.error || errors.length ? 2 : 0);
})();
