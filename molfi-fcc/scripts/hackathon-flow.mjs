#!/usr/bin/env node
/**
 * The whole judge path, in one run, on live Coston2.
 *
 *   DEPLOYER_KEY=0x… node scripts/hackathon-flow.mjs
 *
 * Every piece of Molfi has been proven individually. This proves them in
 * sequence, against the same chain state, so nothing is passing because it was
 * run in a convenient order or against a fixture left over from the last test.
 *
 *   1. FXRP        real FAssets collateral, not a faucet token
 *   2. market      created on MolfiMarket, settled by FTSOv2
 *   3. standard    a public bet through PredictEscrow
 *   4. sealed      a bid whose SIDE is encrypted to the enclave
 *   5. instruction settlement asked for by a transaction, answered by a machine
 *                  the registry chose, signed by an identity Flare attested
 *   6. claim       paid out against the enclave's own Merkle proof
 *   7. web2json    a value from a public JSON API, Merkle-proved by the FDC
 *
 * Steps 5 and 7 are the two that cannot be faked by this script: the opening is
 * authorised by a key held inside the container, and the feed value carries an
 * FDC proof this process could not have produced.
 */
import {
  createPublicClient, createWalletClient, decodeEventLog, defineChain, formatUnits,
  getAddress, http, keccak256, parseUnits, recoverAddress, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sealSide } from "../src/seal.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const D = JSON.parse(readFileSync(`${HERE}../../molfi-contracts/deployments/coston2.json`, "utf8"));
const RPC = process.env.MOLFI_RPC || D.rpc;
const FCC = (process.env.MOLFI_FCC_URL || "http://localhost:6675").replace(/\/$/, "");
const PROXY = (process.env.EXT_PROXY_URL || D.fcc?.extProxyUrl || "").replace(/\/$/, "");
const BACKEND = (process.env.MOLFI_BACKEND || "http://localhost:4100").replace(/\/$/, "");

const KEY = process.env.DEPLOYER_KEY;
if (!KEY) { console.error("set DEPLOYER_KEY"); process.exit(1); }

const chain = defineChain({
  id: D.chainId, name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, testnet: true,
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const op = privateKeyToAccount(KEY);
const wallet = createWalletClient({ account: op, chain, transport: http(RPC) });

const MARKET = getAddress(D.contracts.molfiMarket);
const ESCROW = getAddress(D.contracts.predictEscrow);
const BOOK = getAddress(D.contracts.sealedBidBook);
const SENDER = getAddress(D.fcc.molfiInstructionSender);
const FXRP = getAddress(D.fxrp);
const fxrp = (n) => parseUnits(String(n), D.fxrpDecimals);
const show = (v) => `${formatUnits(v, D.fxrpDecimals)} FXRP`;
const link = (h) => `${D.explorer}/tx/${h}`;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { failures++; console.error(`  \x1b[31m✗\x1b[0m ${m}`); };
const step = (n, t) => console.log(`\n\x1b[36m${n}. ${t}\x1b[0m`);

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const MARKET_ABI = [
  { type: "function", name: "createPriceMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "string" }, { type: "uint64" }, { type: "bytes21" }, { type: "uint256" }, { type: "uint8" }, { type: "uint64" }], outputs: [] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "getMarket", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "string" }, { type: "uint64" }, { type: "uint8" }, { type: "uint32" }] },
];
const ESCROW_ABI = [
  { type: "function", name: "bet", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "pools", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  // (marketId, bettor) — redeem is callable FOR someone, not only by them.
  { type: "function", name: "redeem", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
];
const BOOK_ABI = [
  { type: "function", name: "sealBid", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bookStatus", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bool" }] },
  { type: "function", name: "openMarketFromTee", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "teeMachine", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const SENDER_ABI = [
  { type: "function", name: "sendOpenBook", stateMutability: "payable", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "event", name: "OpenBookRequested", inputs: [
    { name: "instructionId", type: "bytes32", indexed: true },
    { name: "marketId", type: "bytes32", indexed: true },
    { name: "requester", type: "address", indexed: true }] },
];

async function send(args, value) {
  const gas = await pub.estimateContractGas({ account: op, ...args, ...(value !== undefined ? { value } : {}) });
  const hash = await wallet.writeContract({ ...args, ...(value !== undefined ? { value } : {}), gas: (gas * 13n) / 10n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${args.functionName} · ${link(hash)}`);
  return { hash, receipt: r };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function enclave(opCommand, payload = {}) {
  const r = await fetch(`${FCC}/action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ opType: "MOLFI", opCommand, payload }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`enclave ${opCommand}: ${j.error || r.status}`);
  return j.result;
}

console.log(`\n\x1b[1m  MOLFI — full flow on Coston2\x1b[0m`);
console.log(`  operator ${op.address}`);

// ── 1 ──────────────────────────────────────────────────────────────────────
step(1, "FXRP — real FAssets collateral");
const startFxrp = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [op.address] });
const mint = JSON.parse(readFileSync(`${HERE}../../molfi-contracts/deployments/fassets-mint.json`, "utf8"));
ok(`holding ${show(startFxrp)} · minted via FAssets, XRPL ${mint.xrplTxHash.slice(0, 12)}… FDC round ${mint.votingRoundId}`);
if (startFxrp < fxrp(2)) bad(`need at least 2 FXRP to run the flow`);

// ── 2 ──────────────────────────────────────────────────────────────────────
step(2, "market — created on MolfiMarket, settled by FTSOv2");
const CLOSE_IN = Number(process.env.CLOSE_IN || 90);
const mid = keccak256(toHex(`molfi-flow-${Date.now()}`));
const closeTs = BigInt(Math.floor(Date.now() / 1000) + CLOSE_IN);
await send({ address: MARKET, abi: MARKET_ABI, functionName: "createPriceMarket",
  args: [mid, "Will XRP/USD be >= $0.50?", closeTs, D.feeds["XRP/USD"], parseUnits("0.5", 18), 0, 86400n] });
ok(`market ${mid.slice(0, 14)}… closes in ${CLOSE_IN}s · feed XRP/USD`);

// ── 3 ──────────────────────────────────────────────────────────────────────
step(3, "standard bet — public, through PredictEscrow");
const stakePublic = fxrp(0.5);
await send({ address: FXRP, abi: ERC20, functionName: "approve", args: [ESCROW, stakePublic] });
const betTx = await send({ address: ESCROW, abi: ESCROW_ABI, functionName: "bet", args: [mid, 0, stakePublic] });
const [yesPub, noPub] = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "pools", args: [mid] });
ok(`bet ${show(stakePublic)} YES · pools now YES ${show(yesPub)} / NO ${show(noPub)} — fully public`);
console.log(`    ${link(betTx.hash)}`);

// ── 4 ──────────────────────────────────────────────────────────────────────
step(4, "sealed bid — the side is encrypted to the enclave");
const identity = await enclave("SEAL_KEY");
const stakeSealed = fxrp(1);
await send({ address: FXRP, abi: ERC20, functionName: "approve", args: [BOOK, stakeSealed] });
const sealTx = await send({ address: BOOK, abi: BOOK_ABI, functionName: "sealBid",
  args: [mid, stakeSealed, sealSide(identity.publicKey, mid, op.address, 0)] });
const [escrowed, bidCount, opened] = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "bookStatus", args: [mid] });
ok(`sealed ${show(escrowed)} across ${bidCount} bid(s) · opened=${opened}`);
console.log(`    ${link(sealTx.hash)}`);

// The claim the product makes: the chain shows the stake, never the side.
const leaked = await enclave("OPENINGS", { marketId: mid }).then(() => true).catch(() => false);
if (leaked) bad("THE ENCLAVE OPENED A LIVE MARKET — the split is readable before close");
else ok("the enclave refuses to open a live market — the split does not exist on-chain yet");

// ── wait for close ─────────────────────────────────────────────────────────
process.stdout.write(`\n  waiting for close`);
for (;;) {
  const now = (await pub.getBlock()).timestamp;
  if (now >= closeTs) break;
  process.stdout.write(".");
  await sleep(Math.min(15_000, (Number(closeTs - now) + 3) * 1000));
}
console.log();
await send({ address: MARKET, abi: MARKET_ABI, functionName: "resolveFromOracle", args: [mid] });
const winner = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: "winningOutcome", args: [mid] });
ok(`resolved from FTSOv2 → ${Number(winner) === 0 ? "YES" : "NO"}`);

// ── 5 ──────────────────────────────────────────────────────────────────────
step(5, "settlement asked for by a TRANSACTION");
const fee = BigInt(process.env.INSTRUCTION_FEE ?? parseUnits("0.01", 18));
const req = await send({ address: SENDER, abi: SENDER_ABI, functionName: "sendOpenBook", args: [mid] }, fee);
let instructionId = null;
for (const log of req.receipt.logs) {
  try {
    const dec = decodeEventLog({ abi: SENDER_ABI, topics: log.topics, data: log.data });
    if (dec.eventName === "OpenBookRequested") instructionId = dec.args.instructionId;
  } catch { /* not ours */ }
}
if (!instructionId) { bad("no OpenBookRequested emitted"); process.exit(1); }
ok(`instruction ${instructionId.slice(0, 18)}… on-chain · ${link(req.hash)}`);

process.stdout.write("  waiting for a machine the REGISTRY chose to answer");
let action = null;
for (let i = 0; i < 60 && !action; i++) {
  await sleep(5000);
  process.stdout.write(".");
  const res = await fetch(`${PROXY}/action/result/${instructionId}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res?.ok) continue;
  const body = await res.json().catch(() => null);
  if (body?.result?.data && body.result.data !== "0x" && body?.signature) action = body;
}
console.log();
if (!action) { bad(`no usable result for ${instructionId}`); process.exit(1); }
ok(`answered · status ${action.result.status} · tag "${action.result.submissionTag}"`);

const machine = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "teeMachine" });
const openTx = await send({ address: BOOK, abi: BOOK_ABI, functionName: "openMarketFromTee",
  args: [action.result.data, action.result.id, action.result.submissionTag, action.result.status, action.signature] });
ok(`opened under the TEE machine's own signature (${machine.slice(0, 12)}…) · ${link(openTx.hash)}`);

// ── 6 ──────────────────────────────────────────────────────────────────────
step(6, "claims — sealed via the enclave's Merkle proof, public via the escrow");
const openings = await enclave("OPENINGS", { marketId: mid });
ok(`enclave publishes the split only now: YES ${show(BigInt(openings.yesPool))} / NO ${show(BigInt(openings.noPool))}`);

let paid = 0n;
for (const o of openings.openings.filter((x) => x.side === Number(winner))) {
  const before = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [o.bidder] });
  const { hash } = await send({ address: BOOK, abi: BOOK_ABI, functionName: "claim", args: [mid, BigInt(o.index), o.side, o.proof] });
  const after = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [o.bidder] });
  paid += after - before;
  ok(`sealed bid ${o.index} claimed ${show(after - before)} · ${link(hash)}`);
}
try {
  const before = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [op.address] });
  const { hash } = await send({ address: ESCROW, abi: ESCROW_ABI, functionName: "redeem", args: [mid, op.address] });
  const after = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [op.address] });
  paid += after - before;
  ok(`public bet redeemed ${show(after - before)} · ${link(hash)}`);
} catch (e) {
  bad(`escrow redeem: ${e.message.split("\n")[0]}`);
}

// ── 7 ──────────────────────────────────────────────────────────────────────
step(7, "Web2Json — a value FTSO has no feed for, Merkle-proved by the FDC");
const feeds = await fetch(`${BACKEND}/api/web2/feeds`, { signal: AbortSignal.timeout(60_000) })
  .then((r) => r.json()).catch(() => null);
const feed = feeds?.feeds?.[0];
if (feed?.observation) {
  ok(`${feed.label} = ${feed.observation.value} · FDC round ${feed.observation.votingRound}`);
  ok(`bound to ${feed.source} by request hash ${feed.requestHash.slice(0, 14)}…`);
} else {
  bad(`no Web2Json observation on-chain (${feeds?.error ?? "backend unreachable"})`);
}

const endFxrp = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [op.address] });
console.log(`\n  FXRP ${show(startFxrp)} → ${show(endFxrp)} · claimed back ${show(paid)}`);
console.log(
  failures
    ? `\n  \x1b[31m${failures} step(s) failed\x1b[0m\n`
    : `\n  \x1b[32mEvery stage ran on live Coston2, in one pass.\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
