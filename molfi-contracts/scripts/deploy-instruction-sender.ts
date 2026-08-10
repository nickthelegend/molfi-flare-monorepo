/**
 * Deploy MolfiInstructionSender — the on-chain door to Molfi's enclave.
 *
 *   npx hardhat run scripts/deploy-instruction-sender.ts --network coston2
 *
 * Deploy is only step one. The registry will not accept instructions from this
 * address until an extension is registered against it, which is a separate tool
 * in the Flare scaffold:
 *
 *   cd $FCE_HOME/tools && set -a && source ../.env && set +a
 *   go run ./cmd/register-extension -a ../config/coston2/deployed-addresses.json \
 *        -c $CHAIN_URL --instructionSender <this address>
 *
 * then `setExtensionId()` here, then re-register the TEE machine under the new
 * extension id. There is no update path — `SetupExtension` mints a NEW id every
 * time — so a new sender always means a new extension and a fresh machine
 * registration.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;
/** FlareTeeManager — the diamond serving both TEE registries on Coston2. */
const FLARE_TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [deployer] = await ethers.getSigners();
  const manager = process.env.FLARE_TEE_MANAGER || d.fcc?.flareTeeManager || FLARE_TEE_MANAGER;

  // Reuse an existing deployment. Redeploying orphans the registered extension:
  // the registry pins ONE sender address per extension id and there is no update
  // path, so a fresh deploy silently becomes an address that can never send.
  const factory = await ethers.getContractFactory("MolfiInstructionSender");
  const existing = d.fcc?.molfiInstructionSender;
  let sender;
  if (existing && process.env.REDEPLOY !== "1") {
    sender = factory.attach(existing);
    console.log(`  reusing MolfiInstructionSender ${existing}`);
  } else {
    sender = await factory.deploy(manager, manager);
    await sender.waitForDeployment();
    console.log(`  ✅ MolfiInstructionSender → ${await sender.getAddress()}`);
  }
  const addr = await sender.getAddress();

  console.log(`     registries ${manager}  (FlareTeeManager serves both)`);
  console.log(`     opType     MOLFI · commands SEAL_KEY, OPEN_BOOK`);

  // Idempotent: if the extension is already registered against this address,
  // cache the id now so the very next call can send.
  try {
    const already = await sender.extensionId().catch(() => 0n);
    if (already && already > 0n) {
      console.log(`     extensionId ${already} (already set)`);
    } else {
      const tx = await sender.setExtensionId();
      await tx.wait();
      console.log(`     extensionId ${await sender.extensionId()}`);
    }
  } catch {
    console.log(
      `     extensionId not set yet — register the extension first, then call setExtensionId()`,
    );
  }

  d.fcc = d.fcc ?? {};
  d.fcc.molfiInstructionSender = addr;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`\n  wrote deployments/coston2.json · deployer ${deployer.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
