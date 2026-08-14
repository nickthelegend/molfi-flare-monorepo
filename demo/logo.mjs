#!/usr/bin/env node
/**
 * BUIDL logo — 480x480 PNG, rendered from the app's own mark.
 *
 * Same glyph as molfi-app/public/molfi.svg so the submission tile and the
 * product are visibly the same thing, set on the app's near-black with the
 * purple bloom the UI uses.
 *
 *   node demo/logo.mjs   ->  demo/out/molfi-logo-480.png
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = 480, PORT = 9355;
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = `<style>html,body{margin:0;background:#07090f}</style>
<div style="width:${S}px;height:${S}px;background:#07090f;position:relative;display:flex;
     flex-direction:column;align-items:center;justify-content:center;gap:30px;overflow:hidden">
  <div style="position:absolute;inset:0;background:
       radial-gradient(360px 300px at 50% 40%, rgba(139,92,246,.30), transparent 70%)"></div>
  <div style="position:absolute;inset:0;opacity:.07;
       background-image:linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px);
       background-size:48px 48px"></div>
  <svg width="216" height="216" viewBox="0 0 32 32" style="position:relative;filter:drop-shadow(0 14px 40px rgba(109,74,255,.55))">
    <defs><linearGradient id="g" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
      <stop stop-color="#c899ff"/><stop offset="0.55" stop-color="#9a6bff"/><stop offset="1" stop-color="#6d4aff"/>
    </linearGradient></defs>
    <rect width="32" height="32" rx="9" fill="url(#g)"/>
    <path d="M8 23 L8 11 L16 18 L24 11 L24 23" fill="none" stroke="#fff" stroke-width="2.8"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="24" cy="11" r="2.2" fill="#fff"/>
  </svg>
  <div style="position:relative;font-family:Futura,'Avenir Next',Helvetica Neue,sans-serif;color:#fff;
       font-size:56px;font-weight:600;letter-spacing:-.02em;line-height:1">molfi</div>
</div>`;

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(HERE, "work", "logo-profile")}`, "--headless=new",
  `--window-size=${S},${S}`, "--hide-scrollbars", "--no-first-run",
  "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });

let page;
for (let i = 0; i < 40 && !page; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  } catch {}
  if (!page) await sleep(500);
}
if (!page) { console.error("LOGO_NO_CDP"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Page.enable");
await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
await sleep(1400);
const shot = await send("Page.captureScreenshot", {
  format: "png", clip: { x: 0, y: 0, width: S, height: S, scale: 1 },
});
await mkdir(path.join(HERE, "out"), { recursive: true });
const out = path.join(HERE, "out", "molfi-logo-480.png");
await writeFile(out, Buffer.from(shot.data, "base64"));
console.log(`logo -> ${out}`);
ws.close(); chrome.kill(); process.exit(0);
