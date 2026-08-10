#!/usr/bin/env node
/**
 * Open a sealed book with a signature from Flare's TEE NODE — not from a key we
 * configured.
 *
 *   DEPLOYER_KEY=0x… node scripts/live-tee-open.mjs
 *
 * `live-sealed-book.mjs` proves the sealed-bid mechanics end to end, but the
 * opening it submits is signed by `teeSigner` — a key the extension is handed
 * through its environment. That is the honest soft spot: the integrity checks
 * are real, the identity is one we chose.
 *
 * This uses the other path. tee-node holds an identity key generated inside the
 * node, exposed only as a public key on the proxy's `/info` and usable only
 * through its loopback `/sign`. Nothing outside the container can extract it.
 * `SealedBidBook.openMarketFromTee` verifies under Flare's own
 * TEE_ACTION_RESULT scheme against that address.
 *
 * TWO THINGS THIS RUN ESTABLISHES EMPIRICALLY, because neither is documented:
 *
 *   - The node's address is keccak256(x‖y) of `teeInfo.publicKey`, last 20
 *     bytes. NOT `machineData.initialOwner`, which is the deployer.
 *   - `/sign` signs EIP-191 over keccak256(message) — determined by signing
 *     three messages and finding which recovery is stable across all of them.
 *     So passing abi.encode(PREFIX, chainId, resultHash) as `message` yields
 *     exactly the digest the contract checks.
 */
import { execFileSync } from "node:child_process";
import {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodePacked,
  formatUnits, getAddress, http, keccak256, parseUnits, recoverAddress, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sealSide } from "../src/seal.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const D = JSON.parse(readFileSync(`${HERE}../../molfi-contracts/deployments/coston2.json`, "utf8"));
const RPC = process.env.MOLFI_RPC || D.rpc;
const FCC = (process.env.MOLFI_FCC_URL || "http://localhost:6675").replace(/\/$/, "");
const CONTAINER = process.env.CONTAINER || "molfi-fce-extension-tee-1";
/** bytes32("TEE_ACTION_RESULT") — UTF-8 right-padded, the same literal Solidity
 *  produces. Built by hand: viem's toHex would string-encode the hex digits. */
const PREFIX = `0x${Buffer.from("TEE_ACTION_RESULT", "utf8").toString("hex").padEnd(64, "0")}`;

const KEY = process.env.DEPLOYER_KEY;
if (!KEY) { console.error("set DEPLOYER_KEY"); process.exit(1); }

const chain = defineChain({
  id: D.chainId, name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, testnet: true,
});
/**
 * Coston2's public RPC rate-limits and answers 429 with an HTML error page.
 * viem's default three fast retries burn through in about a second, which is
 * not enough when the shared gateway is busy — so back off further and longer.
 * It costs nothing when the RPC is healthy.
 */
const transport = http(RPC, { retryCount: 8, retryDelay: 1500, timeout: 30_000 });
const pub = createPublicClient({ chain, transport });
const op = privateKeyToAccount(KEY);
const wallet = createWalletClient({ account: op, chain, transport });

const BOOK = getAddress(D.contracts.sealedBidBook);
const MARKET = getAddress(D.contracts.molfiMarket);
const FXRP = getAddress(D.fxrp);
const show = (v) => `${formatUnits(v, D.fxrpDecimals)} FXRP`;
const link = (h) => `${D.explorer}/tx/${h}`;
const fxrp = (n) => parseUnits(String(n), D.fxrpDecimals);

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const MARKET_ABI = [
  { type: "function", name: "createPriceMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "string" }, { type: "uint64" }, { type: "bytes21" }, { type: "uint256" }, { type: "uint8" }, { type: "uint64" }], outputs: [] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
];
const BOOK_ABI = [
  { type: "function", name: "sealBid", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "openMarketFromTee", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bookStatus", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bool" }] },
  { type: "function", name: "teeMachine", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setTeeMachine", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
];

async function send(args) {
  const gas = await pub.estimateContractGas({ account: op, ...args });
  const hash = await wallet.writeContract({ ...args, gas: (gas * 13n) / 10n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${args.functionName} · ${link(hash)}`);
  return hash;
}

async function enclave(opCommand, payload = {}) {
  const r = await fetch(`${FCC}/action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ opType: "MOLFI", opCommand, payload }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`enclave ${opCommand}: ${j.error || r.status}`);
  return j.result;
}

/** Everything that talks to tee-node happens inside the container — its signing
 *  port is loopback-only, which is the point. */
function inContainer(script) {
  return JSON.parse(
    execFileSync("docker", ["exec", CONTAINER, "node", "-e", script], { encoding: "utf8", timeout: 60_000 })
      .trim().split("\n").pop(),
  );
}

const nodeAddress = getAddress(
  inContainer(`
    const { keccak256 } = require("/app/extension/node_modules/viem");
    fetch("http://ext-proxy:6664/info").then(r=>r.json()).then(i=>{
      const {x,y} = i.teeInfo.publicKey;
      console.log(JSON.stringify({ a: "0x"+keccak256("0x"+x.slice(2).padStart(64,"0")+y.slice(2).padStart(64,"0")).slice(-40) }));
    });`).a,
);

/** Ask tee-node to sign, with its own identity key, inside the container. */
function teeSign(messageHex) {
  const sig = inContainer(`
    fetch("http://localhost:7701/sign",{method:"POST",headers:{"content-type":"application/json"},
      body: JSON.stringify({ message: Buffer.from(${JSON.stringify(messageHex)}.slice(2),"hex").toString("base64") })})
      .then(r=>r.json()).then(j=>console.log(JSON.stringify({ s: Buffer.from(j.signature,"base64").toString("hex") })));`).s;
  const b = Buffer.from(sig, "hex");
  // go-ethereum emits the raw recovery id; ecrecover wants 27/28. The library
  // accepts both, but normalise so the local check below matches too.
  if (b[64] < 27) b[64] += 27;
  return `0x${b.toString("hex")}`;
}

console.log(`\n  🔐 opening a book with Flare's TEE NODE identity\n`);
console.log(`  book        ${BOOK}`);
console.log(`  tee node    ${nodeAddress}  (derived from /info publicKey)`);

const onChainMachine = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "teeMachine" });
if (getAddress(onChainMachine) !== nodeAddress) {
  // The node key is regenerated on every container start — no persistence — so
  // the registered machine address goes stale on any restart. Rotatable for
  // exactly this reason.
  console.log(`  book trusts ${onChainMachine} — rotating to the live node`);
  console.log(`  ${link(await send({ address: BOOK, abi: BOOK_ABI, functionName: "setTeeMachine", args: [nodeAddress] }))}`);
}

// ── a real market with a real sealed bid ──────────────────────────────────
const identity = await enclave("SEAL_KEY");
const mid = keccak256(toHex(`molfi-tee-open-${Date.now()}`));
const closeTs = BigInt(Math.floor(Date.now() / 1000) + 90);
await send({
  address: MARKET, abi: MARKET_ABI, functionName: "createPriceMarket",
  args: [mid, "Will XRP/USD be >= $0.50 (TEE-opened)?", closeTs, D.feeds["XRP/USD"], parseUnits("0.5", 18), 0, 86400n],
});
const stake = fxrp(process.env.STAKE || 1);
await send({ address: FXRP, abi: ERC20, functionName: "approve", args: [BOOK, stake] });
await send({
  address: BOOK, abi: BOOK_ABI, functionName: "sealBid",
  args: [mid, stake, sealSide(identity.publicKey, mid, op.address, 0)],
});
const [escrowed, count] = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "bookStatus", args: [mid] });
console.log(`\n  sealed ${show(escrowed)} across ${count} bid(s) — side not on chain`);

// Waiting for a clock to pass is the one step that can always just be retried,
// so a rate-limited read must not end the run.
for (;;) {
  try {
    if (BigInt((await pub.getBlock()).timestamp) >= closeTs) break;
  } catch { /* RPC busy — try again */ }
  await new Promise((r) => setTimeout(r, 3000));
}
await send({ address: MARKET, abi: MARKET_ABI, functionName: "resolveFromOracle", args: [mid] });
const winner = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: "winningOutcome", args: [mid] });
console.log(`  resolved from FTSOv2 → ${Number(winner) === 0 ? "YES" : "NO"}`);

// ── the enclave computes, the NODE authorises ─────────────────────────────
const opened = await enclave("OPEN_BOOK", { marketId: mid });
const yesPool = BigInt(opened.yesPool);
const noPool = BigInt(opened.noPool);
console.log(`\n  ENCLAVE OPENED: YES ${show(yesPool)} · NO ${show(noPool)}`);

const resultData = encodeAbiParameters(
  [{ type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }],
  [BOOK, mid, yesPool, noPool, opened.bidCount, opened.openingsRoot],
);
const actionId = keccak256(toHex(`molfi-open-${mid}`));
const TAG = "threshold";

// ActionResult.Hash() — packed, then the outer payload is abi.encode'd. Passing
// the pre-keccak bytes to /sign is what makes its EIP-191(keccak(message))
// land on exactly the digest the contract recomputes.
const resultHash = keccak256(
  encodePacked(
    ["bytes32", "bytes32", "bytes32", "uint8"],
    [keccak256(resultData), actionId, keccak256(toHex(TAG)), 1],
  ),
);
const message = encodeAbiParameters(
  [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
  [PREFIX, BigInt(D.chainId), resultHash],
);
const signature = teeSign(message);

// Check locally before spending gas: this must recover to the node.
const recovered = await recoverAddress({ hash: keccak256(encodePacked(["string", "bytes32"], ["\x19Ethereum Signed Message:\n32", keccak256(message)])), signature });
if (getAddress(recovered) !== nodeAddress) {
  throw new Error(`signature recovers to ${recovered}, not the node ${nodeAddress}`);
}
console.log(`  signed by the TEE node itself — no key in this process ✅`);

const openTx = await send({
  address: BOOK, abi: BOOK_ABI, functionName: "openMarketFromTee",
  args: [resultData, actionId, TAG, 1, signature],
});
console.log(`  openMarketFromTee accepted · ${link(openTx)}`);

const win = opened.openings.find((o) => o.side === Number(winner));
if (win) {
  const before = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [win.bidder] });
  const h = await send({ address: BOOK, abi: BOOK_ABI, functionName: "claim", args: [mid, BigInt(win.index), win.side, win.proof] });
  const after = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [win.bidder] });
  console.log(`  winner claimed ${show(after - before)} · ${link(h)}`);
}
console.log(`\n  ✅ the registered TEE node authorised this opening, not a key we hold\n`);
