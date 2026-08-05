/**
 * Seed live rolling prediction markets on Coston2.
 *
 *   npx hardhat run scripts/seed-markets.ts --network coston2
 *
 * Creates markets whose strikes are derived from the CURRENT FTSO price, so
 * every market is genuinely near the money rather than a hardcoded number that
 * drifts out of relevance. Idempotent: a market id encodes its own slot, so
 * re-running inside the same slot is a no-op.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { TX_GAS } from "./fassets-gas";

const FEEDS = {
  XRP: "0x015852502f55534400000000000000000000000000",
  FLR: "0x01464c522f55534400000000000000000000000000",
  BTC: "0x014254432f55534400000000000000000000000000",
  ETH: "0x014554482f55534400000000000000000000000000",
} as const;

type Sym = keyof typeof FEEDS;

/**
 * Strike quantizers — round the live price to a human-looking number so the
 * question reads like a real market ("XRP above $1.05?") instead of exposing
 * six decimals of oracle precision.
 */
const ROUND: Record<Sym, (p: number) => number> = {
  XRP: (p) => Math.round(p * 100) / 100, // cents
  FLR: (p) => Math.round(p * 1000) / 1000, // tenths of a cent
  BTC: (p) => Math.round(p / 500) * 500,
  ETH: (p) => Math.round(p / 25) * 25,
};

/** Market durations, in minutes. */
const CADENCES = [15, 30, 60];

const EXPLORER = "https://coston2-explorer.flare.network";

async function main() {
  const file = path.join(__dirname, "..", "deployments", "coston2.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [admin] = await ethers.getSigners();

  const market = await ethers.getContractAt("MolfiMarket", d.contracts.molfiMarket);
  const oracle = await ethers.getContractAt("FtsoOracle", d.contracts.ftsoOracle);

  console.log(`\nSeeding markets on ${d.contracts.molfiMarket}`);
  console.log(`admin ${admin.address}\n`);

  const now = Math.floor(Date.now() / 1000);
  const created: string[] = [];

  for (const sym of Object.keys(FEEDS) as Sym[]) {
    const feedId = FEEDS[sym];
    let spot: number;
    try {
      const [p] = await oracle.getPrice(feedId);
      spot = Number(ethers.formatUnits(p, 18));
    } catch (e: any) {
      console.log(`${sym}: feed unavailable — skipping (${e.shortMessage ?? e.message})`);
      continue;
    }

    const strike = ROUND[sym](spot);
    console.log(`${sym}  spot $${spot.toFixed(6)}  strike $${strike}`);

    for (const mins of CADENCES) {
      const slotMs = mins * 60;
      // Snap the close to the next slot boundary so markets across a symbol
      // share close times and the grid reads as a coherent book.
      const closeTs = Math.ceil(now / slotMs) * slotMs + slotMs;
      const id = ethers.keccak256(
        ethers.toUtf8Bytes(`${sym}-${mins}m-${strike}-${closeTs}`),
      );

      const existing = await market.marketOf(id);
      if (existing.exists) {
        console.log(`   ${mins}m  already exists`);
        continue;
      }

      const question =
        `Will ${sym}/USD be >= $${strike.toLocaleString()} at ` +
        `${new Date(closeTs * 1000).toUTCString().slice(17, 22)} UTC? (${mins}m)`;

      const strike18 = ethers.parseUnits(strike.toString(), 18);
      // Staleness bound scales with cadence: a 15m market should not settle on
      // a price older than the market itself.
      const maxStaleness = Math.max(600, mins * 60);

      const r = await (
        await market.createPriceMarket(
          id, question, closeTs, feedId, strike18, 0 /* GTE */, maxStaleness, TX_GAS,
        )
      ).wait();

      created.push(id);
      console.log(`   ${mins}m  ${id.slice(0, 10)}…  ${EXPLORER}/tx/${r!.hash}`);
    }
  }

  const total = await market.marketCount();
  console.log(`\ncreated ${created.length} new market(s); ${total} total on-chain\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
