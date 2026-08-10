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
 * in-memory Mongo and never touch this start path.
 *
 * KEEPERS BROADCAST. Read paths are still read-only, but three background loops
 * sign transactions when MOLFI_KEEPER_KEY is set: rolling on-chain markets
 * forward, settling them from FTSOv2, and relaying FDC attestations. None of
 * them is privileged — every one of those calls is permissionless on-chain, so
 * the keeper is a convenience that keeps the venue live, not an authority.
 */
import { MongoClient } from "mongodb";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { createApp } from "./app.js";
import * as chain from "./chain.js";
import * as zk from "./zk.js";
import * as web2json from "./web2json.js";
import * as marketKeeper from "./market-keeper.js";

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

  // ── PredictEscrow log indexer ─────────────────────────────────────────────
  // The leaderboard, vault fee history and per-market bet counts all aggregate
  // `onchainTrades`. Nothing used to write it, so all three were permanently
  // empty however much real betting happened on-chain. This is the writer.
  //
  // The cursor is persisted so a restart resumes rather than rescanning, and
  // each row's `_id` is `txHash:logIndex`, so a replayed range is a no-op.
  const Cursors = db.collection("cursors");
  await OnchainTrades.createIndex({ market: 1 });
  await OnchainTrades.createIndex({ ts: -1 });

  async function writeTrades(rows) {
    if (!rows.length) return;
    await OnchainTrades.bulkWrite(
      rows.map((r) => ({
        updateOne: { filter: { _id: r._id }, update: { $set: r }, upsert: true },
      })),
      { ordered: false },
    );
  }

  /**
   * One-time full backfill through the explorer.
   *
   * The RPC path below can keep up but cannot catch up: 30 blocks per
   * `eth_getLogs`, 40 calls a tick, against a chain 33 million blocks deep.
   * Measured 2026-08-10, starting from genesis it reached block 1,200 in a tick
   * — about five days of ticking to find a bet placed minutes earlier. That is
   * why the cold-start cursor used to jump to head-6000 and simply abandon
   * everything older, leaving the leaderboard silently incomplete.
   *
   * Ported from _references/flare-prediction-market. Runs once; the cursor then
   * hands over to the RPC tail.
   */
  async function backfillEscrowLogs() {
    const done = await Cursors.findOne({ _id: "escrowBackfill" });
    if (done?.completedAt) return;
    const { rows, pages, truncated } = await chain.readEscrowLogsViaExplorer(0);
    await writeTrades(rows);
    if (truncated) {
      // Do NOT mark it complete — a capped walk that claims to be done is how
      // an incomplete leaderboard becomes permanent.
      console.warn(
        `[molfi-backend] escrow backfill hit the page cap after ${pages} page(s); will retry`,
      );
      return;
    }
    await Cursors.updateOne(
      { _id: "escrowBackfill" },
      { $set: { completedAt: Date.now(), rows: rows.length, pages } },
      { upsert: true },
    );
    console.log(`[molfi-backend] escrow backfill: ${rows.length} event(s) over ${pages} page(s)`);
  }

  async function indexEscrowLogs() {
    await backfillEscrowLogs();

    const cur = await Cursors.findOne({ _id: "escrowLogs" });
    // With the explorer backfill covering history, the RPC walk only has to
    // handle the live tail, so a short cold-start window is now correct rather
    // than a concession.
    const envFrom = Number(process.env.ESCROW_FROM_BLOCK) || 0;
    let start = cur?.nextBlock ?? envFrom;
    if (!start) {
      start = Number(await chain.publicClient.getBlockNumber()) - 6_000;
    }
    const { rows, nextBlock, caughtUp } = await chain.readEscrowLogs(Math.max(0, start));
    if (rows.length) {
      await OnchainTrades.bulkWrite(
        rows.map((r) => ({
          updateOne: { filter: { _id: r._id }, update: { $set: r }, upsert: true },
        })),
        { ordered: false },
      );
      console.log(`[molfi-backend] indexed ${rows.length} escrow event(s)`);
    }
    await Cursors.updateOne(
      { _id: "escrowLogs" },
      { $set: { nextBlock: Number(nextBlock), caughtUp } },
      { upsert: true },
    );
  }

  const app = createApp({ db, chain, zk, lastPrice });

  // ── On-chain market keeper ────────────────────────────────────────────────
  // MolfiMarket only ever gained a market when someone ran a script, so once
  // those closed the app's main page had nothing to bet on — 58 markets created
  // and settled, none open. This rolls them forward and settles them.
  async function keepOnchainMarkets() {
    if (!marketKeeper.keeper) return;
    const market = chain.CONTRACTS.market;
    if (!market) return;

    const { created, skipped } = await marketKeeper.ensureOnchainMarkets({
      market, feeds: chain.FEEDS, lastPrice,
    });
    if (skipped && !warnedKeeper) {
      console.warn(`[molfi-backend] on-chain market keeper idle: ${skipped}`);
      warnedKeeper = true;
    }
    if (created.length) {
      // Nudge the read path so the new market shows up without waiting a poll.
      await OnchainMarkets.deleteMany({ _id: { $in: created.map((c) => c.id) } }).catch(() => {});
    }
    const ids = await chain.listMarketIds().catch(() => []);
    // Only the recent tail — resolving is idempotent but scanning 58 markets
    // every tick is 58 reads nobody needs.
    await marketKeeper.resolveDue({ market, marketIds: ids.slice(-12) });
  }
  let warnedKeeper = false;

  // ── Web2Json feed keeper ──────────────────────────────────────────────────
  // A feed only means something if it is refreshed: `getFreshPrice` reverts once
  // an observation ages past a market's staleness bound, which is correct but
  // useless if nobody ever posts a newer one. This is the poster.
  //
  // Anyone can do this — the oracle takes a proof from any address — so a
  // second relayer is redundancy, not a conflict. Whoever's proof lands first
  // wins the round and the other simply reverts with StaleObservation.
  async function refreshWeb2Feeds() {
    if (!app.locals.web2Oracle || !web2json.keeper) return;
    const bindings = await web2json.verifyFeedBindings(app.locals.web2Oracle);
    for (const b of bindings) {
      if (b.agrees) continue;
      // The relayer and the contract disagree about what this feed asks. Every
      // proof it produces would be rejected; say so once rather than burning
      // gas on a loop that cannot succeed.
      console.warn(
        `[molfi-backend] web2 feed ${b.feedId} binding mismatch: ` +
          `relayer ${b.local} vs contract ${b.onChain} — not attesting`,
      );
    }
    for (const feed of web2json.FEEDS) {
      if (!bindings.find((b) => b.feedId === feed.feedId)?.agrees) continue;
      const state = await web2json.readFeed(app.locals.web2Oracle, feed.feedId);
      if (!state.registered) continue;
      const age = state.observation
        ? Math.floor(Date.now() / 1000) - state.observation.observedAt
        : Infinity;
      if (age < WEB2_REFRESH_SECONDS) continue;
      const rec = await app.locals.attestFeed(feed);
      console.log(
        `[molfi-backend] web2 ${feed.feedId} → ${rec.rawValue} (round ${rec.votingRound}) ${rec.submitTx}`,
      );
    }
  }
  const WEB2_REFRESH_SECONDS = Number(process.env.MOLFI_WEB2_REFRESH_SECONDS || 1800);

  await pollPrices();
  await ensureMarkets();
  await indexEscrowLogs().catch((e) =>
    console.warn(`[molfi-backend] escrow indexer: ${e.message}`),
  );
  await app.locals.reconcileVault();
  setInterval(pollPrices, 10_000);
  setInterval(ensureMarkets, 15_000);
  setInterval(settleDue, 12_000);
  setInterval(
    () => indexEscrowLogs().catch((e) => console.warn(`[molfi-backend] escrow indexer: ${e.message}`)),
    15_000,
  );
  setInterval(() => app.locals.reconcileVault().catch(() => {}), 20_000);
  // Checked every 5 min, but only ATTESTS when the observation is older than
  // MOLFI_WEB2_REFRESH_SECONDS — each attestation is an on-chain fee plus a
  // full FDC round, so polling cheaply and acting rarely is the point.
  keepOnchainMarkets().catch((e) => console.warn(`[molfi-backend] market keeper: ${e.message}`));
  setInterval(
    () => keepOnchainMarkets().catch((e) => console.warn(`[molfi-backend] market keeper: ${e.message}`)),
    60_000,
  );
  refreshWeb2Feeds().catch((e) => console.warn(`[molfi-backend] web2 keeper: ${e.message}`));
  setInterval(
    () => refreshWeb2Feeds().catch((e) => console.warn(`[molfi-backend] web2 keeper: ${e.message}`)),
    300_000,
  );

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
