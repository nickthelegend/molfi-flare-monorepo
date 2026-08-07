#!/usr/bin/env node
/**
 * Put Molfi's handler inside the image that FCC actually registered.
 *
 *   node scripts/sync-extension.mjs            # monorepo → scaffold
 *   node scripts/sync-extension.mjs --check    # report drift, change nothing
 *   node scripts/sync-extension.mjs --adopt    # scaffold's base/ → monorepo
 *
 * WHY A SYNC AND NOT A FORK. The Flare extension scaffold is upstream code with
 * its own release cadence, and `base/` is explicitly marked "do not modify" —
 * vendoring the whole thing into this repo would quietly fork the wire contract.
 * So the split is: `extension/src/app/` is ours and lives here, `base/` and
 * `main.ts` are theirs and are only mirrored so this repo typechecks. Every run
 * verifies the mirror byte-for-byte and refuses to proceed if upstream moved,
 * because a silently stale `base/` means the image and this repo no longer speak
 * the same protocol.
 *
 * Set FCE_HOME if the scaffold is not at ~/molfi-fce.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const FCE = process.env.FCE_HOME || join(homedir(), "molfi-fce");
const TS = join(FCE, "typescript");

const MODE = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--adopt")
    ? "adopt"
    : "sync";
const SKIP_LOCK = process.argv.includes("--no-lock");

/** Pinned to what the scaffold's lockfile already resolves for viem's own use,
 *  so adding them as direct dependencies pulls in no new package. */
const NOBLE_DEPS = { "@noble/curves": "1.7.0", "@noble/hashes": "1.6.1" };

const OURS = join(HERE, "extension/src");
/** Upstream files this repo only mirrors, as [label, ourPath, theirPath]. */
const MIRRORED = [
  ["src/main.ts", join(OURS, "main.ts"), join(TS, "src/main.ts")],
  ...readdirSync(join(OURS, "base")).map((f) => [
    `src/base/${f}`, join(OURS, "base", f), join(TS, "src/base", f),
  ]),
  // Not cosmetic: `strict` and `moduleResolution` decide whether app/ compiles
  // at all, so a local tsconfig that has drifted typechecks a different program
  // than the image builds.
  ["tsconfig.json", join(HERE, "extension/tsconfig.json"), join(TS, "tsconfig.json")],
];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

if (!existsSync(TS)) {
  console.error(red(`no scaffold at ${TS}`));
  console.error(`  clone the Flare extension scaffold there, or set FCE_HOME.`);
  process.exit(1);
}

let drifted = 0;

// --- 1. The upstream half: verify, never silently overwrite ------------------
for (const [rel, mine, theirs] of MIRRORED) {
  if (!existsSync(theirs)) {
    console.error(red(`upstream is missing ${rel} — scaffold layout changed`));
    process.exit(1);
  }
  const same = readFileSync(mine, "utf8") === readFileSync(theirs, "utf8");
  if (same) continue;

  drifted++;
  if (MODE === "adopt") {
    copyFileSync(theirs, mine);
    console.log(`${green("adopted")} ${rel} ${dim("(upstream → monorepo)")}`);
  } else {
    console.error(red(`drift in ${rel}`));
    console.error(
      `  This is upstream infrastructure. Re-run with --adopt to take their\n` +
      `  version, then re-check that app/ still compiles against it.`,
    );
  }
}
if (drifted && MODE === "sync") process.exit(1);

// --- 2. Our half: app sources + the tests that exercise them -----------------
const plan = [
  { from: join(OURS, "app"), to: join(TS, "src/app"), prune: true },
  {
    from: join(OURS, "__tests__"), to: join(TS, "src/__tests__"),
    // framework/encoding tests are upstream's and touch no app code — leaving
    // them in place keeps `npm test` covering the base layer too.
    prune: false,
  },
];

let changed = 0;
for (const { from, to, prune } of plan) {
  mkdirSync(to, { recursive: true });
  const files = readdirSync(from).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    const src = readFileSync(join(from, f), "utf8");
    const dstPath = join(to, f);
    const dst = existsSync(dstPath) ? readFileSync(dstPath, "utf8") : null;
    if (src === dst) continue;
    changed++;
    if (MODE === "check") {
      console.error(red(`out of date: ${dstPath.replace(FCE, "$FCE_HOME")}`));
    } else {
      writeFileSync(dstPath, src);
      console.log(`${green("wrote")} ${dstPath.replace(FCE, "$FCE_HOME")}`);
    }
  }
  if (!prune) continue;
  for (const f of readdirSync(to).filter((x) => x.endsWith(".ts"))) {
    if (files.includes(f)) continue;
    changed++;
    if (MODE === "check") {
      console.error(red(`stale in scaffold: app/${f}`));
    } else {
      // The scaffold's GREETING sample lives here. Leaving it would keep a
      // second, unreachable op-type compiled into the TEE image.
      rmSync(join(to, f));
      console.log(`${green("removed")} app/${f} ${dim("(scaffold sample)")}`);
    }
  }
}

// --- 3. Dependencies -------------------------------------------------------
const pkgPath = join(TS, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const missing = Object.entries(NOBLE_DEPS).filter(
  ([name, version]) => pkg.dependencies?.[name] !== version,
);
if (missing.length) {
  changed++;
  if (MODE === "check") {
    console.error(red(`package.json missing: ${missing.map(([n]) => n).join(", ")}`));
  } else {
    pkg.dependencies = { ...pkg.dependencies };
    for (const [name, version] of missing) pkg.dependencies[name] = version;
    // Keep dependency order stable so the diff against upstream stays readable.
    pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort());
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`${green("added")} ${missing.map(([n, v]) => `${n}@${v}`).join(", ")}`);

    if (!SKIP_LOCK) {
      // `npm ci` — which is what the Dockerfile runs — refuses to build when
      // package.json declares a dependency the lockfile's root entry does not.
      // Regenerating the lock is the only safe way to add one.
      console.log(dim("  regenerating package-lock.json…"));
      execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
        cwd: TS, stdio: "inherit",
      });
    }
  }
}

// --- 4. Extension env ------------------------------------------------------
// pre-build.sh owns the top of this file (EXTENSION_ID / INSTRUCTION_SENDER);
// only the MOLFI block below the marker belongs to us. Keys are read from the
// gitignored .env.local so they never enter the repo.
const MARKER = "# --- molfi (managed by scripts/sync-extension.mjs) ---";
const envPath = join(FCE, "config/extension.env");
const localEnv = join(HERE, ".env.local");
if (MODE !== "check" && existsSync(localEnv) && existsSync(envPath)) {
  const local = Object.fromEntries(
    readFileSync(localEnv, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  const block = [
    MARKER,
    ...["SEALED_BID_BOOK", "ENCLAVE_PRIVATE_KEY", "TEE_SIGNER_KEY"]
      .filter((k) => local[k])
      .map((k) => `${k}=${local[k]}`),
  ].join("\n");

  const current = readFileSync(envPath, "utf8");
  const head = current.split(MARKER)[0].trimEnd();
  const next = `${head}\n\n${block}\n`;
  if (next !== current) {
    changed++;
    writeFileSync(envPath, next);
    console.log(`${green("wrote")} config/extension.env ${dim("(MOLFI block)")}`);
  }
}

// --- Result ----------------------------------------------------------------
if (MODE === "check") {
  if (changed || drifted) {
    console.error(red(`\n${changed + drifted} file(s) out of sync`));
    process.exit(1);
  }
  console.log(green("scaffold is in sync with molfi-fcc/extension"));
} else if (!changed && !drifted) {
  console.log(green("already in sync"));
} else {
  console.log(`\n${green("synced")} — rebuild the image:`);
  console.log(dim(`  cd ${FCE.replace(homedir(), "~")} && docker compose \\`));
  console.log(dim(`    -f docker-compose.yaml -f docker-compose.coston2.yaml up -d --build`));
}
