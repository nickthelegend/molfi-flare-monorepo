#!/usr/bin/env node
/**
 * Animated intro / outro, rendered frame by frame in Chrome.
 *
 * The previous version screenshotted ONE still and let ffmpeg zoompan across
 * it. That is a camera move over a static image — the type never actually does
 * anything, which is exactly what it looked like. Here the card animates in the
 * browser (staggered word rise, a rule that draws itself, a glow that blooms)
 * and we capture each frame, so the motion is real and CSS does the easing.
 *
 * Deterministic on purpose: nothing is driven by wall-clock. Every frame sets
 * `t` explicitly and re-renders, so the same run always produces the same
 * frames — and no frame can be missed because the machine was busy.
 *
 *   node demo/cards.mjs
 */
import { spawn, execFile } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, "work");
const W = 1280, H = 712, FPS = 24, PORT = 9333;
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One self-contained card whose entire appearance is a function of `t`.
 *
 * Easing is written out rather than pulled from a library: `outCubic` for
 * entrances so things decelerate into place, `inCubic` for the exit so the card
 * leaves with intent instead of dissolving.
 */
const card = (title, sub, foot, accent) => `
<style>
  /* Paint the page, not just the card. The stage is scaled and faded, so any
     pixel it stops covering shows whatever is behind it — and the default is
     white, which lands as a bright band along the bottom of the video. */
  html,body{margin:0;padding:0;background:#07090f;overflow:hidden}
</style>
<div id="stage" style="width:${W}px;height:${H}px;background:#07090f;overflow:hidden;position:relative;
     font-family:Futura,'Avenir Next',Helvetica Neue,sans-serif;color:#fff">
  <div id="glow" style="position:absolute;inset:0"></div>
  <div id="grid" style="position:absolute;inset:0;opacity:.10;
       background-image:linear-gradient(#ffffff14 1px,transparent 1px),linear-gradient(90deg,#ffffff14 1px,transparent 1px);
       background-size:64px 64px"></div>
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
    <div id="title" style="display:flex;gap:.28em;font-weight:600;letter-spacing:-.02em;
         font-size:${title.length > 12 ? 74 : 124}px;white-space:nowrap"></div>
    <div id="rule" style="height:3px;background:${accent};margin:26px 0 22px;border-radius:2px;width:0"></div>
    <div id="sub" style="font-size:30px;color:${accent}"></div>
    <div id="foot" style="font-size:21px;color:#ffffff80;margin-top:26px"></div>
  </div>
</div>
<script>
  const TITLE = ${JSON.stringify(title)}, SUB = ${JSON.stringify(sub)}, FOOT = ${JSON.stringify(foot)};
  const stage = document.getElementById("stage");
  const titleEl = document.getElementById("title");
  titleEl.innerHTML = TITLE.split("").map((c) =>
    '<span style="display:inline-block;white-space:pre">' + (c === " " ? "&nbsp;" : c) + "</span>").join("");
  const chars = [...titleEl.children];
  document.getElementById("sub").textContent = SUB;
  document.getElementById("foot").textContent = FOOT;

  const clamp = (v) => Math.max(0, Math.min(1, v));
  const outCubic = (p) => 1 - Math.pow(1 - clamp(p), 3);
  const inCubic = (p) => Math.pow(clamp(p), 3);

  // Every element's state at time t. Exposed so the capture loop can step it.
  window.renderAt = (t, dur, dir) => {
    // Letters rise and fade in one after another, 40ms apart.
    chars.forEach((el, i) => {
      const p = outCubic((t - 0.15 - i * 0.04) / 0.75);
      el.style.opacity = p;
      el.style.transform = "translateY(" + ((1 - p) * 34).toFixed(2) + "px)";
      el.style.filter = "blur(" + ((1 - p) * 7).toFixed(2) + "px)";
    });
    const stagger = 0.15 + chars.length * 0.04;
    // The rule draws itself outward once the word has landed.
    const rp = outCubic((t - stagger - 0.1) / 0.7);
    document.getElementById("rule").style.width = (rp * 440).toFixed(1) + "px";
    // Sub and footer follow, each a beat later.
    const sp = outCubic((t - stagger - 0.35) / 0.6);
    const sub = document.getElementById("sub");
    sub.style.opacity = sp;
    sub.style.transform = "translateY(" + ((1 - sp) * 16).toFixed(2) + "px)";
    const fp = outCubic((t - stagger - 0.6) / 0.6);
    const foot = document.getElementById("foot");
    foot.style.opacity = fp;
    foot.style.transform = "translateY(" + ((1 - fp) * 14).toFixed(2) + "px)";
    // The glow blooms behind the type and keeps drifting, so the frame is never
    // completely still even after the text has settled.
    const g = outCubic(t / 1.4);
    const drift = Math.sin(t * 0.8) * 14;
    document.getElementById("glow").style.background =
      "radial-gradient(" + (760 + g * 220).toFixed(0) + "px " + (360 + g * 120).toFixed(0) + "px at 50% " +
      (44 + drift * 0.1).toFixed(2) + "%, rgba(139,92,246," + (0.05 + g * 0.17).toFixed(3) + "), transparent 70%)";
    // A slow parallax on the grid: motion you feel rather than notice.
    document.getElementById("grid").style.transform =
      "translate(" + (t * 7).toFixed(2) + "px," + (-t * 4).toFixed(2) + "px)";
    // No whole-card scale. A push on the entire frame is a camera move, and it
    // reads as exactly that — "it just zooms out" — no matter how much the type
    // underneath is doing. The motion lives in the elements instead.
    //
    // A light sweep crosses the wordmark once the letters have landed, so the
    // card keeps moving through the middle of its run rather than freezing.
    const sweep = clamp((t - 1.9) / 1.5);
    titleEl.style.backgroundImage =
      "linear-gradient(100deg, #fff 0%, #fff " + (sweep * 100 - 18).toFixed(1) + "%, " +
      "#ffffff " + (sweep * 100 - 6).toFixed(1) + "%, #cbb8ff " + (sweep * 100).toFixed(1) + "%, " +
      "#fff " + (sweep * 100 + 12).toFixed(1) + "%, #fff 100%)";
    titleEl.style.webkitBackgroundClip = "text";
    titleEl.style.backgroundClip = "text";
    titleEl.style.color = sweep > 0 && sweep < 1 ? "transparent" : "#fff";
    // Letters lift away one by one on the way out, mirroring the entrance.
    if (t > dur - 0.9) {
      chars.forEach((el, i) => {
        const q = clamp((t - (dur - 0.9) - i * 0.012) / 0.5);
        el.style.opacity = String(1 - q);
        el.style.transform = "translateY(" + (-q * 22).toFixed(2) + "px)";
      });
    }
    const fadeIn = clamp(t / 0.45);
    const fadeOut = 1 - inCubic((t - (dur - 0.5)) / 0.5);
    stage.style.opacity = Math.min(fadeIn, fadeOut).toFixed(3);
  };
</script>`;

async function main() {
  await mkdir(WORK, { recursive: true });
  const profile = path.join(WORK, "card-profile");
  await rm(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new",
    `--window-size=${W},${H}`, "--hide-scrollbars", "--no-first-run", "--force-device-scale-factor=1",
    "about:blank",
  ], { stdio: "ignore" });

  let page;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch {}
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("CARDS_NO_CDP");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send("Page.enable");

  const CARDS = [
    { name: "intro", dur: 5.0, dir: "in",
      html: card("MOLFI", "XRP-settled prediction markets on Flare",
                 "Coston2 · FXRP · FTSOv2 · Confidential Compute", "#b9a6ff") },
    { name: "outro", dur: 5.0, dir: "out",
      html: card("Thanks for watching", "molfi.fun",
                 "Every transaction is on the Coston2 explorer", "#b9a6ff") },
  ];

  for (const c of CARDS) {
    const frames = path.join(WORK, `frames-${c.name}`);
    await rm(frames, { recursive: true, force: true });
    await mkdir(frames, { recursive: true });

    await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(c.html) });
    await sleep(1400);

    const total = Math.round(c.dur * FPS);
    for (let f = 0; f < total; f++) {
      const t = f / FPS;
      await send("Runtime.evaluate", { expression: `window.renderAt(${t}, ${c.dur}, ${JSON.stringify(c.dir)})` });
      const shot = await send("Page.captureScreenshot", {
        format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
      });
      await writeFile(path.join(frames, `f${String(f).padStart(4, "0")}.png`), Buffer.from(shot.data, "base64"));
    }

    const out = path.join(WORK, `${c.name}.mp4`);
    await pexec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-framerate", String(FPS), "-i", path.join(frames, "f%04d.png"),
      "-f", "lavfi", "-t", String(c.dur), "-i", "anullsrc=r=48000:cl=stereo",
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", out]);
    await rm(frames, { recursive: true, force: true });
    console.log(`card ${c.name}.mp4 — ${total} rendered frames, ${c.dur}s`);
  }

  ws.close();
  chrome.kill();
}

main().catch((e) => { console.error("CARDS FAILED:", e.message); process.exit(1); });
