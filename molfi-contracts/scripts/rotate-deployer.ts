/**
 * Rotate the deployer: hand the whole system over to a fresh address.
 *
 *   PRIVATE_KEY=<OLD deployer>  TRADER_PRIVATE_KEY=<NEW deployer>
 *   npx hardhat run scripts/rotate-deployer.ts --network coston2
 *
 * Three of the four privileged hooks are transferable in place; the fourth is
 * not, which is why this script also redeploys one contract:
 *
 *   MolfiMarket.admin      transferAdmin()  — creates markets, admin fallback resolve
 *   ConfidentialBet.admin  transferAdmin()  — checkpoints Poseidon roots
 *   FtsoOracle             no admin         — fully permissionless, nothing to move
 *   PredictEscrow.vault    IMMUTABLE        — the 2% fee recipient, fixed at deploy
 *
 * So PredictEscrow is redeployed with `vault` = the new deployer. That is only
 * safe because it holds no collateral; the script refuses to run otherwise
 * rather than strand someone's stake at an address the app no longer reads.
 *
 * MolfiMarket is deliberately NOT redeployed — its markets (and their history)
 * live there, and admin moves without touching them.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;
/** Coston2 under-reports gas on FXRP/FTSO paths; the revert has empty data. */
const TX_GAS = { gasLimit: 1_500_000n };
const GAS_TOPUP = ethers.parseEther("30");

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [oldDeployer] = await ethers.getSigners();

  const newKey = process.env.TRADER_PRIVATE_KEY;
  if (!newKey) throw new Error("set TRADER_PRIVATE_KEY to the incoming deployer key");
  const incoming = new ethers.Wallet(newKey, ethers.provider);

  console.log(`  from: ${oldDeployer.address}`);
  console.log(`  to:   ${incoming.address}\n`);
  if (oldDeployer.address.toLowerCase() === incoming.address.toLowerCase()) {
    throw new Error("already the deployer — nothing to rotate");
  }

  // ── 0. gas ────────────────────────────────────────────────────────────────
  // From the outgoing deployer, not the faucet: it already holds C2FLR, and the
  // faucet's per-address cooldown is the reason we are rotating at all.
  const incomingGas = await ethers.provider.getBalance(incoming.address);
  if (incomingGas < ethers.parseEther("5")) {
    const tx = await oldDeployer.sendTransaction({ to: incoming.address, value: GAS_TOPUP });
    await tx.wait();
    console.log(`  ⛽ sent ${ethers.formatEther(GAS_TOPUP)} C2FLR for gas`);
  } else {
    console.log(`  ⛽ already funded (${ethers.formatEther(incomingGas)} C2FLR)`);
  }

  // ── 1. transferable admins ────────────────────────────────────────────────
  for (const [name, addr] of [
    ["MolfiMarket", d.contracts.molfiMarket],
    ["ConfidentialBet", d.contracts.confidentialBet],
  ] as const) {
    const c = await ethers.getContractAt(name, addr, oldDeployer);
    const current = await c.admin();
    if (current.toLowerCase() === incoming.address.toLowerCase()) {
      console.log(`  ✓ ${name} admin already ${incoming.address}`);
      continue;
    }
    const tx = await c.transferAdmin(incoming.address, TX_GAS);
    const r = await tx.wait();
    if (r?.status !== 1) throw new Error(`${name}.transferAdmin reverted`);
    console.log(`  ✅ ${name}.admin → ${incoming.address}`);
  }

  // ── 2. PredictEscrow — immutable vault, so redeploy from the new key ───────
  const fxrp = await ethers.getContractAt("IERC20", d.fxrp, oldDeployer);
  const held = await fxrp.balanceOf(d.contracts.predictEscrow);
  if (held > 0n) {
    throw new Error(
      `PredictEscrow holds ${held} FXRP base units — redeploying would strand it. ` +
        `Resolve open markets and let bettors redeem first.`,
    );
  }

  const Escrow = await ethers.getContractFactory("PredictEscrow", incoming);
  const escrow = await Escrow.deploy(
    d.fxrp,
    d.contracts.confidentialBetVerifier,
    d.contracts.molfiMarket,
    incoming.address, // vault = fee recipient
  );
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log(`  ✅ PredictEscrow redeployed → ${escrowAddr} (vault = new deployer)`);

  // ── 3. persist ────────────────────────────────────────────────────────────
  d.deployer = incoming.address;
  d.contracts.predictEscrow = escrowAddr;
  d.rotatedAt = new Date().toISOString();
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`\n  wrote deployments/coston2.json`);
  console.log(`  NOTE: propagate predictEscrow=${escrowAddr} to app/backend/sdk/mcp config.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
