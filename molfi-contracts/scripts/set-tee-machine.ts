/**
 * Point SealedBidBook at the registered TEE machine.
 *
 *   npx hardhat run scripts/set-tee-machine.ts --network coston2
 *   TEE_MACHINE=0x… npx hardhat run scripts/set-tee-machine.ts --network coston2
 *
 * The companion to set-tee-signer.ts, for the other authorisation path.
 * `openMarketFromTee` trusts this address, and it changes on every container
 * restart — tee-node generates its identity key fresh with no persistence — so
 * this is routine, not exceptional.
 *
 * Defaults to whichever machine is ACTIVE for the extension rather than a
 * pasted address: a machine that is registered but not active cannot answer an
 * instruction, and pinning the book to one would be silently unsettleable.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;

const REGISTRY_ABI = [
  "function getActiveTeeMachines(uint256 _extensionId) view returns (address[])",
  "function getTeeMachineStatus(address) view returns (uint8)",
];
const BOOK_ABI = [
  "function teeMachine() view returns (address)",
  "function setTeeMachine(address next) external",
  "function admin() view returns (address)",
];

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [admin] = await ethers.getSigners();
  const registry = new ethers.Contract(d.fcc.flareTeeManager, REGISTRY_ABI, admin);
  const book = new ethers.Contract(d.contracts.sealedBidBook, BOOK_ABI, admin);

  let next = process.env.TEE_MACHINE;
  if (!next) {
    const active: string[] = await registry.getActiveTeeMachines(d.fcc.extensionIdDecimal);
    if (active.length === 0) {
      throw new Error(
        `no ACTIVE machine for extension ${d.fcc.extensionIdDecimal}. ` +
          `Run $FCE_HOME/scripts/post-build.sh first.`,
      );
    }
    if (active.length > 1) {
      console.log(`  ${active.length} active machines; taking the first: ${active.join(", ")}`);
    }
    next = ethers.getAddress(active[0]);
  }

  const status = await registry.getTeeMachineStatus(next);
  console.log(`  book    ${d.contracts.sealedBidBook}`);
  console.log(`  machine ${next} · status ${status}${status === 2n ? " (PRODUCTION)" : ""}`);
  if (status !== 2n) {
    throw new Error(`machine is status ${status}, not 2 (PRODUCTION) — it cannot answer yet`);
  }

  const current = await book.teeMachine();
  if (ethers.getAddress(current) === ethers.getAddress(next)) {
    console.log(`\n  ✅ already in sync`);
  } else {
    if (ethers.getAddress(await book.admin()) !== ethers.getAddress(admin.address)) {
      throw new Error(`not the admin: book admin is ${await book.admin()}`);
    }
    const tx = await book.setTeeMachine(next);
    const rc = await tx.wait();
    if (rc?.status !== 1) throw new Error(`setTeeMachine reverted: ${tx.hash}`);
    console.log(`\n  ✅ teeMachine ${current} → ${next}`);
    console.log(`     tx ${tx.hash}`);
  }

  d.fcc.teeMachineId = next;
  d.fcc.teeMachineStatus = "PRODUCTION";
  d.teeMachine = next;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`  wrote deployments/coston2.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
