#!/usr/bin/env node
/**
 * Burned-in captions — one transparent PNG per narration line.
 *
 * This ffmpeg has no `subtitles`, no `ass` and no `drawtext` (built without
 * libass and libfreetype), so the usual one-liner is not available. Text is
 * laid out in Chrome instead — real typeface, real wrapping — captured on a
 * transparent background, and `overlay` composites it onto the beat it belongs
 * to. cut.mjs already builds one segment per line, so each caption only has to
 * sit over its own segment; no timing table, nothing to drift out of sync.
 *
 *   node demo/subs.mjs   ->  demo/work/subs/<id>.png
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "work", "subs");
const W = 1280, H = 260, PORT = 9366;   // H is generous; the box is measured after layout
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** White text on a black box — small, centred, two or three lines at most. */
/**
 * Long lines get a smaller face and a wider box.
 *
 * At one size the longest narration line rendered five lines tall — 218px on a
 * 712px frame, which would have sat over the bottom third of the very slide it
 * describes. Scale with the text so no caption swallows the picture.
 */
const sizeFor = (t) => (t.length > 240 ? 16 : t.length > 170 ? 17 : 18);
// A long line in a narrow box just gets taller. Widen it instead, so the extra
// text buys columns rather than rows.
const widthFor = (t) => (t.length > 240 ? 1020 : t.length > 170 ? 940 : 860);

const page = (text) => `<style>
  html,body{margin:0;padding:0;background:transparent}
  #wrap{width:${W}px;display:flex;justify-content:center;align-items:flex-start}
  #cap{
    max-width:${widthFor(text)}px;
    background:rgba(0,0,0,.82);
    color:#fff;
    font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;
    font-size:${sizeFor(text)}px; line-height:1.34; font-weight:500;
    padding:7px 14px; border-radius:6px;
    text-align:center; letter-spacing:.005em;
    text-wrap:balance;
  }
</style>
<div id="wrap"><div id="cap">${esc(text)}</div></div>`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const lines = JSON.parse(await readFile(path.join(HERE, "narration.json"), "utf8")).lines;

  const profile = path.join(HERE, "work", "subs-profile");
  await rm(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new",
    `--window-size=${W},${H}`, "--hide-scrollbars", "--no-first-run",
    "--force-device-scale-factor=1", "about:blank",
  ], { stdio: "ignore" });

  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(500);
  }
  if (!target) throw new Error("SUBS_NO_CDP");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send("Page.enable");
  // Transparent, so only the caption box lands on the frame.
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

  for (const l of lines) {
    await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(page(l.text)) });
    await sleep(260);
    // Measure the laid-out box so the PNG is exactly the caption, no padding to
    // position around later.
    const box = await send("Runtime.evaluate", {
      expression: `(() => { const r = document.getElementById("cap").getBoundingClientRect();
        return JSON.stringify({x:Math.floor(r.x),y:Math.floor(r.y),w:Math.ceil(r.width),h:Math.ceil(r.height)}); })()`,
      returnByValue: true,
    });
    const b = JSON.parse(box.result.value);
    const shot = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true,
      clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
    });
    await writeFile(path.join(OUT, `${l.id}.png`), Buffer.from(shot.data, "base64"));
  }

  console.log(`captions: ${lines.length} PNGs -> ${OUT}`);
  ws.close(); chrome.kill();
}

main().catch((e) => { console.error("SUBS FAILED:", e.message); process.exit(1); });
