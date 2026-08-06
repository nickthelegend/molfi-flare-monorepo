// Molfi — agent-native CONFIDENTIAL bet on Flare Coston2. No human in the loop.
//
// An autonomous agent spins up a fresh EVM wallet, is funded by the operator,
// generates a Groth16 proof for a HIDDEN side, commits the bet, then — after the
// market resolves from a REAL FTSOv2 BTC/USD feed — claims its winnings by
// proving in zero-knowledge that its note backed the winner. The side never
// touches the chain; the payout is unlinkable to the bet.
//
//   OPERATOR_KEY=0x... node demo/agent-confidential-bet.mjs
//
// The operator must be the ConfidentialBet admin (it checkpoints the Poseidon
// root) and hold enough FXRP to seed the 2x payout — FXRP cannot be minted, so
// top up at https://faucet.flare.network/coston2 first.
import { createPublicClient, createWalletClient, http, defineChain, parseEther, keccak256, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { groth16 } from "snarkjs";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// ── live Coston2 deployment — read from the deploy artifact, never hardcoded ──
// Hardcoding is how this file drifted onto a dead Avalanche deployment in the
// first place; sourcing it from the artifact means a redeploy can't strand it.
const D = JSON.parse(readFileSync(`${HERE}../../molfi-contracts/deployments/coston2.json`, "utf8"));
const MARKET = D.contracts.molfiMarket;
const CBET = D.contracts.confidentialBet;
const FXRP = D.fxrp;
/** FTSOv2 BTC/USD — a bytes21 FEED ID, not a contract address. */
const BTC_USD = D.feeds["BTC/USD"];
/** Fixed stake per note. 6-decimal FXRP, so 1_000_000 == 1 FXRP. */
const DENOM = BigInt(D.confDenom);
const UNIT = 10n ** BigInt(D.fxrpDecimals);
const RPC = process.env.MOLFI_RPC || D.rpc;
const WASM = `${HERE}../../molfi-circuits/build/confidential_bet/confidential_bet_js/confidential_bet.wasm`;
const ZKEY = `${HERE}../../molfi-circuits/build/confidential_bet/final.zkey`;
const explore = (h) => `${D.explorer}/tx/${h}`;
/** Coston2 under-estimates FXRP transfers and FTSO-reading writes; the
 *  resulting out-of-gas carries EMPTY revert data and reads as a rejection. */
const GAS = 1_500_000n;

const OP_KEY = process.env.OPERATOR_KEY;
if (!OP_KEY) { console.error("Set OPERATOR_KEY (deployer/admin/funder)."); process.exit(1); }

const chain = defineChain({
  id: D.chainId,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Coston2 Explorer", url: D.explorer } },
  testnet: true,
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const operator = privateKeyToAccount(OP_KEY);
const opWallet = createWalletClient({ account: operator, chain, transport: http(RPC) });

// FXRP is FAssets-wrapped real XRP — there is no mint().
const FXRP_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const MARKET_ABI = [
  { type: "function", name: "createPriceMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "string" }, { type: "uint64" }, { type: "bytes21" }, { type: "uint256" }, { type: "uint8" }, { type: "uint64" }], outputs: [] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
];
const CBET_ABI = [
  { type: "function", name: "commit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  // Roots are keyed BY MARKET — a root checkpointed for one market is not valid
  // for another, which is what stops a losing note being re-aimed elsewhere.
  { type: "function", name: "registerRoot", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [
      { type: "bytes32" }, { type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }], outputs: [] },
  { type: "function", name: "poolStatus", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
];

const send = async (wallet, args) => {
  const h = await wallet.writeContract({ gas: GAS, ...args });
  const receipt = await pub.waitForTransactionReceipt({ hash: h });
  // A reverted tx still yields a hash and a receipt — reporting it as success is
  // how a demo "passes" while nothing happened on-chain.
  if (receipt.status !== "success") {
    throw new Error(`reverted on-chain: ${args.functionName} · ${explore(h)}`);
  }
  return h;
};
const toSol = (p) => ({
  a: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
  b: [[BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])], [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])]],
  c: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
});
const fxrp = (base) => `${Number(base) / Number(UNIT)} FXRP`;

console.log("\n  🤖 Molfi agent — confidential bet on Flare Coston2 (no human)\n");

// 0) the operator must be able to bankroll the agent AND seed the 2x payout.
//    The agent stakes DENOM and claims DENOM * 2, so the pool needs the extra.
const NEEDED = DENOM * 3n;
const opBal = await pub.readContract({ address: FXRP, abi: FXRP_ABI, functionName: "balanceOf", args: [operator.address] });
if (opBal < NEEDED) {
  console.error(
    `  ✗ operator holds ${fxrp(opBal)}, needs ${fxrp(NEEDED)} ` +
      `(${fxrp(DENOM)} agent stake + ${fxrp(DENOM * 2n)} to cover the 2x payout).\n` +
      `    FXRP is FAssets-wrapped real XRP and has no mint() — request FXRP for\n` +
      `    ${operator.address} at https://faucet.flare.network/coston2 and re-run.\n`,
  );
  process.exit(1);
}

// 1) fresh agent wallet, funded by the operator (gas + FXRP bankroll)
const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const agentWallet = createWalletClient({ account: agent, chain, transport: http(RPC) });
console.log(`  agent wallet: ${agent.address}`);
await send(opWallet, { address: FXRP, abi: FXRP_ABI, functionName: "transfer", args: [agent.address, DENOM] });
const fundTx = await opWallet.sendTransaction({ to: agent.address, value: parseEther("0.5") });
await pub.waitForTransactionReceipt({ hash: fundTx });
console.log(`  funded: 0.5 C2FLR (gas) + ${fxrp(DENOM)} bankroll\n`);

// 2) the agent decides a HIDDEN side and proves it in zero-knowledge
const side = 0; // 0 = YES (hidden — never goes on-chain)
const seed = BigInt(keccak256(toHex(agent.address + Date.now()))) % (2n ** 240n);
const input = {
  secret: String(seed), nullifier: String(seed + 1n), outcome: String(side),
  recipient: BigInt(agent.address).toString(),
  pathElements: ["1", "2", "3", "4", "5", "6", "7", "8"], pathIndices: ["0", "1", "0", "1", "0", "0", "1", "0"],
};
console.log("  generating Groth16 proof for a hidden-side bet…");
const { proof, publicSignals } = await groth16.fullProve(input, WASM, ZKEY);
const root = BigInt(publicSignals[0]); const nullifierHash = BigInt(publicSignals[1]);
const { a, b, c } = toSol(proof);

// 3) commit the bet (escrow denom) — side stays hidden
await send(agentWallet, { address: FXRP, abi: FXRP_ABI, functionName: "approve", args: [CBET, DENOM] });
const commitTx = await send(agentWallet, { address: CBET, abi: CBET_ABI, functionName: "commit", args: [nullifierHash] });
console.log(`  committed hidden bet · ${explore(commitTx)}`);

// 4) operator opens a market on the LIVE FTSOv2 BTC/USD feed + checkpoints root
const mid = keccak256(toHex(`molfi-agent-${agent.address}-${Date.now()}`));
// closeTs must be in the FUTURE (MolfiMarket rejects closeTs <= now); a few seconds
// out, then we wait for it to pass before resolving.
const closeTs = BigInt(Math.floor(Date.now() / 1000) + 30);
// threshold is 18-decimal: FtsoOracle normalizes every feed to PRICE_DECIMALS=18,
// and the market compares against it directly. $50,000 with BTC far above it
// makes YES — the agent's hidden side — the certain winner.
await send(opWallet, { address: MARKET, abi: MARKET_ABI, functionName: "createPriceMarket", args: [mid, "Will BTC/USD be >= $50,000?", closeTs, BTC_USD, 50_000n * 10n ** 18n, 0, 86400n] });
await send(opWallet, { address: CBET, abi: CBET_ABI, functionName: "registerRoot", args: [mid, root] });

// 4b) seed the pool so the 2x claim can be paid. The contract holds only the one
//     committed note (DENOM); claim() needs DENOM * PAYOUT_MULT.
await send(opWallet, { address: FXRP, abi: FXRP_ABI, functionName: "transfer", args: [CBET, DENOM * 2n] });
const [poolBal, covered] = await pub.readContract({ address: CBET, abi: CBET_ABI, functionName: "poolStatus" });
console.log(`  pool seeded: ${fxrp(poolBal)} — covers ${covered} claim(s)`);

// 5) resolve from FTSOv2 (permissionless) — wait until the market has closed
while (BigInt((await pub.getBlock()).timestamp) < closeTs) await new Promise((r) => setTimeout(r, 2000));
const resolveTx = await send(opWallet, { address: MARKET, abi: MARKET_ABI, functionName: "resolveFromOracle", args: [mid] });
const winner = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: "winningOutcome", args: [mid] });
console.log(`  market resolved from FTSOv2 → winner ${winner === 0 ? "YES" : "NO"} · ${explore(resolveTx)}`);

// 6) the agent CLAIMS — proving its hidden side == the winner, unlinkable
const before = await pub.readContract({ address: FXRP, abi: FXRP_ABI, functionName: "balanceOf", args: [agent.address] });
const claimTx = await send(agentWallet, { address: CBET, abi: CBET_ABI, functionName: "claim", args: [mid, a, b, c, root, nullifierHash, agent.address] });
const after = await pub.readContract({ address: FXRP, abi: FXRP_ABI, functionName: "balanceOf", args: [agent.address] });
console.log(`  confidential claim · ${explore(claimTx)}`);
console.log(`\n  payout: ${fxrp(after - before)} (2× denom) — side never revealed on-chain`);
const ok = after - before === DENOM * 2n;
console.log(ok ? "\n  ✅ agent bet privately and won — end to end on Flare\n" : "\n  ✗ payout mismatch\n");
process.exit(ok ? 0 : 1);
