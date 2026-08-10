// Integration tests: boot the Express app against an in-memory MongoDB and
// exercise the REST routes. Chain reads are mocked (read-only, deterministic) —
// NO live Fuji RPC and NO transactions. The BN254 confidential-commit path uses
// the real zk module.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bootApp, mockChain } from "./helpers.mjs";

let h;
const lastPrice = { BTC: 60000, ETH: 3000 };

before(async () => {
  h = await bootApp({ lastPrice });
});
after(async () => {
  await h.close();
});

// Seed an open off-chain market directly in Mongo.
async function seedMarket(overrides = {}) {
  const doc = {
    _id: overrides._id || `BTC-15m-60000-${Date.now()}`,
    symbol: "BTC",
    icon: "https://icon",
    cadenceMins: 15,
    category: "crypto",
    question: "Will BTC be above $60,000?",
    strike: 60000,
    side: "above",
    openPrice: 60000,
    createdAt: Date.now(),
    closeTs: Date.now() + 15 * 60 * 1000,
    status: "open",
    outcome: null,
    settlePrice: null,
    ...overrides,
  };
  await h.db.collection("markets").insertOne(doc);
  return doc;
}

test("GET /api/health returns ok + live prices", async () => {
  const { status, body } = await h.get("/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.prices.BTC, 60000);
});

test("GET /api/markets lists open markets, decorated with yesPrice + spot", async () => {
  await seedMarket({ _id: "BTC-15m-60000-open1" });
  const { status, body } = await h.get("/api/markets");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  const m = body.find((x) => x._id === "BTC-15m-60000-open1");
  assert.ok(m, "seeded market present");
  assert.equal(m.spot, 60000);
  assert.ok(m.yesPrice >= 0 && m.yesPrice <= 1);
  assert.equal(m.oi, 0);
});

test("GET /api/markets/:id returns a single market; 404 when missing", async () => {
  await seedMarket({ _id: "BTC-15m-60000-single" });
  const ok = await h.get("/api/markets/BTC-15m-60000-single");
  assert.equal(ok.status, 200);
  assert.equal(ok.body._id, "BTC-15m-60000-single");

  const miss = await h.get("/api/markets/does-not-exist");
  assert.equal(miss.status, 404);
});

test("POST /api/bet records to Mongo (no broadcast) + shows up in /api/positions", async () => {
  await seedMarket({ _id: "BTC-15m-60000-bet" });
  const addr = "0x1111111111111111111111111111111111111111";
  const bet = await h.post("/api/bet", { marketId: "BTC-15m-60000-bet", side: "yes", amount: 50, address: addr });
  assert.equal(bet.status, 200);
  assert.equal(bet.body.side, "yes");
  assert.equal(bet.body.amount, 50);
  assert.ok(Math.abs(bet.body.fee - 1) < 1e-6, "2% fee = 1.0");
  assert.ok(bet.body._id, "insertedId returned");

  const pos = await h.get(`/api/positions/${addr}`);
  assert.equal(pos.status, 200);
  assert.equal(pos.body.length, 1);
  assert.equal(pos.body[0].marketId, "BTC-15m-60000-bet");
});

test("POST /api/bet validates input + rejects closed markets", async () => {
  const bad = await h.post("/api/bet", { marketId: "x", side: "maybe", amount: 10, address: "0xabc" });
  assert.equal(bad.status, 400);

  await seedMarket({ _id: "BTC-15m-60000-closed", status: "resolved", outcome: "yes" });
  const closed = await h.post("/api/bet", { marketId: "BTC-15m-60000-closed", side: "yes", amount: 10, address: "0xabc" });
  assert.equal(closed.status, 400);

  const missing = await h.post("/api/bet", { marketId: "nope", side: "yes", amount: 10, address: "0xabc" });
  assert.equal(missing.status, 404);
});

test("GET /api/leaderboard aggregates indexed on-chain bet/redeem events", async () => {
  const addr = "0x2222222222222222222222222222222222222222";
  await h.db.collection("onchainTrades").insertMany([
    { _id: "t1", kind: "bet", market: "0xdead", address: addr, amount: 100, ts: Date.now() },
    { _id: "t2", kind: "redeem", market: "0xdead", address: addr, amount: 180, ts: Date.now() },
  ]);
  const { status, body } = await h.get("/api/leaderboard");
  assert.equal(status, 200);
  const row = body.find((r) => r.address === addr);
  assert.ok(row, "leaderboard row present");
  assert.equal(row.volume, 100);
  assert.equal(row.pnl, 80);
  assert.equal(row.trades, 1);
  assert.equal(row.wins, 1);
});

test("vaults: TVL and position come from the contract, not the deposit mirror", async () => {
  const addr = "0x3333333333333333333333333333333333333333";

  // The mirror still records a deposit for the depositor count…
  const dep = await h.post("/api/vaults/deposit", { address: addr, amount: 500 });
  assert.equal(dep.status, 200);
  assert.equal(dep.body.deposited, 500);

  // …but it must NOT move the reported TVL. This assertion is the inversion of
  // what this test used to check, and it is the whole point: a Mongo row once
  // conjured 500 FXRP of TVL and a 100% pool share for a wallet that held no
  // shares and could not withdraw a thing, because there was no vault contract
  // at all. Only the chain can say what the vault holds.
  const vaults = await h.get("/api/vaults");
  assert.equal(vaults.status, 200);
  assert.equal(vaults.body[0].tvl, 0, "TVL is the contract's balance, not the mirror's sum");
  assert.equal(vaults.body[0].simulated, undefined, "nothing here is simulated any more");
  assert.ok(vaults.body[0].address, "the payload names the vault contract");

  const pos = await h.get(`/api/vaults/position/${addr}`);
  assert.equal(pos.status, 200);
  assert.equal(pos.body.shares, 0);
  assert.equal(pos.body.deposited, 0);
  assert.equal(pos.body.sharePct, 0);
});

test("vaults: a malformed address is rejected, not answered with a zero position", async () => {
  const { status, body } = await h.get("/api/vaults/position/not-an-address");
  assert.equal(status, 400);
  assert.match(body.error, /address/);
});

test("vaults: an unreadable vault reports the failure instead of inventing zeros", async () => {
  const broken = await bootApp({
    chain: mockChain({
      async lpVaultPosition() {
        throw new Error("rpc down");
      },
    }),
  });
  try {
    const { status, body } = await broken.get(
      "/api/vaults/position/0x3333333333333333333333333333333333333333",
    );
    assert.equal(status, 503);
    assert.match(body.error, /could not read the vault/);
  } finally {
    await broken.close();
  }
});

test("GET /api/onchain/markets returns [] when no indexed/on-chain markets", async () => {
  const { status, body } = await h.get("/api/onchain/markets");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test("GET /api/onchain/markets reads an indexed doc + escrow OI", async () => {
  await h.db.collection("onchainMarkets").insertOne({
    _id: "0xfeed",
    symbol: "BTC",
    question: "on-chain BTC market",
    closeTs: Date.now() + 60 * 60 * 1000,
    cadenceMins: 15,
    oracle: "chainlink",
    resolved: false,
    createdAt: Date.now(),
    strikeUsd: 60000,
  });
  await h.db.collection("onchainTrades").insertOne({
    _id: "oi1", kind: "bet", market: "0xfeed", address: "0xabc", outcome: 0, amount: 25, ts: Date.now(),
  });
  const { status, body } = await h.get("/api/onchain/markets");
  assert.equal(status, 200);
  const m = body.find((x) => x.marketId === "0xfeed");
  assert.ok(m, "indexed on-chain market present");
  assert.equal(m.oi, 25);
  assert.equal(m.bets, 1);
});

test("GET /api/onchain/positions/:address reads escrow directly, not an index", async () => {
  // The endpoint used to serve an `onchainTrades` collection that nothing
  // writes, so a wallet that bet on-chain saw no positions. It now asks
  // PredictEscrow. Mock a wallet holding 0.25 FXRP on NO in one market.
  const addr = "0x4444444444444444444444444444444444444444";
  const marketId = "0x" + "ab".repeat(32);
  const local = await bootApp({
    chain: mockChain({
      async listMarketIds() { return [marketId]; },
      async escrowPosition(_id, outcome) { return outcome === 1 ? 0.25 : 0; },
      async escrowPools() { return { yes: 0.75, no: 0.25, total: 1 }; },
      async getMarketFull() {
        return {
          question: "Will XRP/USD be >= $1.06?",
          closeTs: Math.floor(Date.now() / 1000) + 600,
          feedId: "0x015852502f55534400000000000000000000000000",
          strike: 1.06, op: 0, status: 0, outcome: 0, exists: true, hasOracle: true,
        };
      },
    }),
  });
  try {
    const { status, body } = await local.get(`/api/onchain/positions/${addr}`);
    assert.equal(status, 200);
    assert.equal(body.length, 1);
    assert.equal(body[0].side, "no");
    // 0.25 must survive rounding — FXRP is 6dp, and r2 would have kept this
    // one but silently zeroes a 0.001 stake.
    assert.equal(body[0].amount, 0.25);
    assert.equal(body[0].symbol, "XRP");
    assert.equal(body[0].status, "open");
    assert.equal(body[0].strike, 1.06);
  } finally {
    await local.close();
  }
});

test("GET /api/onchain/positions/:address keeps sub-cent FXRP stakes", async () => {
  const addr = "0x5555555555555555555555555555555555555555";
  const marketId = "0x" + "cd".repeat(32);
  const local = await bootApp({
    chain: mockChain({
      async listMarketIds() { return [marketId]; },
      async escrowPosition(_id, outcome) { return outcome === 0 ? 0.001 : 0; },
      async escrowPools() { return { yes: 0.001, no: 0, total: 0.001 }; },
      async getMarketFull() {
        return {
          question: "Will XRP/USD be >= $1.06?",
          closeTs: Math.floor(Date.now() / 1000) + 600,
          feedId: "0x015852502f55534400000000000000000000000000",
          strike: 1.06, op: 0, status: 0, outcome: 0, exists: true, hasOracle: true,
        };
      },
    }),
  });
  try {
    const { body } = await local.get(`/api/onchain/positions/${addr}`);
    assert.equal(body.length, 1);
    assert.equal(body[0].amount, 0.001, "a 0.001 FXRP stake must not round to 0");
  } finally {
    await local.close();
  }
});

test("GET /api/prices/:symbol falls back to a live FTSOv2 point", async () => {
  // Boot a fresh app whose chain mock returns an FTSO price. The Flare port
  // reads ftsoPrice; chainlinkPrice remains only as a back-compat alias.
  const local = await bootApp({ chain: mockChain({ ftsoPrice: async () => 61234.5 }) });
  try {
    const { status, body } = await local.get("/api/prices/BTC");
    assert.equal(status, 200);
    assert.equal(body.length, 1);
    assert.equal(body[0].price, 61234.5);
  } finally {
    await local.close();
  }
});

const MKT_A = "0x" + "aa".repeat(32);
const MKT_B = "0x" + "bb".repeat(32);

test("BN254 /api/confidential/prepare-commit returns a well-formed note + commitment", async () => {
  const { status, body } = await h.post("/api/confidential/prepare-commit", {
    side: "NO", marketId: MKT_A, tier: 0,
  });
  assert.equal(status, 200);
  assert.equal(body.side, "NO");
  assert.equal(body.tier, 0);

  // Denominations come from the DEPLOYED contract, never a literal. They were
  // once hardcoded to 100/200 against a contract whose denom was 1 FXRP.
  const deployed = JSON.parse(
    readFileSync(new URL("../../molfi-contracts/deployments/coston2.json", import.meta.url), "utf8"),
  );
  const tiers = (deployed.confDenoms ?? [deployed.confDenom]).map(
    (d) => Number(d) / 10 ** deployed.fxrpDecimals,
  );
  assert.equal(body.denom, tiers[0]);
  assert.equal(body.payout, tiers[0] * 2);

  // note fields are decimal BN254 field elements
  assert.match(body.note.secret, /^\d+$/);
  assert.match(body.note.nullifier, /^\d+$/);
  assert.match(body.note.recipient, /^\d+$/);
  // outcome is the BOUND side signal, not a bare 0/1
  assert.match(String(body.note.outcome), /^\d+$/);
  assert.ok(BigInt(body.note.outcome) > 1n, "outcome must be the bound signal");
  // commitment is a 64-hex sha256 binding hash (reveals nothing about the side)
  assert.match(body.commitment, /^[0-9a-f]{64}$/);

  const yes = await h.post("/api/confidential/prepare-commit", {
    side: "YES", marketId: MKT_A, tier: 0,
  });
  assert.equal(yes.body.side, "YES");
  assert.notEqual(yes.body.note.outcome, body.note.outcome);
});

test("prepare-commit binds the note to its market AND tier", async () => {
  // This is what stops a 1 FXRP note being claimed at 1000, and a losing note
  // on one market being replayed against another.
  const base = { side: "YES", marketId: MKT_A, tier: 0 };
  const a0 = (await h.post("/api/confidential/prepare-commit", base)).body.note.outcome;
  const a2 = (await h.post("/api/confidential/prepare-commit", { ...base, tier: 2 })).body.note.outcome;
  const b0 = (await h.post("/api/confidential/prepare-commit", { ...base, marketId: MKT_B })).body.note.outcome;
  assert.notEqual(a0, a2, "tier must change the signal");
  assert.notEqual(a0, b0, "market must change the signal");

  const denoms = (await h.get("/api/confidential/tiers")).body.denoms;
  assert.ok(denoms.length >= 1);
  assert.deepEqual([...denoms].sort((x, y) => x - y), denoms, "tiers ascend");

  const bad = await h.post("/api/confidential/prepare-commit", { ...base, tier: 99 });
  assert.equal(bad.status, 400);
  const noMarket = await h.post("/api/confidential/prepare-commit", { side: "YES" });
  assert.equal(noMarket.status, 400);
});

test("confidential/prepare-claim: unresolved market → {resolved:false}", async () => {
  const { status, body } = await h.post("/api/confidential/prepare-claim", {
    note: { secret: "1", nullifier: "2", outcome: "12345", recipient: "3" },
    marketId: MKT_A,
    recipient: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(status, 200);
  assert.equal(body.resolved, false);
});

test("confidential/prepare-claim: missing recipient or non-numeric outcome → 400", async () => {
  const noRecipient = await h.post("/api/confidential/prepare-claim", {
    note: { secret: "1", nullifier: "2", outcome: "12345", recipient: "3" },
    marketId: MKT_A,
  });
  assert.equal(noRecipient.status, 400);

  const badOutcome = await h.post("/api/confidential/prepare-claim", {
    note: { secret: "1", nullifier: "2", outcome: "nope", recipient: "3" },
    marketId: MKT_A,
    recipient: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(badOutcome.status, 400);

  // A short/malformed market id is a 400, not a 500 from inside the encoder.
  const badMarket = await h.post("/api/confidential/prepare-claim", {
    note: { secret: "1", nullifier: "2", outcome: "12345", recipient: "3" },
    marketId: "0xfeed",
    recipient: "0x1111111111111111111111111111111111111111",
  });
  assert.equal(badMarket.status, 400);
});

test("confidential/prepare-claim: resolved but losing side → won:false (no proof burned)", async () => {
  // chain mock: resolved with winner=1 (NO); our note backs 0 (YES) → lost.
  const local = await bootApp({
    chain: mockChain({ isResolved: async () => true, winningOutcome: async () => 1 }),
  });
  try {
    // A note whose signal isn't the winner's signal loses — including one built
    // for a different market or tier, which now reports won:false here rather
    // than failing later with an opaque BadProof.
    const { status, body } = await local.post("/api/confidential/prepare-claim", {
      note: { secret: "1", nullifier: "2", outcome: "12345", recipient: "3" },
      marketId: MKT_A,
      tier: 0,
      recipient: "0x1111111111111111111111111111111111111111",
    });
    assert.equal(status, 200);
    assert.equal(body.resolved, true);
    assert.equal(body.won, false);
    assert.equal(body.winningOutcome, 1);
  } finally {
    await local.close();
  }
});

test("market chat: post a comment + list it back", async () => {
  const addr = "0x5555555555555555555555555555555555555555";
  const posted = await h.post("/api/markets/0xfeed/comments", { address: addr, type: "text", text: "gm molfi" });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.text, "gm molfi");

  const list = await h.get("/api/markets/0xfeed/comments");
  assert.equal(list.status, 200);
  assert.ok(list.body.some((c) => c.text === "gm molfi"));
});

test("GET /api/onchain/markets splits open vs settled and strands neither", async () => {
  // The Settled tab used to short-circuit to [] because it was served only by
  // the `onchainMarkets` collection, which nothing writes. Worse, the open path
  // dropped every past-close market, so a market that had closed but not yet
  // been resolved appeared in NEITHER tab — most of the book was invisible.
  const open = "0x" + "01".repeat(32);
  const pastClose = "0x" + "02".repeat(32); // closed, awaiting resolveFromOracle
  const settled = "0x" + "03".repeat(32);
  const now = Math.floor(Date.now() / 1000);
  const byId = {
    [open]: { closeTs: now + 600, status: 0, outcome: 0 },
    [pastClose]: { closeTs: now - 600, status: 0, outcome: 0 },
    [settled]: { closeTs: now - 1200, status: 2, outcome: 1 },
  };
  const local = await bootApp({
    chain: mockChain({
      async listMarketIds() { return [open, pastClose, settled]; },
      async escrowPools() { return { yes: 0.0011, no: 0, total: 0.0011 }; },
      // Settle prices come from the Resolved event; the endpoint must carry
      // them through for settled markets and leave open ones null.
      async settlePrices() { return new Map([[settled, 1.0402]]); },
      async getMarketFull(id) {
        return {
          question: "Will XRP/USD be >= $1.06? (15m)",
          feedId: "0x015852502f55534400000000000000000000000000",
          strike: 1.06, op: 0, exists: true, hasOracle: true,
          ...byId[id],
        };
      },
    }),
  });

  const openTab = await local.get("/api/onchain/markets?status=open");
  const closedTab = await local.get("/api/onchain/markets?status=closed");
  const ids = (r) => r.body.map((m) => m.marketId).sort();

  assert.deepEqual(ids(openTab), [open]);
  assert.deepEqual(ids(closedTab), [pastClose, settled].sort());

  // A resolved market prices at its outcome; NO winning => yesPrice 0.
  const s = closedTab.body.find((m) => m.marketId === settled);
  assert.equal(s.resolved, true);
  assert.equal(s.outcome, 1);
  assert.equal(s.settlePrice, 1.0402);
  // An open market has not settled against anything yet.
  assert.equal(openTab.body[0].settlePrice, null);
  assert.equal(s.yesPrice, 0);

  // Past close but unresolved is still "closed" for tab purposes, not resolved.
  const p = closedTab.body.find((m) => m.marketId === pastClose);
  assert.equal(p.resolved, false);

  // OI keeps FXRP precision — r2 rounded a 0.0011 FXRP pot to 0.
  assert.equal(openTab.body[0].oi, 0.0011);
});

test("onchain market detail: a missing market 404s, an unreachable chain 503s", async () => {
  // These are different answers and the endpoint has to tell them apart.
  // `getMarketFull` used to swallow every error and return null, so a
  // rate-limited RPC told the user a market they were looking at did not
  // exist — reproduced against the live node during a 429 window.
  const absent = await bootApp({
    chain: mockChain({ async getMarketFull() { return null; } }),
  });
  try {
    const { status, body } = await absent.get(`/api/onchain/markets/0x${"ab".repeat(32)}`);
    assert.equal(status, 404);
    assert.equal(body.error, "not found");
  } finally {
    await absent.close();
  }

  const unreachable = await bootApp({
    chain: mockChain({
      async getMarketFull() {
        throw new Error("HTTP request failed. Status: 429");
      },
    }),
  });
  try {
    const { status, body } = await unreachable.get(`/api/onchain/markets/0x${"ab".repeat(32)}`);
    assert.equal(status, 503);
    assert.match(body.error, /could not reach Coston2/);
  } finally {
    await unreachable.close();
  }
});
