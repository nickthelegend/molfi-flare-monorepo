#!/usr/bin/env node
/**
 * Burned-in captions — ONE line on screen at a time.
 *
 * This ffmpeg has no `subtitles`, no `ass` and no `drawtext` (built without
 * libass and libfreetype), so the usual one-liner is not available. Text is
 * laid out in Chrome instead — real typeface, real metrics — captured on a
 * transparent background, and `overlay` composites it.
 *
 * A whole narration line rendered as one block sat two and three rows deep over
 * the UI it was describing. So each line is split into single-row chunks at
 * word boundaries, one PNG each, and cut.mjs shows them in turn across the
 * beat — weighted by character count, which tracks speech closely enough that
 * nothing lands early or lingers.
 *
 *   node demo/subs.mjs   ->  demo/work/subs/<id>-<n>.png + manifest.json
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "work", "subs");
const W = 1280, H = 200, PORT = 9366;
const FONT = 18;
const MAX_CHARS = 58;          // one comfortable row at FONT px
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/**
 * Split into rows of at most MAX_CHARS, never mid-word.
 *
 * Prefers to end a chunk on punctuation when one falls near the limit, so a
 * break lands where a reader would pause anyway rather than mid-clause.
 */
function chunk(text) {
  const words = text.split(/\s+/);
  const out = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > MAX_CHARS && cur) { out.push(cur); cur = w; }
    else cur = next;
    if (cur.length >= MAX_CHARS - 14 && /[—,.:;]$/.test(cur)) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}

const page = (line) => `<style>
  html,body{margin:0;padding:0;background:transparent}
  #wrap{width:${W}px;display:flex;justify-content:center;align-items:flex-start}
  #cap{
    background:rgba(0,0,0,.82); color:#fff;
    font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;
    font-size:${FONT}px; line-height:1.3; font-weight:500;
    padding:6px 14px; border-radius:6px;
    white-space:nowrap;              /* one row, always */
    letter-spacing:.005em;
  }
</style>
<div id="wrap"><div id="cap">${esc(line)}</div></div>`;

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
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

  const manifest = {};
  let total = 0, tallest = 0, widest = 0;
  for (const l of lines) {
    const parts = chunk(l.text);
    manifest[l.id] = [];
    for (const [i, part] of parts.entries()) {
      await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(page(part)) });
      await sleep(180);
      const box = await send("Runtime.evaluate", {
        expression: `(() => { const r = document.getElementById("cap").getBoundingClientRect();
          return JSON.stringify({x:Math.floor(r.x),y:Math.floor(r.y),w:Math.ceil(r.width),h:Math.ceil(r.height)}); })()`,
        returnByValue: true,
      });
      const b = JSON.parse(box.result.value);
      tallest = Math.max(tallest, b.h);
      widest = Math.max(widest, b.w);
      const file = `${l.id}-${i}.png`;
      const shot = await send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: true,
        clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
      });
      await writeFile(path.join(OUT, file), Buffer.from(shot.data, "base64"));
      manifest[l.id].push({ file, chars: part.length });
      total++;
    }
  }

  await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`captions: ${total} single-row PNGs across ${lines.length} lines — tallest ${tallest}px, widest ${widest}px`);
  ws.close(); chrome.kill();
}

main().catch((e) => { console.error("SUBS FAILED:", e.message); process.exit(1); });
