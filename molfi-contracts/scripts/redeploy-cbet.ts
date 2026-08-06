/**
 * Redeploy ConfidentialBet alone, with denomination tiers.
 *
 *   npx hardhat run scripts/redeploy-cbet.ts --network coston2
 *
 * The tier ladder is fixed at construction — adding one later would split an
 * existing anonymity set — so changing it means a new contract. Nothing else
 * moves: MolfiMarket keeps its markets and history, PredictEscrow keeps the
 * open bets, and the verifier is reused because the circuit did not change.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;
const CONF_DENOMS = [1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n];

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [deployer] = await ethers.getSigners();
  console.log(`  deployer ${deployer.address}\n`);

  const old = d.contracts.confidentialBet;
  const fxrp = await ethers.getContractAt("IERC20", d.fxrp, deployer);
  const stranded = await fxrp.balanceOf(old);
  if (stranded > 0n) {
    // Committed notes live in the old contract and can only be claimed there.
    console.log(
      `  ⚠ old ConfidentialBet still holds ${Number(stranded) / 1e6} FXRP — ` +
        `those notes remain claimable at ${old}.`,
    );
  }

  const C = await ethers.getContractFactory("ConfidentialBet");
  const cbet = await C.deploy(
    d.fxrp,
    d.contracts.confidentialBetVerifier, // unchanged: same circuit, same key
    d.contracts.molfiMarket,
    CONF_DENOMS,
  );
  await cbet.waitForDeployment();
  const addr = await cbet.getAddress();

  const denoms = await cbet.denoms();
  console.log(`  ✅ ConfidentialBet → ${addr}`);
  console.log(`     tiers: ${denoms.map((x: bigint) => `${Number(x) / 1e6} FXRP`).join(" · ")}`);

  d.contracts.confidentialBet = addr;
  d.confDenoms = CONF_DENOMS.map((x) => x.toString());
  d.confDenom = CONF_DENOMS[0].toString();
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`\n  wrote deployments/coston2.json`);
  console.log(`  propagate confidentialBet=${addr} to app/backend/sdk/mcp config.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
