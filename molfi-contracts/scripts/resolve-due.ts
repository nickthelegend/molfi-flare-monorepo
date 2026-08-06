/**
 * Settle every market that has closed but not yet resolved.
 *
 *   npx hardhat run scripts/resolve-due.ts --network coston2
 *
 * `resolveFromOracle` is PERMISSIONLESS — anyone can call it, and the outcome
 * is fixed by the FTSOv2 feed at close, not by the caller. This script is just
 * a keeper: it finds due markets and pokes them. Nothing here can influence a
 * result, which is the whole point of settling from a first-party oracle.
 *
 * Without a keeper, markets sit closed-but-unresolved indefinitely and nobody
 * can redeem, so this is the piece that makes the lifecycle actually complete.
 */
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;
/** Coston2 under-reports gas on the FTSO read path; the revert has empty data. */
const TX_GAS = { gasLimit: 1_500_000n };
const STATUS_RESOLVED = 2;

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [signer] = await ethers.getSigners();
  const market = await ethers.getContractAt("MolfiMarket", d.contracts.molfiMarket, signer);

  const ids: string[] = await market.markets();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  console.log(`  ${ids.length} market(s) on-chain · keeper ${signer.address}\n`);

  const due: string[] = [];
  for (const id of ids) {
    const m = await market.marketOf(id);
    if (Number(m.status) === STATUS_RESOLVED) continue;
    if (m.closeTs > now) continue;
    due.push(id);
  }
  if (due.length === 0) {
    console.log("  nothing due — every closed market is already settled.");
    return;
  }
  console.log(`  ${due.length} due for settlement\n`);

  let ok = 0;
  const failed: string[] = [];
  for (const id of due) {
    const m = await market.marketOf(id);
    try {
      // Read what the oracle WILL say before spending gas, so a stale feed is
      // reported as such instead of surfacing as an opaque revert.
      const [price, , wouldBeYes] = await market.previewResolution(id);
      const tx = await market.resolveFromOracle(id, TX_GAS);
      const r = await tx.wait();
      if (r?.status !== 1) throw new Error("reverted");
      ok++;
      console.log(
        `  ✅ ${m.question.slice(0, 46).padEnd(46)} $${(Number(price) / 1e18).toFixed(6)} → ${wouldBeYes ? "YES" : "NO"}`,
      );
    } catch (e) {
      failed.push(id);
      const msg = (e as Error).message.split("\n")[0].slice(0, 80);
      console.log(`  ✗  ${m.question.slice(0, 46).padEnd(46)} ${msg}`);
    }
  }
  console.log(`\n  settled ${ok}/${due.length}${failed.length ? ` · ${failed.length} failed` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
