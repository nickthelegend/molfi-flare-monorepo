/**
 * Deploy MolfiLpVault to Coston2 and record it in deployments/coston2.json.
 *
 *   npx hardhat run scripts/deploy-lp-vault.ts --network coston2
 *
 * The vault the app has always shown but never had. Until this existed the
 * "deposit" button transferred FXRP into PredictEscrow, which has no way to
 * credit or return it.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(__dirname, "..", "deployments", "coston2.json");

async function main() {
  const deployments = JSON.parse(readFileSync(FILE, "utf8"));
  const fxrp = deployments.fxrp as string;
  if (!fxrp) throw new Error("no fxrp address in deployments/coston2.json");

  const [signer] = await ethers.getSigners();
  console.log(`deployer  ${signer.address}`);
  console.log(`collateral ${fxrp}`);

  const Vault = await ethers.getContractFactory("MolfiLpVault");
  const vault = await Vault.deploy(fxrp);
  await vault.waitForDeployment();
  const address = await vault.getAddress();

  console.log(`MolfiLpVault deployed → ${address}`);
  console.log(`  asset       ${await vault.asset()}`);
  console.log(`  totalShares ${await vault.totalShares()}`);
  console.log(`  sharePrice  ${await vault.sharePrice()}`);

  deployments.contracts.lpVault = address;
  writeFileSync(FILE, `${JSON.stringify(deployments, null, 2)}\n`);
  console.log(`recorded in ${FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
