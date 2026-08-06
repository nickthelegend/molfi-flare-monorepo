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
  keccak256, toHex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enclaveKeypair, sealSide } from "../src/seal.mjs";
import { openBook, openDigest } from "../src/open-book.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const D = JSON.parse(readFileSync(`${HERE}../../molfi-contracts/deployments/coston2.json`, "utf8"));
const RPC = process.env.MOLFI_RPC || D.rpc;
const GAS = 1_500_000n;

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

const send = async (wallet, args) => {
  const h = await wallet.writeContract({ gas: GAS, ...args });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`reverted: ${args.functionName} · ${link(h)}`);
  return h;
};

console.log("\n  🔒 Molfi sealed-bid book — live on Coston2\n");

// The enclave. In production this key is generated inside the TEE and never
// leaves it; here it is generated in-process so the run is self-contained.
const enclave = enclaveKeypair();
const teeSignerKey = generatePrivateKey();
const teeSigner = privateKeyToAccount(teeSignerKey);
console.log(`  enclave pubkey : ${enclave.publicKey.slice(0, 26)}…`);
console.log(`  tee signer     : ${teeSigner.address}`);

// Point the book at this run's enclave key.
const current = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "teeSigner" });
if (getAddress(current) !== getAddress(teeSigner.address)) {
  await send(opWallet, { address: BOOK, abi: BOOK_ABI, functionName: "setTeeSigner", args: [teeSigner.address] });
  console.log(`  registered the enclave key on the book\n`);
}

// Two bettors, opposite sides.
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const aliceW = createWalletClient({ account: alice, chain, transport: http(RPC) });
const bobW = createWalletClient({ account: bob, chain, transport: http(RPC) });

const STAKE_A = fxrp(2);
const STAKE_B = fxrp(3);
const opFxrp = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [op.address] });
if (opFxrp < STAKE_A + STAKE_B) {
  console.log(`\n  ⚠ operator holds ${show(opFxrp)}, needs ${show(STAKE_A + STAKE_B)} to fund two bidders.`);
  console.log(`    Everything above is live; the sealing steps need FXRP.`);
  console.log(`    Get it from https://faucet.flare.network/coston2 or the FAssets mint.\n`);
  process.exit(0);
}

for (const [w, amt] of [[alice, STAKE_A], [bob, STAKE_B]]) {
  await opWallet.sendTransaction({ to: w.address, value: parseUnits("0.6", 18) });
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
  const ct = sealSide(enclave.publicKey, mid, w.address, side);
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

// The enclave opens the book.
const bids = [];
for (let i = 0n; i < count; i++) {
  const [bidder, amount, ciphertext] = await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "getBid", args: [mid, i] });
  bids.push({ bidder, amount, ciphertext });
}
const result = openBook(enclave.privateKey, mid, bids);
console.log(`\n  ENCLAVE OPENED: YES ${show(result.yesPool)} · NO ${show(result.noPool)}`);

const digest = openDigest({
  chainId: D.chainId, book: BOOK, marketId: mid,
  yesPool: result.yesPool, noPool: result.noPool,
  bidCount: result.bidCount, openingsRoot: result.openingsRoot,
});
const onChainDigest = await pub.readContract({
  address: BOOK, abi: BOOK_ABI, functionName: "openDigest",
  args: [mid, result.yesPool, result.noPool, result.bidCount, result.openingsRoot],
});
if (digest !== onChainDigest) throw new Error("enclave/contract digest mismatch");
console.log(`  digest matches the contract's ✅`);

const signature = await teeSigner.sign({ hash: digest });
const openTx = await send(opWallet, {
  address: BOOK, abi: BOOK_ABI, functionName: "openMarket",
  args: [mid, result.yesPool, result.noPool, result.bidCount, result.openingsRoot, signature],
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
  args: [mid, BigInt(win.index), win.side, result.proofFor(win.index)],
});
const after = await pub.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [win.bidder] });
console.log(`  winner claimed ${show(after - before)} · ${link(claimTx)}`);
console.log(`\n  ✅ sealed while it mattered, opened only once it could not be abused\n`);
