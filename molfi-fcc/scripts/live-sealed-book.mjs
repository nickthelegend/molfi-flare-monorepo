/**
 * End-to-end proof on live Coston2: seal a book, open it in the enclave, settle.
 *
 *   DEPLOYER_KEY=0x… node scripts/live-sealed-book.mjs
 *
 * Creates a short market, seals two bids on OPPOSITE sides, shows that the chain
 * reveals only the total while it is live, waits for close, opens the book with
 * the enclave, submits the signed result, and claims the winner with the
 * enclave's own Merkle proof.
 *
 * Needs FXRP for the stakes. Without it the script still proves everything up to
 * the sealing step and says so rather than pretending.
 */
import {
  createPublicClient, createWalletClient, defineChain, http, getAddress, parseUnits, formatUnits,
  keccak256, toHex, recoverAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sealSide } from "../src/seal.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const D = JSON.parse(readFileSync(`${HERE}../../molfi-contracts/deployments/coston2.json`, "utf8"));
const RPC = process.env.MOLFI_RPC || D.rpc;

const KEY = process.env.DEPLOYER_KEY;
if (!KEY) { console.error("Set DEPLOYER_KEY (market admin + funder)."); process.exit(1); }

const chain = defineChain({
  id: D.chainId, name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, testnet: true,
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const op = privateKeyToAccount(KEY);
const opWallet = createWalletClient({ account: op, chain, transport: http(RPC) });

const BOOK = getAddress(D.contracts.sealedBidBook);
const MARKET = getAddress(D.contracts.molfiMarket);
const FXRP = getAddress(D.fxrp);
const unit = 10 ** D.fxrpDecimals;
const fxrp = (n) => parseUnits(String(n), D.fxrpDecimals);
const show = (v) => `${formatUnits(v, D.fxrpDecimals)} FXRP`;
const link = (h) => `${D.explorer}/tx/${h}`;

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
const MARKET_ABI = [
  { type: "function", name: "createPriceMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "string" }, { type: "uint64" }, { type: "bytes21" }, { type: "uint256" }, { type: "uint8" }, { type: "uint64" }], outputs: [] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
];
const BOOK_ABI = [
  { type: "function", name: "sealBid", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "openMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bookStatus", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bool" }] },
  { type: "function", name: "getBid", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] },
  { type: "function", name: "openDigest", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "teeSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setTeeSigner", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
];

/**
 * Estimate gas rather than reserving a flat ceiling.
 *
 * This used to pass a fixed 1_500_000. Coston2 sat at 650 gwei during this run,
 * which turns that ceiling into ~1 C2FLR of *reserved* balance per call — so a
 * bidder funded with 0.6 could not even `approve`, a 46k-gas transaction. The
 * balance check happens against the limit, not the actual cost.
 */
const send = async (wallet, args) => {
  const est = await pub.estimateContractGas({ account: wallet.account, ...args });
  const h = await wallet.writeContract({ gas: (est * 13n) / 10n, ...args });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`reverted: ${args.functionName} · ${link(h)}`);
  return h;
};

console.log("\n  🔒 Molfi sealed-bid book — live on Coston2\n");

/**
 * The REAL enclave, over HTTP.
 *
 * This script deliberately holds no enclave key. Generating one here and
 * pointing the book at it would demo the cryptography while quietly proving
 * nothing about the TEE — the whole claim is that the side is readable only
 * inside Flare Confidential Compute, and a key sitting in this process is the
 * opposite of that. So the sealing key is fetched, the opening is requested,
 * and the private half never exists outside the enclave.
 */
const FCC = (process.env.MOLFI_FCC_URL || "http://localhost:6675").replace(/\/$/, "");
async function enclaveAction(opCommand, payload = {}) {
  const r = await fetch(`${FCC}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opType: "MOLFI", opCommand, payload }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`enclave ${opCommand}: ${j.error || r.status}`);
  return j.result;
}

const identity = await enclaveAction("SEAL_KEY");
console.log(`  enclave        : ${FCC}`);
console.log(`  sealing key    : ${identity.publicKey.slice(0, 26)}…`);
console.log(`  tee signer     : ${identity.teeSigner}`);

// The book must already trust this enclave. Rotating it here would paper over
// exactly the drift that freezes a market at close — see set-tee-signer.ts.
const current = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "teeSigner" });
if (getAddress(current) !== getAddress(identity.teeSigner)) {
  console.error(
    `\n  ✗ the book trusts ${current} but the enclave signs as ${identity.teeSigner}.\n` +
    `    openMarket would revert with BadSignature. Fix it deliberately:\n` +
    `    cd ../molfi-contracts && npx hardhat run scripts/set-tee-signer.ts --network coston2\n`,
  );
  process.exit(1);
}
console.log(`  the book already trusts this enclave ✅\n`);

/**
 * Two bettors, opposite sides — with RECOVERABLE keys.
 *
 * These were `generatePrivateKey()`. When the run died after funding them, the
 * FXRP was gone: real tokens, backed by real XRP, in wallets whose keys existed
 * only in a process that had exited. Deriving them from the operator's key means
 * a failed run is always recoverable, and the addresses are printed so it can be
 * done by hand.
 */
const bidderKey = (n) => keccak256(toHex(`${KEY}:molfi-sealed-bidder:${n}`));
const alice = privateKeyToAccount(bidderKey(0));
const bob = privateKeyToAccount(bidderKey(1));
console.log(`  bidder A ${alice.address}`);
console.log(`  bidder B ${bob.address}  (both derived from DEPLOYER_KEY — recoverable)\n`);
const aliceW = createWalletClient({ account: alice, chain, transport: http(RPC) });
const bobW = createWalletClient({ account: bob, chain, transport: http(RPC) });

const STAKE_A = fxrp(process.env.STAKE_A || 1.5);
const STAKE_B = fxrp(process.env.STAKE_B || 2);
const opFxrp = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [op.address] });
if (opFxrp < STAKE_A + STAKE_B) {
  console.log(`\n  ⚠ operator holds ${show(opFxrp)}, needs ${show(STAKE_A + STAKE_B)} to fund two bidders.`);
  console.log(`    Everything above is live; the sealing steps need FXRP.`);
  console.log(`    Get it from https://faucet.flare.network/coston2 or the FAssets mint.\n`);
  process.exit(0);
}

for (const [w, amt] of [[alice, STAKE_A], [bob, STAKE_B]]) {
  const gasBudget = parseUnits(process.env.GAS_BUDGET || "0.8", 18);
  const have = await pub.getBalance({ address: w.address });
  if (have < gasBudget) {
    await opWallet.sendTransaction({ to: w.address, value: gasBudget - have });
  }
  await send(opWallet, { address: FXRP, abi: ERC20, functionName: "transfer", args: [w.address, amt] });
}
console.log("  funded two bidders\n");

// A market that closes shortly.
const mid = keccak256(toHex(`molfi-sealed-${Date.now()}`));
const closeTs = BigInt(Math.floor(Date.now() / 1000) + 60);
await send(opWallet, {
  address: MARKET, abi: MARKET_ABI, functionName: "createPriceMarket",
  args: [mid, "Will XRP/USD be >= $0.50?", closeTs, D.feeds["XRP/USD"], parseUnits("0.5", 18), 0, 86400n],
});
console.log(`  market ${mid.slice(0, 14)}… closes in 60s`);

// Seal: Alice YES, Bob NO. Neither side is on-chain.
for (const [w, wallet, amt, side] of [[alice, aliceW, STAKE_A, 0], [bob, bobW, STAKE_B, 1]]) {
  await send(wallet, { address: FXRP, abi: ERC20, functionName: "approve", args: [BOOK, amt] });
  const ct = sealSide(identity.publicKey, mid, w.address, side);
  const h = await send(wallet, { address: BOOK, abi: BOOK_ABI, functionName: "sealBid", args: [mid, amt, ct] });
  console.log(`  sealed ${show(amt)} · ${link(h)}`);
}

// What the world can see while it is live.
const [total, count, opened] = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "bookStatus", args: [mid] });
console.log(`\n  PUBLIC VIEW while live: ${show(total)} across ${count} bids, opened=${opened}`);
console.log(`  the YES/NO split is NOT on-chain — the odds do not exist yet\n`);

// Wait for close, then settle the market from FTSOv2.
while (BigInt((await pub.getBlock()).timestamp) < closeTs) await new Promise((r) => setTimeout(r, 3000));
await send(opWallet, { address: MARKET, abi: MARKET_ABI, functionName: "resolveFromOracle", args: [mid] });
const winner = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: "winningOutcome", args: [mid] });
console.log(`  market resolved from FTSOv2 → ${Number(winner) === 0 ? "YES" : "NO"}`);

// Ask the enclave to open it. It reads the bids off chain itself — this script
// sends nothing but the market id, and gets back totals it could not have
// computed without the key it does not have.
const opened_ = await enclaveAction("OPEN_BOOK", { marketId: mid });
const result = {
  yesPool: BigInt(opened_.yesPool),
  noPool: BigInt(opened_.noPool),
  bidCount: opened_.bidCount,
  openingsRoot: opened_.openingsRoot,
  openings: opened_.openings,
};
console.log(`\n  ENCLAVE OPENED: YES ${show(result.yesPool)} · NO ${show(result.noPool)}`);
if (result.yesPool + result.noPool !== total) {
  throw new Error(`conservation broken: ${result.yesPool + result.noPool} vs escrow ${total}`);
}
console.log(`  pools reconcile with the ${show(total)} the contract escrowed ✅`);

// Recompute the digest from the contract, and check the enclave signed THAT.
// Trusting its numbers because it signed something is circular; this closes it.
const onChainDigest = await pub.readContract({
  address: BOOK, abi: BOOK_ABI, functionName: "openDigest",
  args: [mid, result.yesPool, result.noPool, result.bidCount, result.openingsRoot],
});
const recovered = await recoverAddress({ hash: onChainDigest, signature: opened_.signature });
if (getAddress(recovered) !== getAddress(identity.teeSigner)) {
  throw new Error(`signature recovers to ${recovered}, not the enclave ${identity.teeSigner}`);
}
console.log(`  the enclave signed the contract's own digest ✅`);

const openTx = await send(opWallet, {
  address: BOOK, abi: BOOK_ABI, functionName: "openMarket",
  args: [mid, result.yesPool, result.noPool, result.bidCount, result.openingsRoot, opened_.signature],
});
console.log(`  book opened on-chain · ${link(openTx)}`);

// The winner claims with the enclave's proof.
const win = result.openings.find((o) => o.side === Number(winner));
if (!win) {
  console.log("\n  (nobody backed the winning side in this run)\n");
  process.exit(0);
}
const before = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [win.bidder] });
const claimTx = await send(opWallet, {
  address: BOOK, abi: BOOK_ABI, functionName: "claim",
  args: [mid, BigInt(win.index), win.side, win.proof],
});
const after = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [win.bidder] });
console.log(`  winner claimed ${show(after - before)} · ${link(claimTx)}`);
console.log(`\n  ✅ sealed while it mattered, opened only once it could not be abused\n`);
