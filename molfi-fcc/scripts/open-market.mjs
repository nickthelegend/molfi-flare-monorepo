#!/usr/bin/env node
/**
 * Settle one sealed book: resolve the market, open it in the enclave, claim.
 *
 *   DEPLOYER_KEY=0x… node scripts/open-market.mjs <marketId>
 *
 * This is the production settlement path, not a demo. `live-sealed-book.mjs`
 * creates a market and drives it end to end; this one operates on a book that
 * already exists — which is what a keeper actually has to do, and what recovers
 * a market whose bids were placed by someone else (from the app, say) and left
 * sealed after close.
 *
 * It holds no enclave key. The sealing key and the opening both come from the
 * running extension over HTTP; the private half never leaves it.
 */
import {
  createPublicClient, createWalletClient, defineChain, formatUnits, getAddress,
  http, recoverAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const D = JSON.parse(readFileSync(`${HERE}../../molfi-contracts/deployments/coston2.json`, "utf8"));
const RPC = process.env.MOLFI_RPC || D.rpc;
const FCC = (process.env.MOLFI_FCC_URL || "http://localhost:6675").replace(/\/$/, "");

const marketId = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(String(marketId))) {
  console.error("usage: DEPLOYER_KEY=0x… node scripts/open-market.mjs <marketId>");
  process.exit(1);
}
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

const BOOK = getAddress(D.contracts.sealedBidBook);
const MARKET = getAddress(D.contracts.molfiMarket);
const FXRP = getAddress(D.fxrp);
const show = (v) => `${formatUnits(v, D.fxrpDecimals)} FXRP`;
const link = (h) => `${D.explorer}/tx/${h}`;

const BOOK_ABI = [
  { type: "function", name: "bookStatus", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bool" }] },
  { type: "function", name: "openMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "openDigest", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "teeSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const MARKET_ABI = [
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
];
const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

/** Estimate rather than reserve a flat ceiling — Coston2 gas is expensive enough
 *  that a 1.5M limit locks up ~1 C2FLR per call. */
async function send(args) {
  const gas = await pub.estimateContractGas({ account: op, ...args });
  const hash = await wallet.writeContract({ ...args, gas: (gas * 13n) / 10n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${args.functionName} · ${link(hash)}`);
  return hash;
}

async function enclave(opCommand, payload = {}) {
  const r = await fetch(`${FCC}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opType: "MOLFI", opCommand, payload }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`enclave ${opCommand}: ${j.error || r.status}`);
  return j.result;
}

const [escrowed, bidCount, opened] = await pub.readContract({
  address: BOOK, abi: BOOK_ABI, functionName: "bookStatus", args: [marketId],
});
console.log(`\n  market ${marketId.slice(0, 18)}…`);
console.log(`  escrowed ${show(escrowed)} across ${bidCount} bid(s) · opened=${opened}`);
if (bidCount === 0) { console.log("  nothing sealed here.\n"); process.exit(0); }

if (!(await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: "isResolved", args: [marketId] }))) {
  console.log("  resolving from FTSOv2…");
  console.log(`  ${link(await send({ address: MARKET, abi: MARKET_ABI, functionName: "resolveFromOracle", args: [marketId] }))}`);
}
const winner = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: "winningOutcome", args: [marketId] });
console.log(`  winning outcome: ${Number(winner) === 0 ? "YES" : "NO"}`);

let result;
if (!opened) {
  result = await enclave("OPEN_BOOK", { marketId });
  const yesPool = BigInt(result.yesPool);
  const noPool = BigInt(result.noPool);
  console.log(`\n  ENCLAVE OPENED: YES ${show(yesPool)} · NO ${show(noPool)}`);
  if (yesPool + noPool !== escrowed) {
    throw new Error(`conservation broken: ${yesPool + noPool} vs escrow ${escrowed}`);
  }

  // Check the signature against the CONTRACT'S digest, not the enclave's own —
  // taking its numbers on faith because it signed something is circular.
  const digest = await pub.readContract({
    address: BOOK, abi: BOOK_ABI, functionName: "openDigest",
    args: [marketId, yesPool, noPool, result.bidCount, result.openingsRoot],
  });
  const expected = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "teeSigner" });
  const recovered = await recoverAddress({ hash: digest, signature: result.signature });
  if (getAddress(recovered) !== getAddress(expected)) {
    throw new Error(`signature recovers to ${recovered}, but the book trusts ${expected}`);
  }
  console.log(`  signed by the enclave the book trusts ✅`);

  console.log(`  ${link(await send({
    address: BOOK, abi: BOOK_ABI, functionName: "openMarket",
    args: [marketId, yesPool, noPool, result.bidCount, result.openingsRoot, result.signature],
  }))}`);
} else {
  // Already open: the openings are still needed for the claim proofs, and the
  // enclave is the only place they come from.
  result = await enclave("OPEN_BOOK", { marketId }).catch(() => null);
  if (!result) { console.log("\n  already opened; the enclave will not re-open it. Nothing to claim from here.\n"); process.exit(0); }
}

let paid = 0n;
for (const o of result.openings.filter((x) => x.side === Number(winner))) {
  const before = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [o.bidder] });
  try {
    const h = await send({
      address: BOOK, abi: BOOK_ABI, functionName: "claim",
      args: [marketId, BigInt(o.index), o.side, o.proof],
    });
    const after = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [o.bidder] });
    paid += after - before;
    console.log(`  bid ${o.index} → ${o.bidder.slice(0, 10)}… claimed ${show(after - before)} · ${link(h)}`);
  } catch (e) {
    // A double claim is expected on a re-run; anything else is worth seeing.
    console.log(`  bid ${o.index} not claimable: ${e.message.split("\n")[0]}`);
  }
}
console.log(`\n  ✅ settled · ${show(paid)} paid out\n`);
