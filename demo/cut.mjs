#!/usr/bin/env node
/**
 * Phase B/D/E — assemble the finished cut from the beat log.
 *
 * The log is the edit decision list. Each line's audio plays over the footage
 * between its own mark and the next mark; nothing is timed by eye.
 *
 *   node demo/cut.mjs
 */
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(HERE, "raw");
const WORK = path.join(HERE, "work");
const OUT = path.join(HERE, "out");
const TAKE = path.join(RAW, "take.mp4");
const W = 1280, H = 712, FPS = 24;

const ff = (args) => pexec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 1 << 28 });
const probe = async (f) =>
  Number((await pexec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])).stdout.trim());

const ts = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60), ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
};

async function main() {
  await mkdir(WORK, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const durations = JSON.parse(await readFile(path.join(HERE, "durations.json"), "utf8")).durations;
  const beatsRaw = (await readFile(path.join(RAW, "beats.log"), "utf8")).trim().split("\n");
  const marks = beatsRaw.map((l) => {
    const m = /^DEMO_LINE (\d+) (\S+)( SIGNING)?/.exec(l);
    return { ms: Number(m[1]), id: m[2], signing: Boolean(m[3]) };
  });
  // The camera starts before the driver does, so a beat's mark is NOT its
  // offset into the file — the difference is measured during the take and
  // written to sync.json. Ignoring it slid the entire edit earlier than the
  // action it narrates (7.5s on the take that exposed this).
  const sync = await readFile(path.join(RAW, "sync.json"), "utf8")
    .then((s) => JSON.parse(s).videoOffsetMs || 0)
    .catch(() => 0);
  const takeDur = await probe(TAKE);
  console.log(`take ${takeDur.toFixed(1)}s · ${marks.length} beats · video offset ${(sync / 1000).toFixed(2)}s`);

  // ── one segment per beat ───────────────────────────────────────────────────
  const segs = [];
  let srt = "";
  let timeline = 0;

  for (const [i, m] of marks.entries()) {
    const start = (m.ms + sync) / 1000;
    const end = i + 1 < marks.length ? (marks[i + 1].ms + sync) / 1000 : takeDur;
    const footage = Math.max(0.4, end - start);
    const narration = durations[m.id];
    const seg = path.join(WORK, `seg-${String(i).padStart(2, "0")}-${m.id}.mp4`);
    const audio = path.join(HERE, "audio", `${m.id}.wav`);

    if (!narration) {
      // No narration for this span: a "thinking" gap. Compress hard rather than
      // hold a still frame under silence.
      const target = Math.min(5, footage);
      const speed = footage / target;
      await ff(["-ss", String(start), "-t", String(footage), "-i", TAKE,
        "-filter_complex", `[0:v]setpts=PTS/${speed.toFixed(6)},fps=${FPS},scale=${W}:${H}[v];anullsrc=r=48000:cl=stereo,atrim=0:${target}[a]`,
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-pix_fmt", "yuv420p", "-t", String(target), seg]);
      segs.push({ seg, dur: target, id: m.id });
      timeline += target;
      continue;
    }

    let vf;
    if (footage > narration) {
      // Footage runs long → ramp it to fit the line exactly.
      const speed = footage / narration;
      vf = `[0:v]setpts=PTS/${speed.toFixed(6)},fps=${FPS},scale=${W}:${H}[v]`;
    } else {
      // Footage runs short → hold the last frame. Clamp at zero: the arithmetic
      // can land a hair negative and ffmpeg rejects a negative pad outright.
      const pad = Math.max(0, narration - footage);
      vf = `[0:v]fps=${FPS},scale=${W}:${H},tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}[v]`;
    }

    await ff(["-ss", String(start), "-t", String(footage), "-i", TAKE, "-i", audio,
      "-filter_complex", vf,
      "-map", "[v]", "-map", "1:a",
      "-af", "apad",                       // apad BEFORE -shortest, or the tail is clipped
      "-shortest",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-ar", "48000", "-ac", "2", "-pix_fmt", "yuv420p", seg]);

    const actual = await probe(seg);
    segs.push({ seg, dur: actual, id: m.id });

    const text = JSON.parse(await readFile(path.join(HERE, "narration.json"), "utf8"))
      .lines.find((l) => l.id === m.id)?.text ?? "";
    srt += `${segs.length}\n${ts(timeline)} --> ${ts(timeline + actual)}\n${text}\n\n`;
    timeline += actual;
    console.log(`  ${m.id.padEnd(16)} footage ${footage.toFixed(1)}s → ${actual.toFixed(1)}s${m.signing ? "  [SIGNING]" : ""}`);
  }

  await writeFile(path.join(OUT, "molfi-demo.srt"), srt);

  // ── Phase D: animated intro + outro ───────────────────────────────────────
  // These are rendered frame by frame in Chrome (demo/cards.mjs) and arrive
  // here already animated — letters rising in sequence, a rule drawing itself,
  // a glow that keeps drifting. ffmpeg used to zoompan across a single still,
  // which is a camera move over static type and read exactly like one. Nothing
  // to composite now; just use the clips.
  const title = path.join(WORK, "intro.mp4");
  const outro = path.join(WORK, "outro.mp4");
  for (const f of [title, outro]) {
    try { await probe(f); } catch {
      throw new Error(`MISSING_CARD: ${f} — run \`node demo/cards.mjs\` first`);
    }
  }

  // ── concat: intro + body + outro ──────────────────────────────────────────
  const list = path.join(WORK, "concat.txt");
  await writeFile(list, [title, ...segs.map((s) => s.seg), outro].map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const master = path.join(OUT, "molfi-demo.mp4");
  await ff(["-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", master]);

  const finalDur = await probe(master);
  const mm = Math.floor(finalDur / 60), ss = finalDur - mm * 60;
  console.log(`\nmaster: ${master}`);
  console.log(`runtime: ${mm}m ${ss.toFixed(1)}s`);

  // ── Phase E: only if it drags past 8 minutes, re-encode FROM the 1.0x master
  if (finalDur > 480) {
    const speed = finalDur / 470;
    const fast = path.join(OUT, "molfi-demo-tightened.mp4");
    await ff(["-i", master, "-filter_complex",
      `[0:v]setpts=PTS/${speed.toFixed(6)}[v];[0:a]atempo=${speed.toFixed(6)}[a]`,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", fast]);
    const d2 = await probe(fast);
    console.log(`tightened: ${fast}  ${Math.floor(d2 / 60)}m ${(d2 % 60).toFixed(1)}s (atempo ${speed.toFixed(3)}, pitch preserved)`);
  }
}

main().catch((e) => { console.error("CUT FAILED:", e.message); process.exit(1); });
