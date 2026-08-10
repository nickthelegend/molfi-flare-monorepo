#!/usr/bin/env node
/**
 * Settle a sealed market entirely through Flare's on-chain instruction pipeline.
 *
 *   DEPLOYER_KEY=0x… node scripts/live-instruction-open.mjs <marketId>
 *
 * The other two openers ask the enclave over HTTP. This one never talks to it:
 *
 *   sendOpenBook(marketId)              a transaction, on the public record
 *        │
 *        ▼  Flare's data providers pick it up and route it
 *   TeeExtensionRegistry → a TEE machine the REGISTRY chose
 *        │
 *        ▼  tee-node calls the extension, signs its ActionResult
 *   GET {proxy}/action/result/{instructionId}
 *        │
 *        ▼
 *   openMarketFromTee(data, actionId, tag, status, signature)
 *
 * Nothing in that chain depends on our server being honest, or up. The request
 * is attributable, the machine is not ours to choose, and the answer is signed
 * by an identity Flare attested. That is the difference between "we ran a TEE"
 * and "the network ran it for us".
 */
import {
  createPublicClient, createWalletClient, decodeEventLog, defineChain, formatUnits,
  getAddress, http, parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const D = JSON.parse(readFileSync(`${HERE}../../molfi-contracts/deployments/coston2.json`, "utf8"));
const RPC = process.env.MOLFI_RPC || D.rpc;
/** The extension proxy's PUBLIC url — the same one registered on-chain. */
const PROXY = (process.env.EXT_PROXY_URL || D.fcc?.extProxyUrl || "http://localhost:6674").replace(/\/$/, "");

const marketId = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(String(marketId))) {
  console.error("usage: DEPLOYER_KEY=0x… node scripts/live-instruction-open.mjs <marketId>");
  process.exit(1);
}
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

const SENDER = getAddress(D.fcc.molfiInstructionSender);
const BOOK = getAddress(D.contracts.sealedBidBook);
const MARKET = getAddress(D.contracts.molfiMarket);
const FXRP = getAddress(D.fxrp);
const show = (v) => `${formatUnits(v, D.fxrpDecimals)} FXRP`;
const link = (h) => `${D.explorer}/tx/${h}`;

const SENDER_ABI = [
  { type: "function", name: "sendOpenBook", stateMutability: "payable", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "extensionId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event", name: "OpenBookRequested",
    inputs: [
      { name: "instructionId", type: "bytes32", indexed: true },
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "requester", type: "address", indexed: true },
    ],
  },
];
const BOOK_ABI = [
  { type: "function", name: "bookStatus", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bool" }] },
  { type: "function", name: "openMarketFromTee", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "teeMachine", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const MARKET_ABI = [
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
];
const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

async function send(args, value) {
  let gas;
  try {
    gas = await pub.estimateContractGas({ account: op, ...args, ...(value !== undefined ? { value } : {}) });
  } catch (e) {
    // The registry charges a per-instruction fee and reverts FeeTooLow at zero.
    // Say so plainly rather than surfacing a bare "execution reverted".
    if (/FeeTooLow|0x732f9413/.test(String(e.message))) {
      throw new Error(
        `the registry rejected the fee. Raise it with INSTRUCTION_FEE (wei); current ${value ?? 0n}`,
      );
    }
    throw e;
  }
  const hash = await wallet.writeContract({ ...args, ...(value !== undefined ? { value } : {}), gas: (gas * 13n) / 10n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${args.functionName} · ${link(hash)}`);
  return { hash, receipt: r };
}

console.log(`\n  ⛓  settling through the on-chain instruction pipeline\n`);
console.log(`  sender  ${SENDER} (extension ${await pub.readContract({ address: SENDER, abi: SENDER_ABI, functionName: "extensionId" })})`);
console.log(`  proxy   ${PROXY}`);

const [escrowed, bidCount, opened] = await pub.readContract({
  address: BOOK, abi: BOOK_ABI, functionName: "bookStatus", args: [marketId],
});
console.log(`  book    ${show(escrowed)} across ${bidCount} bid(s) · opened=${opened}`);
if (bidCount === 0) { console.log("\n  nothing sealed here.\n"); process.exit(0); }
if (opened) { console.log("\n  already opened.\n"); process.exit(0); }

if (!(await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: "isResolved", args: [marketId] }))) {
  console.log(`  resolving from FTSOv2…`);
  console.log(`  ${link((await send({ address: MARKET, abi: MARKET_ABI, functionName: "resolveFromOracle", args: [marketId] })).hash)}`);
}
const winner = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: "winningOutcome", args: [marketId] });

// ── 1. Ask, on-chain ───────────────────────────────────────────────────────
const fee = BigInt(process.env.INSTRUCTION_FEE ?? parseUnits("0.01", 18));
const { hash: reqHash, receipt } = await send(
  { address: SENDER, abi: SENDER_ABI, functionName: "sendOpenBook", args: [marketId] },
  fee,
);
// The instruction id is what the proxy keys the result by. Read it from our own
// event rather than guessing at the registry's return value.
let instructionId = null;
for (const log of receipt.logs) {
  try {
    const d = decodeEventLog({ abi: SENDER_ABI, topics: log.topics, data: log.data });
    if (d.eventName === "OpenBookRequested") instructionId = d.args.instructionId;
  } catch { /* not ours */ }
}
if (!instructionId) throw new Error(`no OpenBookRequested in ${reqHash}`);
console.log(`\n  requested on-chain · instruction ${instructionId}`);
console.log(`  ${link(reqHash)}`);

// ── 2. Wait for a machine the REGISTRY chose to answer ─────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let action = null;
process.stdout.write("  waiting for a TEE machine to answer");
for (let i = 0; i < 60; i++) {
  await sleep(5000);
  process.stdout.write(".");
  const res = await fetch(`${PROXY}/action/result/${instructionId}`, {
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) continue;
  const body = await res.json().catch(() => null);
  if (body?.result?.data && body?.signature) { action = body; break; }
}
console.log();
if (!action) {
  throw new Error(
    `no result for ${instructionId} after 5 minutes.\n` +
      `  The instruction IS on-chain (${reqHash}); check that the machine is ACTIVE for this\n` +
      `  extension and reachable at its registered URL.`,
  );
}

const { result, signature } = action;
console.log(`  answered · status ${result.status} · tag "${result.submissionTag}"`);

// ── 3. Hand the signed result to the book ──────────────────────────────────
// tee-node signed `result.data` with the node's attested identity; the contract
// re-derives the same digest and checks it against `teeMachine`.
const machine = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "teeMachine" });
console.log(`  book trusts machine ${machine}`);

const { hash: openHash } = await send({
  address: BOOK, abi: BOOK_ABI, functionName: "openMarketFromTee",
  args: [result.data, result.id, result.submissionTag, result.status, signature],
});
console.log(`  openMarketFromTee accepted · ${link(openHash)}`);

// ── 4. Winners claim, using proofs from the enclave's OPENINGS ─────────────
const FCC = (process.env.MOLFI_FCC_URL || "http://localhost:6675").replace(/\/$/, "");
const openings = await fetch(`${FCC}/action`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ opType: "MOLFI", opCommand: "OPENINGS", payload: { marketId } }),
}).then((r) => r.json()).then((j) => j.result?.openings ?? []).catch(() => []);

let paid = 0n;
for (const o of openings.filter((x) => x.side === Number(winner))) {
  const before = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [o.bidder] });
  try {
    const { hash } = await send({
      address: BOOK, abi: BOOK_ABI, functionName: "claim",
      args: [marketId, BigInt(o.index), o.side, o.proof],
    });
    const after = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [o.bidder] });
    paid += after - before;
    console.log(`  bid ${o.index} claimed ${show(after - before)} · ${link(hash)}`);
  } catch (e) {
    console.log(`  bid ${o.index} not claimable: ${e.message.split("\n")[0]}`);
  }
}

console.log(`\n  ✅ opened by a machine the registry chose, on a request anyone can see · ${show(paid)} paid\n`);
