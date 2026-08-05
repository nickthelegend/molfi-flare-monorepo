/**
 * Molfi backend — MongoDB-backed market engine on **Flare Coston2**.
 *
 * - Polls live spot from FTSOv2 (the same feed the contracts settle on) into a `prices`
 *   time series and auto-generates rolling 15-/30-min markets per token.
 * - Routes a 2% trading fee on every recorded bet into the LP vault.
 * - Settles each market at close (spot vs strike) and pays out positions.
 * - Serves the REST API (see app.js). On-chain reads are viem/Coston2.
 *
 * This module is IMPORT-SAFE: importing it does NOT connect Mongo or listen.
 * The connect + poller + listen path runs only when the file is executed
 * directly (`node server.js`). Tests import `createApp` from ./app.js with an
 * in-memory Mongo and never touch this start path. The backend NEVER broadcasts
 * a transaction.
 */
import { MongoClient } from "mongodb";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { createApp } from "./app.js";
import * as chain from "./chain.js";
import * as zk from "./zk.js";

const PORT = Number(process.env.PORT) || 4000;

const icon = (s) =>
  `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${s.toLowerCase()}.png`;

const TOKENS = {
  XRP: { pair: "XRP-USD", icon: icon("xrp"), round: (p) => Math.round(p * 100) / 100 },
  FLR: { pair: "FLR-USD", icon: icon("flr"), round: (p) => Math.round(p * 1000) / 1000 },
  BTC: { pair: "BTC-USD", icon: icon("btc"), round: (p) => Math.round(p / 500) * 500 },
  ETH: { pair: "ETH-USD", icon: icon("eth"), round: (p) => Math.round(p / 25) * 25 },
};
const CADENCES = [15, 30]; // minutes

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const fmtStrike = (sym, s) =>
  sym === "FLR" ? `$${s.toFixed(4)}` : sym === "XRP" ? `$${s.toFixed(2)}` : `$${s.toLocaleString()}`;

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "molfi_flare");

  const Prices = db.collection("prices");
  const Markets = db.collection("markets");
  const Positions = db.collection("positions");
  const OnchainTrades = db.collection("onchainTrades");
  const OnchainMarkets = db.collection("onchainMarkets");
  const Comments = db.collection("comments");
  const VaultDeposits = db.collection("vaultDeposits");
  await Prices.createIndex({ symbol: 1, ts: -1 });
  await Markets.createIndex({ closeTs: 1, status: 1 });
  await Positions.createIndex({ address: 1, createdAt: -1 });
  await Positions.createIndex({ marketId: 1 });
  await VaultDeposits.createIndex({ address: 1 });
  await OnchainTrades.createIndex({ address: 1 });
  await OnchainTrades.createIndex({ kind: 1 });
  await OnchainMarkets.createIndex({ symbol: 1, closeTs: -1 });
  await Comments.createIndex({ marketId: 1, ts: -1 });
  console.log("[molfi-backend] connected to MongoDB");

  const lastPrice = {};

  async function fetchSpot(sym) {
    // FTSOv2 FIRST — this is the exact value the settlement contract reads, so
    // the price shown here can never disagree with the price a market settles
    // on. Flare's oracle is the source of truth, not a convenience fallback.
    try {
      const px = await chain.ftsoPrice(sym);
      if (px != null && Number.isFinite(px) && px > 0) return px;
    } catch {
      /* fall through */
    }
    // Public spot API only as a display fallback if FTSO is unreachable.
    try {
      const r = await fetch(`https://api.coinbase.com/v2/prices/${TOKENS[sym].pair}/spot`);
      const v = Number((await r.json())?.data?.amount);
      if (Number.isFinite(v)) return v;
    } catch {
      /* ignore */
    }
    return null;
  }

  async function pollPrices() {
    for (const sym of Object.keys(TOKENS)) {
      const p = await fetchSpot(sym);
      if (p != null) {
        lastPrice[sym] = p;
        await Prices.insertOne({ symbol: sym, price: p, ts: Date.now() });
      }
    }
  }

  async function ensureMarkets() {
    const now = Date.now();
    for (const sym of Object.keys(TOKENS)) {
      const price = lastPrice[sym];
      if (price == null) continue;
      const t = TOKENS[sym];
      for (const mins of CADENCES) {
        const slotMs = mins * 60 * 1000;
        const closeTs = Math.ceil(now / slotMs) * slotMs;
        const strike = t.round(price);
        const id = `${sym}-${mins}m-${strike}-${closeTs}`;
        if (await Markets.findOne({ _id: id })) continue;
        await Markets.insertOne({
          _id: id,
          symbol: sym,
          icon: t.icon,
          cadenceMins: mins,
          category: "crypto",
          question: `Will ${sym} be above ${fmtStrike(sym, strike)} at ${fmtTime(closeTs)}? (${mins}m)`,
          strike,
          side: "above",
          openPrice: price,
          createdAt: now,
          closeTs,
          status: "open",
          outcome: null,
          settlePrice: null,
        });
        console.log(`[molfi-backend] created ${id}`);
      }
    }
  }

  async function settleDue() {
    const now = Date.now();
    const due = await Markets.find({ status: "open", closeTs: { $lte: now } }).toArray();
    for (const m of due) {
      const settlePrice = lastPrice[m.symbol] ?? m.openPrice;
      const outcome = settlePrice >= m.strike ? "yes" : "no";
      await Markets.updateOne(
        { _id: m._id },
        { $set: { status: "resolved", outcome, settlePrice, resolvedAt: now } },
      );
      const positions = await Positions.find({ marketId: m._id, status: "open" }).toArray();
      for (const pos of positions) {
        const won = pos.side === outcome;
        const entry = pos.side === "yes" ? pos.entryYes : 1 - pos.entryYes;
        const payout = won && entry > 0 ? pos.amount / entry : 0;
        await Positions.updateOne(
          { _id: pos._id },
          { $set: { status: "settled", won, payout, pnl: payout - pos.amount, settledAt: now } },
        );
      }
      console.log(`[molfi-backend] settled ${m._id} → ${outcome.toUpperCase()}`);
    }
  }

  const app = createApp({ db, chain, zk, lastPrice });

  await pollPrices();
  await ensureMarkets();
  await app.locals.reconcileVault();
  setInterval(pollPrices, 10_000);
  setInterval(ensureMarkets, 15_000);
  setInterval(settleDue, 12_000);
  setInterval(() => app.locals.reconcileVault().catch(() => {}), 20_000);

  app.listen(PORT, () => console.log(`[molfi-backend] API on http://localhost:${PORT}`));
}

// Only start the server when executed directly — importing this module (e.g.
// from tests) must NOT connect Mongo or listen.
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main().catch((e) => {
    console.error("[molfi-backend] fatal:", e);
    process.exit(1);
  });
}

export { createApp } from "./app.js";
