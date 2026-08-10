/**
 * Deploy Web2JsonOracle and register its feeds.
 *
 *   npx hardhat run scripts/deploy-web2json-oracle.ts --network coston2
 *
 * The fallback is the existing FtsoOracle, so this contract answers every FTSO
 * feed exactly as before and adds the Web2 ones — a superset, which is what
 * makes it safe to point a future market venue at it.
 *
 * Feed definitions live in molfi-backend/web2json.js and are read from there
 * rather than restated: the binding hash the contract enforces has to be the one
 * the relayer computes, and two copies of a jq filter is how that stops being
 * true.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
// The relayer's feed catalogue, imported rather than restated — see above.
// @ts-expect-error — plain-JS backend module, no types
import { FEEDS, requestHash } from "../../molfi-backend/web2json.js";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [admin] = await ethers.getSigners();

  const existing = d.contracts.web2JsonOracle;
  const factory = await ethers.getContractFactory("Web2JsonOracle");
  let oracle;
  if (existing) {
    oracle = factory.attach(existing);
    console.log(`  reusing Web2JsonOracle ${existing}`);
  } else {
    oracle = await factory.deploy(d.contracts.ftsoOracle);
    await oracle.waitForDeployment();
    console.log(`  ✅ Web2JsonOracle → ${await oracle.getAddress()}`);
    console.log(`     fallback (FTSO) ${d.contracts.ftsoOracle}`);
  }
  const address = await oracle.getAddress();

  for (const feed of FEEDS) {
    const local = requestHash(feed.request);
    // Ask the contract for the hash too. If its encoding and the relayer's ever
    // diverge, the feed would be registered against a binding no real proof can
    // satisfy — and nothing would say so until a settlement failed.
    const onChain = await oracle.requestHashOf([
      feed.request.url, feed.request.httpMethod, feed.request.headers,
      feed.request.queryParams, feed.request.body, feed.request.postProcessJq,
      feed.request.abiSignature,
    ]);
    if (onChain.toLowerCase() !== local.toLowerCase()) {
      throw new Error(`binding mismatch for ${feed.label}: contract ${onChain} vs relayer ${local}`);
    }

    const already = await oracle.feedOf(feed.feedId);
    if (already.exists) {
      console.log(`  feed already registered: ${feed.label}`);
      if (already.requestHash.toLowerCase() !== onChain.toLowerCase()) {
        throw new Error(
          `${feed.label} is registered against ${already.requestHash}, not ${onChain}. ` +
            `Feeds are single-shot by design — register a new feedId.`,
        );
      }
      continue;
    }
    const tx = await oracle.registerFeed(feed.feedId, onChain, feed.label, feed.valueDecimals);
    const rc = await tx.wait();
    if (rc?.status !== 1) throw new Error(`registerFeed reverted: ${tx.hash}`);
    console.log(`  ✓ registered ${feed.label}`);
    console.log(`    feedId ${feed.feedId}`);
    console.log(`    bound  ${onChain}`);
  }

  d.contracts.web2JsonOracle = address;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`\n  wrote deployments/coston2.json · admin ${admin.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
