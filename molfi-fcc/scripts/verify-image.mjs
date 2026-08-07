#!/usr/bin/env node
/**
 * Prove the registered container is running Molfi's handler — don't assert it.
 *
 *   node scripts/verify-image.mjs
 *
 * Everything here is read from the RUNNING container, not from source: its
 * `/state`, its `/action` responses through the real FCC wire format, the
 * @noble versions its `npm ci` actually resolved, and its ability to decrypt a
 * ciphertext this script seals from outside. The last one is the point — the
 * container's private key never leaves it, so a successful open is only
 * possible if the code inside really is the enclave it claims to be.
 *
 * Set CONTAINER if the compose project name differs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toFunctionSelector } from "viem";
import { sealSide } from "../src/seal.mjs";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const CONTAINER = process.env.CONTAINER || "molfi-fce-extension-tee-1";
const BOOK_DEPLOYMENT = join(HERE, "../molfi-contracts/deployments/coston2.json");

const MKT = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { failures++; console.error(`  \x1b[31m✗\x1b[0m ${m}`); };

/** Run node INSIDE the container and parse its JSON line. */
function inContainer(script) {
  const out = execFileSync("docker", ["exec", CONTAINER, "node", "-e", script], {
    encoding: "utf8", timeout: 60_000,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

console.log(`\n  verifying ${CONTAINER}\n`);

// --- 1. Identity ------------------------------------------------------------
const state = inContainer(`
  fetch("http://localhost:7702/state").then(r=>r.json()).then(j=>console.log(JSON.stringify(j)));
`);
const s = state.state ?? {};
if (s.extension === "molfi-sealed-book") ok(`serving "${s.extension}" (not the scaffold sample)`);
else bad(`extension is "${s.extension}" — the Molfi handler is not in this image`);

if (Array.isArray(s.commands) && s.commands.join() === "SEAL_KEY,OPEN_BOOK") {
  ok(`commands ${s.commands.join(" · ")}`);
} else bad(`commands are ${JSON.stringify(s.commands)}`);

// --- 2. The scaffold sample must be GONE, not merely unused ------------------
const greeting = inContainer(`
  const b32=(x)=>"0x"+Buffer.from(x,"utf8").toString("hex").padEnd(64,"0");
  const df={instructionId:"0x"+"11".repeat(32),opType:b32("GREETING"),opCommand:b32("SAY_HELLO"),
    originalMessage:"0x",additionalFixedMessage:"0x",cosigners:[],cosignersThreshold:0};
  fetch("http://localhost:7702/action",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({data:{id:"0x"+"11".repeat(32),type:"instruction",submissionTag:"submit",
      message:"0x"+Buffer.from(JSON.stringify(df)).toString("hex")}})})
   .then(r=>console.log(JSON.stringify({status:r.status})));
`);
if (greeting.status === 501) ok("GREETING/SAY_HELLO → 501, the sample handler is not compiled in");
else bad(`GREETING/SAY_HELLO → ${greeting.status}, the scaffold sample is still reachable`);

// --- 3. Dependency versions, as resolved in the image -----------------------
const versions = inContainer(`
  console.log(JSON.stringify({
    curves: require("/app/extension/node_modules/@noble/curves/package.json").version,
    hashes: require("/app/extension/node_modules/@noble/hashes/package.json").version,
  }));
`);
ok(`in-image @noble/curves ${versions.curves} · @noble/hashes ${versions.hashes}`);

// --- 4. The decisive one: seal out here, open in there -----------------------
// The container holds the private half. If the key derivations had drifted
// across those @noble versions this is where it would show, and nowhere else.
if (!s.enclavePublicKey) {
  bad("no enclavePublicKey in /state — cannot test the round trip");
} else {
  const cts = { 0: sealSide(s.enclavePublicKey, MKT, ALICE, 0), 1: sealSide(s.enclavePublicKey, MKT, ALICE, 1) };
  const round = inContainer(`
    const { openSealed } = require("/app/extension/dist/app/seal.js");
    const ct = ${JSON.stringify(cts)};
    const K = process.env.ENCLAVE_PRIVATE_KEY;
    const out = { yes: null, no: null, replay: "accepted", lift: "accepted" };
    out.yes = openSealed(K, ${JSON.stringify(MKT)}, ${JSON.stringify(ALICE)}, ct["0"]);
    out.no  = openSealed(K, ${JSON.stringify(MKT)}, ${JSON.stringify(ALICE)}, ct["1"]);
    try { openSealed(K, ${JSON.stringify(OTHER)}, ${JSON.stringify(ALICE)}, ct["0"]); } catch { out.replay = "rejected"; }
    try { openSealed(K, ${JSON.stringify(MKT)}, ${JSON.stringify(BOB)}, ct["0"]); } catch { out.lift = "rejected"; }
    console.log(JSON.stringify(out));
  `);
  if (round.yes === 0 && round.no === 1) ok("a bid sealed out here decrypts to the right side in there");
  else bad(`round trip read YES→${round.yes}, NO→${round.no}`);
  if (round.replay === "rejected") ok("replay into another market rejected inside the enclave");
  else bad("a sealed bid was accepted for the wrong market");
  if (round.lift === "rejected") ok("lift by another bidder rejected inside the enclave");
  else bad("a sealed bid was accepted for the wrong bidder");
}

// --- 5. The signer the contract will actually accept ------------------------
if (existsSync(BOOK_DEPLOYMENT)) {
  const d = JSON.parse(readFileSync(BOOK_DEPLOYMENT, "utf8"));
  // Derived, not pasted: a wrong selector reverts and would read as drift.
  const selector = toFunctionSelector("function teeSigner() view returns (address)");
  // Asked from INSIDE the container, over the RPC the container is configured
  // with — so this is the answer the handler itself would get, not ours.
  const onChain = inContainer(`
    fetch(process.env.CHAIN_URL, {method:"POST",headers:{"content-type":"application/json"},
      body: JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:${JSON.stringify(d.contracts.sealedBidBook)},
        data:${JSON.stringify(selector)}},"latest"]})})
      .then(r=>r.json()).then(j=>console.log(JSON.stringify({result:j.result,error:j.error})));
  `);
  const addr = onChain.result && onChain.result !== "0x"
    ? `0x${onChain.result.slice(-40)}` : null;
  if (!addr) {
    bad(`could not read teeSigner from ${d.contracts.sealedBidBook}: ${JSON.stringify(onChain.error)}`);
  } else if (addr.toLowerCase() === String(s.teeSigner).toLowerCase()) {
    ok(`the book accepts this enclave's signer ${s.teeSigner}`);
  } else {
    bad(
      `SIGNER DRIFT: book trusts ${addr} but the enclave signs as ${s.teeSigner}\n` +
      `    openMarket would revert with BadSignature and freeze every stake.\n` +
      `    fix: cd molfi-contracts && npx hardhat run scripts/set-tee-signer.ts --network coston2`,
    );
  }
}

console.log(
  failures
    ? `\n  \x1b[31m${failures} check(s) failed\x1b[0m\n`
    : "\n  \x1b[32mThe registered container is running Molfi's confidential handler.\x1b[0m\n",
);
process.exit(failures ? 1 : 0);
