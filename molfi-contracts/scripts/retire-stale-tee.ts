/**
 * Retire TEE machines that are active on-chain but no longer listening.
 *
 *   npx hardhat run scripts/retire-stale-tee.ts --network coston2
 *   KEEP=0x… npx hardhat run scripts/retire-stale-tee.ts --network coston2
 *
 * tee-node generates its identity key fresh on every container start, so each
 * rebuild registers a NEW machine and leaves the previous one active. Nobody is
 * listening on the old key, but `getRandomTeeIds` keeps handing it out — so a
 * share of instructions get routed into a void and simply never produce a
 * result. After a few rebuilds most of them do.
 *
 * This pauses every active machine for the extension except the one to keep,
 * which makes routing deterministic again.
 */
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;

const REGISTRY_ABI = [
  "function getActiveTeeMachines(uint256 _extensionId) view returns (address[])",
  "function getTeeMachineStatus(address) view returns (uint8)",
  "function pause(address _teeId) external",
];

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [owner] = await ethers.getSigners();
  const registry = new ethers.Contract(d.fcc.flareTeeManager, REGISTRY_ABI, owner);
  const extensionId = d.fcc.extensionIdDecimal;

  const keep = ethers.getAddress(process.env.KEEP || d.fcc.teeMachineId);
  const active: string[] = await registry.getActiveTeeMachines(extensionId);
  console.log(`  extension ${extensionId} · ${active.length} active machine(s)`);
  console.log(`  keeping   ${keep}`);

  const stale = active.filter((a) => ethers.getAddress(a) !== keep);
  if (stale.length === 0) {
    console.log(`\n  ✅ nothing stale — routing is already deterministic`);
    return;
  }

  for (const machine of stale) {
    process.stdout.write(`  pausing ${machine} … `);
    try {
      const tx = await registry.pause(machine);
      const rc = await tx.wait();
      console.log(rc?.status === 1 ? `done · ${tx.hash}` : `FAILED · ${tx.hash}`);
    } catch (e: any) {
      // Owner-only. Worth saying plainly rather than leaving a bare revert:
      // an un-retired stale machine is a silently flaky instruction path.
      console.log(`could not pause: ${e.shortMessage ?? String(e.message).slice(0, 120)}`);
    }
  }

  const after: string[] = await registry.getActiveTeeMachines(extensionId);
  console.log(`\n  now active: ${after.join(", ") || "(none)"}`);
  if (after.length !== 1) {
    console.log(
      `  ⚠ ${after.length} machines still active — getRandomTeeIds will spread instructions across them`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
