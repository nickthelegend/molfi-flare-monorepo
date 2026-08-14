#!/usr/bin/env node
/**
 * Phase 2 — one audio file per narration line, with REAL measured durations.
 *
 * The one-clock rule lives or dies here: the driver holds each beat for the
 * duration of its audio file, so a duration that was estimated rather than
 * measured puts every later beat out of sync. We decode the WAV header we just
 * wrote and compute duration from actual sample count — never from text length.
 *
 * Kokoro-82M runs locally via kokoro-js (transformers.js). No API key.
 *
 *   node demo/tts.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// fileURLToPath, not `.pathname` — this repo lives under "/Volumes/Extreme SSD",
// and the raw pathname keeps the %20, which fs then cannot open.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "audio");
// kokoro-js lives in the slophunt checkout; resolve from there rather than
// duplicating a ~90MB model download into this repo.
const KOKORO_HOST = "/Volumes/Extreme SSD/Projects/slophunt";
const require = createRequire(path.join(KOKORO_HOST, "package.json"));
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Duration from the actual PCM payload, not from any metadata we guessed. */
function wavDurationSec(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a RIFF/WAV file");
  let pos = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bitsPerSample = buf.readUInt16LE(pos + 22);
    } else if (id === "data") {
      const bytesPerFrame = (bitsPerSample / 8) * channels;
      if (!bytesPerFrame || !sampleRate) throw new Error("fmt chunk missing before data");
      return size / bytesPerFrame / sampleRate;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

async function main() {
  const spec = JSON.parse(await readFile(path.join(HERE, "narration.json"), "utf8"));
  await mkdir(OUT_DIR, { recursive: true });

  const { KokoroTTS } = await import(pathToFileURL(require.resolve("kokoro-js")).href);
  process.stdout.write("loading Kokoro-82M… ");
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" });
  console.log("ok");

  const durations = {};
  let total = 0;

  for (const [i, line] of spec.lines.entries()) {
    const outPath = path.join(OUT_DIR, `${line.id}.wav`);
    const audio = await tts.generate(line.text, {
      voice: spec.voice,
      speed: spec.speed,
    });
    await audio.save(outPath);

    const secs = wavDurationSec(await readFile(outPath));
    durations[line.id] = Number(secs.toFixed(3));
    total += secs;
    console.log(
      `${String(i + 1).padStart(2)}/${spec.lines.length}  ${line.id.padEnd(20)} ${secs.toFixed(2)}s`,
    );
  }

  const manifest = {
    voice: spec.voice,
    speed: spec.speed,
    generatedAtIso: new Date().toISOString(),
    totalSec: Number(total.toFixed(3)),
    durations,
  };
  await writeFile(path.join(HERE, "durations.json"), JSON.stringify(manifest, null, 2) + "\n");

  const m = Math.floor(total / 60);
  console.log(`\ntotal narration ${m}m ${(total - m * 60).toFixed(1)}s across ${spec.lines.length} lines`);
  console.log(`wrote ${path.join(HERE, "durations.json")}`);
}

main().catch((e) => {
  console.error("TTS FAILED:", e.message);
  process.exit(1);
});
