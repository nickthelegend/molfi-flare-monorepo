#!/usr/bin/env node
/**
 * Phase 4 — record the app only, and log a mark the instant each beat starts.
 *
 * Chrome is launched at a geometry fixed by env, so the crop rect is known
 * before a frame is captured — ffmpeg crops DURING capture, never after. The
 * driver is injected over CDP and its console output is the beat log, so the
 * marks come from the same clock that paced the take.
 *
 *   DEMO_X=0 DEMO_Y=0 DEMO_W=1280 DEMO_H=800 node demo/record.mjs
 */
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "raw");

const APP = process.env.DEMO_URL ?? "http://127.0.0.1:3010/";
const X = Number(process.env.DEMO_X ?? 0);
const Y = Number(process.env.DEMO_Y ?? 0);
const W = Number(process.env.DEMO_W ?? 1280);
const H = Number(process.env.DEMO_H ?? 800);
const PORT = Number(process.env.CDP_PORT ?? 9222);
const SCALE = Number(process.env.DEMO_SCALE ?? 2); // Retina backing scale
const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A Chrome from an earlier take can outlive its run and keep holding the debug
 * port. The one we launch then never binds it, /json/list answers from the OLD
 * browser, and the driver scripts a stale tab while the capture films the new
 * window. That split is invisible in the log and mimics an app bug precisely:
 * origin 'null', sessionStorage SecurityError, refused pushState, dead clicks,
 * "0 errors". Reap rigs before launching — matched on the recording profile so
 * this can only ever touch our own browsers, never the user's.
 */
async function reapRigs() {
  const { stdout } = await pexec("ps", ["-Ao", "pid=,command="]).catch(() => ({ stdout: "" }));
  const stale = stdout
    .split("\n")
    .filter((l) => /--remote-debugging-port=/.test(l) && /demo\/raw\/chrome-profile/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]);
  for (const pid of stale) await pexec("kill", ["-9", pid]).catch(() => {});
  if (stale.length) {
    console.log(`[rec] reaped ${stale.length} stale rig browser(s): ${stale.join(" ")}`);
    await sleep(1500);
  }
  // ffmpeg holds the capture device exclusively; a leaked one starves this run.
  await pexec("pkill", ["-9", "-f", "avfoundation"]).catch(() => {});
}

async function cdp() {
  const want = new URL(APP).origin;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      // Match the app we launched. Taking list[0] is what let a foreign browser
      // hijack the run; a page that merely exists is not proof it is ours.
      const page = pages.find((t) => { try { return new URL(t.url).origin === want; } catch { return false; } });
      if (page) return page;
      if (i === 20 && pages.length) {
        console.log(`[rec] no ${want} target yet; visible: ${pages.map((p) => p.url).join(", ")}`);
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`CDP_WRONG_BROWSER: no page at ${want} on port ${PORT} — another Chrome owns the debug port`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((f) => f(msg));
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("CDP_WS_FAILED")));
  });
  return {
    ready,
    on: (f) => listeners.push(f),
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const durations = JSON.parse(await readFile(path.join(HERE, "durations.json"), "utf8"));
  const driverSrc = await readFile(path.join(HERE, "driver.js"), "utf8");

  await reapRigs();

  // No screensaver handling, and no synthetic keypresses.
  //
  // While the take filmed the display, this kept the screen awake by posting
  // Escape and Control into the session every 100s — into whatever the user
  // happened to be typing in. Capturing the page instead makes the display
  // irrelevant: the screensaver can run, the Mac can be in use, and the frames
  // are unaffected.
  const unCaffeinate = () => {};

  // ── Chrome at a geometry we chose, with persisted state cleared ────────────
  const profile = path.join(OUT, "chrome-profile");
  await pexec("rm", ["-rf", profile]).catch(() => {});
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      // Headless: the take is built from page pixels, so a visible window buys
      // nothing and costs the user their screen for eight minutes.
      "--headless=new",
      `--window-position=${X},${Y}`,
      `--window-size=${W},${H}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-notifications",
      // Keep rAF and timers running even when the window is not frontmost.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-session-crashed-bubble",
      "--disable-infobars",
      "--hide-crash-restore-bubble",
      "--autoplay-policy=no-user-gesture-required",
      // --app strips the tab strip and omnibox, so the capture is the app and
      // nothing else. The exact content rect is still measured below.
      `--app=${APP}`,
    ],
    { stdio: "ignore", detached: false },
  );

  const page = await cdp();
  const c = connect(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Log.enable");

  // The target URL can still be the app while the committed document is an
  // error page — a failed load keeps the requested URL in the target list. Ask
  // the document itself. An error page reports origin 'null', and every DOM
  // action from here would silently do nothing.
  // Chrome publishes the target with its REQUESTED url before the document
  // commits, so an immediate check sees about:blank. Wait for the real one.
  const wantOrigin = new URL(APP).origin;
  let doc = null;
  for (let i = 0; i < 60; i++) {
    const who = await c.send("Runtime.evaluate", {
      expression: "JSON.stringify({o:location.origin,h:location.href,t:document.title})",
      returnByValue: true,
    }).catch(() => null);
    if (who?.result?.value) {
      doc = JSON.parse(who.result.value);
      if (doc.o === wantOrigin) break;
    }
    await sleep(500);
  }
  if (doc?.o !== wantOrigin) {
    throw new Error(`WRONG_DOCUMENT: driving ${doc?.h} (origin ${doc?.o}), expected ${wantOrigin}`);
  }
  console.log(`[rec] attached to ${doc.h} — "${doc.t}"`);

  // ── explorer windows ───────────────────────────────────────────────────────
  // Target/Browser live on the browser-level endpoint, not the page session, so
  // this needs its own socket. The explorer window is placed at the app
  // window's exact bounds: the capture crop is fixed, so anything even slightly
  // offset would be filmed half out of frame.
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const bc = connect(version.webSocketDebuggerUrl);
  await bc.ready;
  const appWin = await bc.send("Browser.getWindowForTarget", { targetId: page.id }).catch(() => null);
  let explorerTarget = null;
  let explorerConn = null;
  let explorerQueue = Promise.resolve();

  const openExplorer = async (url) => {
    const { targetId } = await bc.send("Target.createTarget", { url, newWindow: true });
    explorerTarget = targetId;
    if (appWin?.bounds) {
      const win = await bc.send("Browser.getWindowForTarget", { targetId });
      await bc.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { ...appWin.bounds, windowState: "normal" } });
    }
    // Stream the explorer's OWN frames. The take is built from page pixels now,
    // so a second window is invisible to it unless we point the camera there.
    for (let i = 0; i < 20 && !explorerConn; i++) {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
      const t = list.find((x) => x.id === targetId && x.webSocketDebuggerUrl);
      if (t) {
        explorerConn = connect(t.webSocketDebuggerUrl);
        await explorerConn.ready;
        await explorerConn.send("Page.enable");
        explorerConn.on((m) => { takeFrame(explorerConn, m); });
      } else await sleep(250);
    }
    await stopCast(c);
    if (explorerConn) await startCast(explorerConn);
    console.log(`[rec] explorer → ${url.replace(/^https:\/\/[^/]+/, "")}`);
    await sleep(2600);            // let the explorer render before the beat is judged
  };

  const closeExplorer = async () => {
    if (explorerConn) { await stopCast(explorerConn); explorerConn.close(); explorerConn = null; }
    if (explorerTarget) {
      await bc.send("Target.closeTarget", { targetId: explorerTarget }).catch(() => {});
      explorerTarget = null;
    }
    await sleep(400);
    await startCast(c);           // camera back on the app
  };

  // Beat marks come off the driver's own clock, via console.
  const marks = [];
  const txHashes = [];
  // Wall-clock gap between the camera's first frame and the driver's first
  // beat. cut.mjs treats a mark as an offset INTO the file, so without this the
  // whole edit sits earlier than the action it narrates.
  let videoOffsetMs = null;
  let done = false;
  let failed = null;
  const onText = (text) => {
    const m = /^DEMO_LINE (\d+) (\S+)( SIGNING)?/.exec(text);
    if (m) {
      if (videoOffsetMs === null) {
        // FF_WARMUP: avfoundation opens the device a beat after spawn, so the
        // file starts later than ffSpawnAt. Measured at ~1.1s on this machine.
        const FF_WARMUP = 1100;
        videoOffsetMs = Math.max(0, Date.now() - ffSpawnAt - FF_WARMUP - Number(m[1]));
        console.log(`[rec] video/driver offset: ${(videoOffsetMs / 1000).toFixed(2)}s`);
      }
      marks.push({ ms: Number(m[1]), id: m[2], signing: Boolean(m[3]) });
      console.log(`  mark ${String(m[1]).padStart(7)}ms  ${m[2]}${m[3] ? "  [SIGNING]" : ""}`);
    }
    if (text.startsWith("DEMO_DONE")) done = true;
    if (text.startsWith("DEMO_FAILED")) failed = text;
    if (text.startsWith("DEMO_TX ")) {
      const h = text.slice("DEMO_TX ".length).trim();
      txHashes.push(h);
      console.log(`  tx   ${h}`);
    }
    // The driver cannot navigate to the explorer itself — a document-level
    // navigation would tear the driver out of the page mid-take. So it asks,
    // and we open the page in its own window sized exactly like the app's, so
    // the fixed capture crop frames it identically.
    if (text.startsWith("DEMO_EXPLORER ")) {
      const url = text.slice("DEMO_EXPLORER ".length).trim();
      explorerQueue = explorerQueue.then(() => openExplorer(url)).catch((e) =>
        console.log(`[rec] explorer window failed: ${e.message}`));
    }
    if (text.startsWith("DEMO_EXPLORER_DONE")) {
      explorerQueue = explorerQueue.then(() => closeExplorer()).catch(() => {});
    }
  };
  c.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled") {
      onText((msg.params.args ?? []).map((a) => a.value ?? "").join(" "));
    }
  });

  console.log("[rec] waiting for app to settle…");
  await sleep(9000);

  // Pre-flight: clear any persisted app/wallet state before a single frame.
  // Then put ONE key back. Clearing storage is what makes the first-run welcome
  // dialog fire, and it is modal: it swallows every click the driver makes and
  // stalls the take until something else dismisses it. Seed it before the
  // reload so the dialog never mounts — the app is otherwise untouched.
  await c.send("Runtime.evaluate", {
    expression: `(async()=>{try{localStorage.clear();sessionStorage.clear();
      if(indexedDB.databases){for(const d of await indexedDB.databases()){if(d.name)indexedDB.deleteDatabase(d.name);}}
      localStorage.setItem("leverx_welcome_dismissed","1");
    }catch(e){}})()`,
    awaitPromise: true,
  });
  await c.send("Page.reload", { ignoreCache: true });
  await sleep(9000);

  // Pre-flight: count pre-existing errors so failure checks are scoped to this run.
  const errBefore = await c.send("Runtime.evaluate", {
    expression: `(()=>{window.__ERRS=window.__ERRS||0;
      if(!window.__ERRHOOK){window.__ERRHOOK=1;addEventListener('error',()=>window.__ERRS++);
      addEventListener('unhandledrejection',()=>window.__ERRS++);}return window.__ERRS;})()`,
    returnByValue: true,
  });
  console.log(`[rec] pre-existing error count: ${errBefore.result.value}`);

  // ── recorder: capture the PAGE, not the screen ────────────────────────────
  //
  // avfoundation films the display. That means the take contains whatever the
  // machine is showing — a screensaver, another Space, or the user's own
  // browsing, which is exactly what ended up in one cut. It also made the
  // recording exclusive: nobody could touch the Mac for eight minutes.
  //
  // CDP screencast streams frames from the renderer instead. The window can be
  // buried, on another Space, or scrolled past by someone working — the frames
  // are the app's own pixels either way, and the machine stays usable.
  const outFile = path.join(OUT, "take.mp4");
  const FRAMES = path.join(OUT, "frames");
  const FPS = Number(process.env.DEMO_FPS ?? 24);
  await pexec("rm", ["-rf", FRAMES]).catch(() => {});
  await mkdir(FRAMES, { recursive: true });

  // Frames arrive only when something changes, each stamped by the browser, so
  // a still screen costs one frame and the timing stays honest. Durations are
  // reconstructed from those stamps at encode time.
  const frameLog = [];
  let frameNo = 0;
  let capturing = false;
  const takeFrame = async (conn, msg) => {
    if (msg.method !== "Page.screencastFrame") return;
    const { data, sessionId, metadata } = msg.params;
    conn.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!capturing) return;
    const f = path.join(FRAMES, `f${String(++frameNo).padStart(6, "0")}.jpg`);
    await writeFile(f, Buffer.from(data, "base64")).catch(() => {});
    frameLog.push({ f, ts: metadata.timestamp });
  };
  c.on((m) => { takeFrame(c, m); });

  const startCast = (conn) => conn.send("Page.startScreencast", {
    format: "jpeg", quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1,
  });
  const stopCast = (conn) => conn.send("Page.stopScreencast").catch(() => {});

  // Prove frames actually flow before committing to a take.
  await startCast(c);
  capturing = true;
  await sleep(1500);
  capturing = false;
  if (!frameLog.length) throw new Error("RECORDER_BLANK: screencast produced no frames");
  {
    const probe = frameLog[frameLog.length - 1].f;
    const px = await pexec("ffmpeg", ["-v", "error", "-i", probe, "-vf", "scale=1:1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 20 });
    const [pr, pg, pb] = px.stdout;
    if (pb - pg > 40) throw new Error(`RECORDER_BLANK: page is rgb ${pr},${pg},${pb} — not the app`);
    console.log(`[rec] screencast verified — ${frameLog.length} frames, probe rgb ${pr},${pg},${pb}`);
  }
  frameLog.length = 0; frameNo = 0;
  await pexec("rm", ["-rf", FRAMES]).catch(() => {});
  await mkdir(FRAMES, { recursive: true });

  // Choose the market BEFORE the camera rolls.
  //
  // This used to happen between spawning ffmpeg and injecting the driver, and
  // it is a chain walk whose duration varies by many seconds. Every one of
  // those seconds went into the video ahead of the driver's first beat, while
  // cut.mjs treats a beat's mark as its offset INTO the file — so the whole
  // edit slid by however long the fetch happened to take (7.5s, measured). Each
  // line then played over the previous beat's screen.
  const mkts = await (await fetch("http://127.0.0.1:4100/api/onchain/markets?status=open")).json();
  // The take runs ~7.5 minutes and the sealed bet lands about 4.5 minutes in,
  // so the market has to outlive that. Eight minutes was cutting it fine, and
  // `?? mkts[0]` quietly fell back to a market that could already be closed —
  // which is how a take ended up on a detail page with no bet ticket.
  const LEAD_MS = 12 * 60 * 1000;
  const openM = mkts.find((m) => m.closeTs - Date.now() > LEAD_MS);
  if (!openM) {
    const best = Math.max(0, ...mkts.map((m) => m.closeTs - Date.now()));
    throw new Error(
      `NO_OPEN_MARKET: need ${LEAD_MS / 60000}m of lead, best is ${Math.round(best / 60000)}m — wait for the keeper to open the next slot`,
    );
  }
  console.log(`[rec] market ${openM.symbol} ${openM.marketId.slice(0, 12)}… closes in ${Math.round((openM.closeTs - Date.now()) / 60000)}m`);
  await c.send("Runtime.evaluate", {
    expression: `window.__DURATIONS__ = ${JSON.stringify(durations.durations)};
                 window.__MARKET_ID__ = ${JSON.stringify(openM.marketId)};`,
  });
  // Re-seed AND re-inject on every document: a hard navigation mid-take would
  // otherwise drop the driver on the floor.
  await c.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__DURATIONS__ = ${JSON.stringify(durations.durations)};
             window.__MARKET_ID__ = ${JSON.stringify(openM.marketId)};`,
  });
  // Camera on, then the driver, back to back. Whatever still separates them is
  // measured below rather than assumed, and handed to the cut.
  capturing = true;
  const ffSpawnAt = Date.now();

  const t0 = Date.now();

  // Injection must fail LOUDLY. Runtime.evaluate reports a thrown driver in
  // `exceptionDetails` and otherwise looks like success — which is how an
  // eleven-minute take came back "0 beats, 0 errors" with nothing having run.
  const inj = await c.send("Runtime.evaluate", { expression: driverSrc, returnByValue: true });
  if (inj.exceptionDetails) {
    const e = inj.exceptionDetails;
    throw new Error(`DRIVER_THREW_ON_INJECT: ${e.exception?.description ?? e.text} (line ${e.lineNumber})`);
  }
  console.log(`[rec] driver injected → ${JSON.stringify(inj.result?.value ?? null)}`);

  // And it must actually start. Confirm the flag is set and the first mark
  // lands, rather than discovering emptiness at the end of the budget.
  {
    const t = Date.now();
    let started = false;
    while (Date.now() - t < 15000) {
      const r = await c.send("Runtime.evaluate", {
        expression: "JSON.stringify({f:!!window.__MOLFI_DRIVER__,n:(window.__MARKS||[]).length,e:window.__DEMO&&window.__DEMO.error})",
        returnByValue: true,
      });
      const st = JSON.parse(r.result.value);
      if (st.e) throw new Error(`DRIVER_FAILED_IMMEDIATELY: ${st.e}`);
      if (st.f && st.n > 0) { started = true; break; }
      await sleep(500);
    }
    if (!started) throw new Error("DRIVER_NEVER_STARTED: no mark within 15s of injection");
  }
  console.log("[rec] take running\n");

  const budgetMs = (durations.totalSec + 27 * 0.45) * 1000 + 300000;
  while (!done && !failed && Date.now() - t0 < budgetMs) {
    await sleep(1500);
    // The page's own array is the source of truth. Relying on
    // Runtime.consoleAPICalled alone loses every mark if that channel drops.
    try {
      const r = await c.send("Runtime.evaluate", {
        expression: "JSON.stringify({m:window.__MARKS||[],d:!!(window.__DEMO&&window.__DEMO.done),e:(window.__DEMO&&window.__DEMO.error)||null})",
        returnByValue: true,
      });
      const st = JSON.parse(r.result.value);
      for (const mk of st.m) {
        if (!marks.some((x) => x.id === mk.id)) {
          marks.push(mk);
          console.log(`  mark ${String(mk.ms).padStart(7)}ms  ${mk.id}${mk.signing ? "  [SIGNING]" : ""}`);
        }
      }
      if (st.e) failed = `DEMO_FAILED ${st.e}`;
      if (st.d) done = true;
    } catch { /* page mid-navigation — next tick picks it up */ }
  }

  const takeMs = Date.now() - t0;
  await sleep(1500);
  capturing = false;
  await stopCast(c);
  await sleep(300);

  // Encode from the stamped frames. Each frame holds until the next one's
  // timestamp, so a screen that sat still for ten seconds stays still for ten
  // seconds instead of being replayed at the wrong speed.
  if (!frameLog.length) throw new Error("NO_FRAMES: screencast captured nothing");
  const listFile = path.join(OUT, "frames.txt");
  const t0f = frameLog[0].ts;
  let listing = "";
  for (let i = 0; i < frameLog.length; i++) {
    // Real elapsed time between frames — NOT clamped to 1/FPS.
    //
    // Clamping looks harmless and silently stretches the timeline: Chrome emits
    // faster than 24fps while things move, so flooring every gap at 1/24 turned
    // 12s of capture into 16.6s of video. Beat marks are offsets into this file,
    // so that stretch would desync every line. Let the fps filter resample.
    const dur = i + 1 < frameLog.length
      ? Math.max(0.001, frameLog[i + 1].ts - frameLog[i].ts)
      : Math.max(0.04, (takeMs / 1000) - (frameLog[i].ts - t0f));
    listing += `file '${frameLog[i].f.replace(/'/g, "'\\''")}'\nduration ${dur.toFixed(4)}\n`;
  }
  listing += `file '${frameLog[frameLog.length - 1].f.replace(/'/g, "'\\''")}'\n`;
  await writeFile(listFile, listing);
  await pexec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", `fps=${FPS},scale=${W}:-2`, "-pix_fmt", "yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", outFile],
    { maxBuffer: 1 << 28 });
  console.log(`[rec] encoded ${frameLog.length} captured frames → ${FPS}fps`);

  const errAfter = await c
    .send("Runtime.evaluate", { expression: "window.__ERRS||0", returnByValue: true })
    .catch(() => ({ result: { value: -1 } }));

  const log = marks
    .map((m) => `DEMO_LINE ${m.ms} ${m.id}${m.signing ? " SIGNING" : ""}`)
    .join("\n");
  await writeFile(path.join(OUT, "beats.log"), log + "\n");

  await writeFile(path.join(OUT, "sync.json"), JSON.stringify({ videoOffsetMs: videoOffsetMs ?? 0 }) + "\n");
  await writeFile(
    path.join(OUT, "take.json"),
    JSON.stringify(
      { app: APP, geometry: { x: X, y: Y, w: W, h: H, scale: SCALE },
        takeMs, takeHuman: `${Math.floor(takeMs / 60000)}m ${((takeMs % 60000) / 1000).toFixed(1)}s`,
        beats: marks.length, signingBeats: marks.filter((m) => m.signing).map((m) => m.id),
        errorsBefore: errBefore.result.value, errorsAfter: errAfter.result.value,
        completed: done, failure: failed, video: outFile },
      null, 2,
    ) + "\n",
  );

  let bytes = 0;
  try { bytes = (await stat(outFile)).size; } catch {}
  console.log(`\n[rec] take ${Math.floor(takeMs / 60000)}m ${((takeMs % 60000) / 1000).toFixed(1)}s`);
  console.log(`[rec] beats logged: ${marks.length} (${marks.filter((m) => m.signing).length} signing)`);
  console.log(`[rec] video: ${outFile} (${(bytes / 1e6).toFixed(1)} MB)`);
  console.log(`[rec] errors during run: ${errAfter.result.value - errBefore.result.value}`);
  console.log(`[rec] on-chain transactions: ${txHashes.length}`);
  txHashes.forEach((h) => console.log(`    https://coston2-explorer.flare.network/tx/${h}`));
  // A clean beat log is not proof the camera saw the app: a screensaver or a
  // window that moved away leaves every mark intact over useless footage.
  //
  // File size cannot tell these apart — a sparse JSON-card beat weighs 45 KB
  // and a screensaver frame 43 KB. Colour can. The app is near-black in every
  // state (measured blue-minus-green of 0..8); this machine's screensaver is a
  // saturated purple (66..91). Anything past 40 is not our app. A light theme
  // would keep the channels level, so this only ever fires on the gradient.
  const blank = [];
  for (const m of marks) {
    const at = (m.ms / 1000 + 1).toFixed(2);
    const probeF = path.join(OUT, `.verify-${m.id}.png`);
    await pexec("ffmpeg", ["-y", "-loglevel", "error", "-ss", at, "-i", outFile, "-vframes", "1", probeF]).catch(() => {});
    const px = await pexec("ffmpeg", ["-v", "error", "-i", probeF, "-vf", "scale=1:1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 20 }).catch(() => null);
    await pexec("rm", ["-f", probeF]).catch(() => {});
    if (!px?.stdout?.length) { blank.push(`${m.id}(unreadable)`); continue; }
    const [r, g, b] = px.stdout;
    // Only the purple-gradient signature. A brightness ceiling used to be part
    // of this and would now reject the explorer beats, whose pages are legibly
    // white — a light page is a real page. The screensaver is the one thing
    // that pushes blue far above green (66..91 measured, versus 0..8 for the
    // app and roughly 0 for anything neutral).
    if (b - g > 40) blank.push(`${m.id}(rgb ${r},${g},${b})`);
  }
  if (blank.length) console.log(`[rec] ⚠ beats with no app on screen: ${blank.join(" ")}`);
  else console.log(`[rec] footage check: all ${marks.length} beats show the app`);

  const ok = !failed && done && blank.length === 0;
  console.log(failed ? `[rec] RESULT: FAILED — ${failed}`
    : !done ? "[rec] RESULT: TIMED OUT"
    : blank.length ? `[rec] RESULT: FAILED — ${blank.length} beat(s) filmed no app`
    : "[rec] RESULT: COMPLETED");

  c.close();
  chrome.kill();
  unCaffeinate();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("PHASE4 FAILED:", e.message); process.exit(1); });
