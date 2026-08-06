/**
 * Sweep a throwaway funding wallet into the deployer.
 *
 *   npx hardhat run scripts/sweep-funder.ts --network coston2
 *
 * The Flare faucet rate-limits per address, so a wallet that has already been
 * topped up cannot request again for 24h. Rather than wait, request FXRP to a
 * fresh FUNDER_ADDRESS and run this to move it to DEPLOYER_ADDRESS.
 *
 * Sweeps FXRP in full, then the C2FLR remainder minus a reserve for the gas of
 * the sweep itself. Idempotent: with nothing to move it reports and exits 0.
 */
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;
/** Coston2 under-reports gas on FXRP transfers; the revert carries empty data. */
const FXRP_GAS = { gasLimit: 900_000n };
/** Left behind so the native-value transfer below can pay for itself. */
const GAS_RESERVE = ethers.parseEther("2");

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const funderKey = process.env.FUNDER_PRIVATE_KEY;
  if (!funderKey) throw new Error("set FUNDER_PRIVATE_KEY in molfi-contracts/.env");

  const funder = new ethers.Wallet(funderKey, ethers.provider);
  const to = ethers.getAddress(d.deployer);
  if (funder.address.toLowerCase() === to.toLowerCase()) {
    throw new Error("funder IS the deployer — nothing to sweep");
  }

  console.log(`  from ${funder.address}`);
  console.log(`  to   ${to} (deployer)\n`);

  const fxrp = await ethers.getContractAt("IERC20", d.fxrp, funder);
  const [fxrpBal, gasBal] = await Promise.all([
    fxrp.balanceOf(funder.address),
    ethers.provider.getBalance(funder.address),
  ]);
  const unit = 10 ** Number(d.fxrpDecimals);
  console.log(`  holds ${Number(fxrpBal) / unit} FXRP · ${ethers.formatEther(gasBal)} C2FLR`);

  if (fxrpBal === 0n && gasBal <= GAS_RESERVE) {
    console.log("\n  nothing to sweep yet — fund the funder first.");
    return;
  }

  // FXRP first: it is the reason this wallet exists, and moving it needs gas
  // that the native sweep below would otherwise take.
  if (fxrpBal > 0n) {
    if (gasBal === 0n) {
      throw new Error(
        `funder holds FXRP but 0 C2FLR — it cannot pay for the transfer. ` +
          `Send it a little gas first (the deployer has some).`,
      );
    }
    const tx = await fxrp.transfer(to, fxrpBal, FXRP_GAS);
    const r = await tx.wait();
    if (r?.status !== 1) throw new Error(`FXRP transfer reverted: ${tx.hash}`);
    console.log(`  ✅ swept ${Number(fxrpBal) / unit} FXRP · ${d.explorer}/tx/${tx.hash}`);
  }

  // Then whatever native is left over, keeping a reserve so this tx can pay for
  // itself. A plain transfer is 21k gas; the reserve is deliberately generous
  // because Coston2's gas price is ~650 gwei.
  const remaining = await ethers.provider.getBalance(funder.address);
  if (remaining > GAS_RESERVE) {
    const value = remaining - GAS_RESERVE;
    const tx = await funder.sendTransaction({ to, value });
    const r = await tx.wait();
    if (r?.status !== 1) throw new Error(`C2FLR transfer reverted: ${tx.hash}`);
    console.log(`  ✅ swept ${ethers.formatEther(value)} C2FLR · ${d.explorer}/tx/${tx.hash}`);
  }

  const after = await fxrp.balanceOf(to);
  console.log(`\n  deployer now holds ${Number(after) / unit} FXRP`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
