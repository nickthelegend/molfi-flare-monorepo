/**
 * Deploy SealedBidBook and point it at the enclave's signing key.
 *
 *   TEE_SIGNER=0x… npx hardhat run scripts/deploy-sealed-book.ts --network coston2
 *
 * TEE_SIGNER is the address the FCC extension signs openings with. It is
 * rotatable after the fact (`setTeeSigner`), because rebuilding the extension
 * mints a fresh key — so deploying before the enclave exists is fine, and the
 * deployer is used as a placeholder in that case.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [deployer] = await ethers.getSigners();

  const teeSigner = process.env.TEE_SIGNER || deployer.address;
  if (!process.env.TEE_SIGNER) {
    console.log(
      "  ⚠ TEE_SIGNER unset — using the deployer as a placeholder.\n" +
        "    Run setTeeSigner once the extension reports its key.",
    );
  }

  const Book = await ethers.getContractFactory("SealedBidBook");
  const book = await Book.deploy(
    d.fxrp,
    d.contracts.molfiMarket,
    teeSigner,
    deployer.address, // fee vault, matching PredictEscrow
  );
  await book.waitForDeployment();
  const addr = await book.getAddress();

  console.log(`  ✅ SealedBidBook → ${addr}`);
  console.log(`     market    ${d.contracts.molfiMarket}`);
  console.log(`     teeSigner ${teeSigner}`);

  d.contracts.sealedBidBook = addr;
  d.teeSigner = teeSigner;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`\n  wrote deployments/coston2.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
