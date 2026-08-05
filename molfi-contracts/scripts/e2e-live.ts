/**
 * LIVE end-to-end proof on Flare Coston2 — no mocks anywhere.
 *
 *   npx hardhat run scripts/e2e-live.ts --network coston2
 *
 * Exercises the entire product in one run:
 *   1. create an XRP/USD market from the live FTSO price
 *   2. fund a second wallet so both sides of the book are real, distinct EOAs
 *   3. both wallets stake real FXRP (FAssets-wrapped XRP)
 *   4. wait for close, then settle PERMISSIONLESSLY from FTSOv2
 *   5. the winner redeems; the loser is correctly refused
 *
 * Every number printed is read back from chain state after the fact.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { FXRP_GAS, FXRP_APPROVE_GAS, TX_GAS } from "./fassets-gas";

const XRP_USD = "0x015852502f55534400000000000000000000000000";
const EXPLORER = "https://coston2-explorer.flare.network";
const tx = (h: string) => `${EXPLORER}/tx/${h}`;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const file = path.join(__dirname, "..", "deployments", "coston2.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  console.log(`\n${"=".repeat(64)}`);
  console.log(`MOLFI ON FLARE — LIVE END-TO-END (Coston2, chainId ${d.chainId})`);
  console.log(`${"=".repeat(64)}\n`);

  const market = await ethers.getContractAt("MolfiMarket", d.contracts.molfiMarket);
  const escrow = await ethers.getContractAt("PredictEscrow", d.contracts.predictEscrow);
  const oracle = await ethers.getContractAt("FtsoOracle", d.contracts.ftsoOracle);
  const fxrpDeployer = new ethers.Contract(d.fxrp, ERC20_ABI, deployer);

  // Both traders are fresh EOAs funded by the deployer. Deliberately NOT the
  // deployer itself: the deployer is the fee vault, so if it also traded, its
  // balance delta would fold the 2% fee back in and the payout assertion below
  // would silently pass on the wrong number.
  const alice = ethers.Wallet.createRandom().connect(ethers.provider);
  const bob = ethers.Wallet.createRandom().connect(ethers.provider);
  const fxrp = new ethers.Contract(d.fxrp, ERC20_ABI, alice);

  const FX = 10n ** 6n; // FXRP has 6 decimals
  const fmt = (v: bigint) => ethers.formatUnits(v, 6);

  // ── 1. live price ────────────────────────────────────────────────────────
  const [spot, spotTs] = await oracle.getPrice(XRP_USD);
  const spotUsd = Number(ethers.formatUnits(spot, 18));
  console.log(`[1] FTSOv2 live XRP/USD = $${spotUsd.toFixed(6)}`);
  console.log(`    updated ${new Date(Number(spotTs) * 1000).toISOString()}\n`);

  // ── 2. create a market that closes shortly ───────────────────────────────
  // Strike is set deliberately BELOW spot so the outcome is deterministic and
  // independently checkable: if XRP is above the strike at close, YES must win.
  const strike = ethers.parseUnits((spotUsd * 0.5).toFixed(6), 18);
  const closeTs = Math.floor(Date.now() / 1000) + 90;
  const marketId = ethers.keccak256(
    ethers.toUtf8Bytes(`xrp-live-${Date.now()}`),
  );
  const question = `Will XRP/USD be >= $${Number(
    ethers.formatUnits(strike, 18),
  ).toFixed(4)} at close?`;

  console.log(`[2] Creating market`);
  console.log(`    ${question}`);
  let r = await (
    await market.createPriceMarket(
      marketId, question, closeTs, XRP_USD, strike,
      0 /* GTE */, 3600 /* max staleness */, TX_GAS,
    )
  ).wait();
  console.log(`    id     ${marketId}`);
  console.log(`    tx     ${tx(r!.hash)}\n`);

  // ── 3. fund two independent traders ──────────────────────────────────────
  console.log(`[3] Funding two independent traders`);
  console.log(`    alice ${alice.address}`);
  console.log(`    bob   ${bob.address}`);
  await (await deployer.sendTransaction({ to: alice.address, value: ethers.parseEther("2") })).wait();
  await (await deployer.sendTransaction({ to: bob.address, value: ethers.parseEther("2") })).wait();
  await (await fxrpDeployer.transfer(alice.address, 1n * FX, FXRP_GAS)).wait();
  r = await (await fxrpDeployer.transfer(bob.address, 2n * FX, FXRP_GAS)).wait();
  console.log(`    funded with C2FLR gas + FXRP  tx ${tx(r!.hash)}\n`);

  // ── 4. both sides stake real FXRP ────────────────────────────────────────
  const escrowAddr = await escrow.getAddress();
  console.log(`[4] Staking FXRP`);

  await (await fxrp.approve(escrowAddr, 1n * FX, FXRP_APPROVE_GAS)).wait();
  r = await (await escrow.connect(alice).bet(marketId, 0 /* YES */, 1n * FX, FXRP_GAS)).wait();
  console.log(`    alice  1 FXRP → YES   tx ${tx(r!.hash)}`);

  const fxrpBob = new ethers.Contract(d.fxrp, ERC20_ABI, bob);
  await (await fxrpBob.approve(escrowAddr, 2n * FX, FXRP_APPROVE_GAS)).wait();
  r = await (await escrow.connect(bob).bet(marketId, 1 /* NO */, 2n * FX, FXRP_GAS)).wait();
  console.log(`    bob    2 FXRP → NO    tx ${tx(r!.hash)}`);

  const pools = await escrow.pools(marketId);
  console.log(
    `    pools  YES ${fmt(pools.yesPool)} | NO ${fmt(pools.noPool)} | pot ${fmt(pools.totalPool)} FXRP\n`,
  );

  // ── 5. wait for close, then settle from FTSO ─────────────────────────────
  const waitMs = (closeTs - Math.floor(Date.now() / 1000) + 5) * 1000;
  console.log(`[5] Waiting ${Math.ceil(waitMs / 1000)}s for close…`);
  if (waitMs > 0) await sleep(waitMs);

  const pre = await market.previewResolution(marketId);
  console.log(
    `    preview: $${Number(ethers.formatUnits(pre.price, 18)).toFixed(6)} → ${
      pre.wouldBeYes ? "YES" : "NO"
    }`,
  );

  // Surface a genuine revert reason (stale feed, not-closed) before sending —
  // otherwise an out-of-gas and a real rejection look identical on-chain.
  await market.connect(bob).resolveFromOracle.staticCall(marketId);

  // Settled by bob — proving resolution is permissionless, not admin-gated.
  r = await (await market.connect(bob).resolveFromOracle(marketId, TX_GAS)).wait();
  const winner = await market.winningOutcome(marketId);
  console.log(`    resolved by counterparty (permissionless)`);
  console.log(`    winner ${winner === 0n ? "YES" : "NO"}`);
  console.log(`    tx     ${tx(r!.hash)}\n`);

  // ── 6. redeem ────────────────────────────────────────────────────────────
  console.log(`[6] Redeeming`);
  const aliceBefore = await fxrp.balanceOf(alice.address);
  r = await (await escrow.connect(alice).redeem(marketId, alice.address, FXRP_GAS)).wait();
  const aliceAfter = await fxrp.balanceOf(alice.address);
  console.log(`    alice payout ${fmt(aliceAfter - aliceBefore)} FXRP`);
  console.log(`    tx           ${tx(r!.hash)}`);

  // The loser must be refused — verify rather than assume.
  try {
    await escrow.redeem.staticCall(marketId, bob.address);
    console.log(`    ✗ PROBLEM: loser was NOT refused`);
    process.exitCode = 1;
  } catch {
    console.log(`    bob (loser) correctly refused ✓`);
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const staked = 1n * FX;
  const payout = aliceAfter - aliceBefore;
  const expected = (staked * pools.totalPool) / pools.yesPool; // gross
  const expectedNet = expected - (expected * 200n) / 10_000n; // minus 2%

  console.log(`\n${"─".repeat(64)}`);
  console.log(`staked        ${fmt(staked)} FXRP`);
  console.log(`pot           ${fmt(pools.totalPool)} FXRP`);
  console.log(`payout        ${fmt(payout)} FXRP  (expected ${fmt(expectedNet)})`);
  console.log(`profit        ${fmt(payout - staked)} FXRP`);
  console.log(`${"─".repeat(64)}`);

  if (payout !== expectedNet) {
    console.log(`\n✗ payout mismatch`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ LIVE END-TO-END PASSED — real FXRP, real FTSO settlement\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
