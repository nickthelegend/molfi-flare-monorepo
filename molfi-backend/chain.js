/**
 * Molfi backend on-chain layer — **Flare Coston2** (viem).
 *
 * Read-only: a public client reads MolfiMarket / PredictEscrow / FXRP and the
 * FTSOv2 price feeds. There are NO write paths in THIS module — the app's own
 * wallet sends the real on-chain bets. Background keepers that do sign live in
 * market-keeper.js and web2json.js.
 *
 * The Flare port replaces Chainlink with FTSOv2. Two consequences worth
 * knowing, both learned from the live network:
 *
 *   1. Prices come from the DEPLOYED FtsoOracle contract, not from a public
 *      price API. That means the number the backend shows is the exact number
 *      the settlement contract will use — there is no drift between "what the
 *      UI quoted" and "what the market settled on". It also means the price
 *      path has no third-party API dependency at all.
 *
 *   2. FTSO feeds carry per-feed decimals that are NOT uniform (XRP 6, FLR 8,
 *      BTC 2, ETH 3 as observed on Coston2) and can change. Everything below
 *      reads through `getPrice`, which returns 18-decimal values normalized by
 *      the oracle contract, so no scale factor is ever hardcoded here.
 */
import { createPublicClient, decodeEventLog, defineChain, http, getAddress } from "viem";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Load deployed addresses from the contracts package when present. */
function loadDeployment() {
  const p = path.join(HERE, "..", "molfi-contracts", "deployments", "coston2.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
const DEPLOY = loadDeployment();

export const COSTON2 = {
  chainId: Number(process.env.MOLFI_CHAIN_ID || DEPLOY?.chainId || 114),
  rpcUrl:
    process.env.MOLFI_RPC ||
    DEPLOY?.rpc ||
    "https://coston2-api.flare.network/ext/C/rpc",
};

export const CONTRACTS = {
  market: process.env.MOLFI_MARKET || DEPLOY?.contracts?.molfiMarket,
  predictEscrow: process.env.MOLFI_ESCROW || DEPLOY?.contracts?.predictEscrow,
  confidentialBet: process.env.MOLFI_CBET || DEPLOY?.contracts?.confidentialBet,
  verifier: process.env.MOLFI_VERIFIER || DEPLOY?.contracts?.confidentialBetVerifier,
  ftsoOracle: process.env.MOLFI_ORACLE || DEPLOY?.contracts?.ftsoOracle,
  /** FXRP — FAssets-wrapped XRP, the collateral. */
  fxrp: process.env.MOLFI_FXRP || DEPLOY?.fxrp,
};

/**
 * FTSOv2 feed ids (bytes21): [category byte][hex name][zero padding].
 * Category 0x01 = crypto. These are ids, not addresses.
 */
export const FEEDS = {
  XRP: process.env.FEED_XRP || "0x015852502f55534400000000000000000000000000",
  FLR: process.env.FEED_FLR || "0x01464c522f55534400000000000000000000000000",
  BTC: process.env.FEED_BTC || "0x014254432f55534400000000000000000000000000",
  ETH: process.env.FEED_ETH || "0x014554482f55534400000000000000000000000000",
};

/** FXRP has 6 decimals — XRP is denominated in drops (1 XRP = 1e6 drops). */
export const FXRP_DECIMALS = Number(DEPLOY?.fxrpDecimals ?? 6);
export const U = 10 ** FXRP_DECIMALS;

export const coston2Chain = defineChain({
  id: COSTON2.chainId,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [COSTON2.rpcUrl] } },
  // Multicall3 is deployed at the canonical address on Coston2. Registering it
  // is what lets viem collapse a fan-out of eth_calls into one request.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  blockExplorers: {
    default: {
      name: "Coston2 Explorer",
      url: "https://coston2-explorer.flare.network",
    },
  },
  testnet: true,
});

/**
 * Read client, batched through Multicall3.
 *
 * Every market page fans out N markets × 4 reads. Unbatched against the public
 * Coston2 RPC that measured ~38s for /api/onchain/positions and up to 21s for
 * /api/onchain/markets — slower than the frontend's own 12-15s poll interval,
 * so requests piled up faster than they completed.
 *
 * `batchSize` is deliberately not left at viem's 1024-byte default: these calls
 * carry 32-byte market ids and 20-byte addresses, and 1024 still left positions
 * at ~5s. 4096 brings it under a second.
 */
export const publicClient = createPublicClient({
  chain: coston2Chain,
  transport: http(COSTON2.rpcUrl),
  batch: { multicall: { batchSize: 4096, wait: 24 } },
});

export const MARKET_ABI = [
  { type: "function", name: "markets", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }] },
  { type: "function", name: "getMarket", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "string" }, { type: "uint64" }, { type: "uint8" }, { type: "uint32" }] },
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
  {
    type: "function", name: "marketOf", stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "question", type: "string" },
      { name: "closeTs", type: "uint64" },
      { name: "feedId", type: "bytes21" },
      { name: "threshold", type: "uint256" },
      { name: "op", type: "uint8" },
      { name: "maxStaleness", type: "uint64" },
      { name: "status", type: "uint8" },
      { name: "winningOutcome", type: "uint32" },
      { name: "exists", type: "bool" },
      { name: "hasOracle", type: "bool" },
    ],
  },
  {
    type: "function", name: "previewResolution", stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "price", type: "uint256" },
      { name: "timestamp", type: "uint64" },
      { name: "wouldBeYes", type: "bool" },
    ],
  },
];

export const ESCROW_ABI = [
  { type: "function", name: "pool", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "total", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "redeemed", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "pools", stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "yesPool", type: "uint256" },
      { name: "noPool", type: "uint256" },
      { name: "totalPool", type: "uint256" },
    ],
  },
];

/**
 * PredictEscrow events — the only record of who bet what.
 *
 * Positions are readable from the contract, but they are a *current* snapshot:
 * they carry no timestamp, no tx hash, and a redeemed position reads as zero.
 * The leaderboard, the vault fee history and the per-market bet count all need
 * the history, so it has to be indexed from logs.
 */
export const ESCROW_EVENTS = [
  {
    type: "event", name: "Bet",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "bettor", type: "address", indexed: true },
      { name: "outcome", type: "uint32", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Redeem",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "bettor", type: "address", indexed: true },
      { name: "payout", type: "uint256", indexed: false },
    ],
  },
];

/**
 * Max blocks per `eth_getLogs`.
 *
 * The public Coston2 RPC hard-caps this at 30 — "requested too many blocks …
 * maximum is set to 30". At ~1.8s per block that is ~54s of history per call,
 * comfortably more than the poll interval, so keeping up costs one request per
 * tick; only a cold backfill needs many.
 */
const LOG_CHUNK = 30n;

/** Requests per invocation, so a cold backfill catches up over several ticks
 *  instead of firing thousands of calls at the public RPC in one go. */
const MAX_CHUNKS_PER_CALL = 40;

/**
 * Read PredictEscrow Bet/Redeem logs starting at `fromBlock`.
 *
 * Returns `{ rows, nextBlock, caughtUp }`. `nextBlock` is where to resume — it
 * is NOT necessarily the head, since the walk stops after MAX_CHUNKS_PER_CALL.
 * Each row carries a composite `_id` of `txHash:logIndex`, so re-indexing an
 * overlapping range is idempotent.
 */
export async function readEscrowLogs(fromBlock) {
  const head = await publicClient.getBlockNumber();
  let from = BigInt(fromBlock);
  if (from > head) return { rows: [], nextBlock: head + 1n, caughtUp: true };

  const rows = [];
  let chunks = 0;
  while (from <= head && chunks < MAX_CHUNKS_PER_CALL) {
    chunks += 1;
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const logs = await publicClient.getLogs({
      address: getAddress(CONTRACTS.predictEscrow),
      events: ESCROW_EVENTS,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const kind = log.eventName === "Bet" ? "bet" : "redeem";
      const raw = kind === "bet" ? log.args.amount : log.args.payout;
      rows.push({
        _id: `${log.transactionHash}:${log.logIndex}`,
        kind,
        market: log.args.marketId,
        address: getAddress(log.args.bettor),
        outcome: kind === "bet" ? Number(log.args.outcome) : null,
        amount: Number(raw) / U,
        blockNumber: Number(log.blockNumber),
        txHash: log.transactionHash,
      });
    }
    from = to + 1n;
  }

  // Logs carry no timestamp. Fetch it once per distinct block rather than once
  // per log — a batch of bets usually lands in a handful of blocks.
  const blocks = [...new Set(rows.map((r) => r.blockNumber))];
  const times = new Map(
    await Promise.all(
      blocks.map(async (n) => {
        const b = await publicClient.getBlock({ blockNumber: BigInt(n) }).catch(() => null);
        return [n, b ? Number(b.timestamp) * 1000 : Date.now()];
      }),
    ),
  );
  for (const r of rows) r.ts = times.get(r.blockNumber) ?? Date.now();

  return { rows, nextBlock: from, caughtUp: from > head };
}

/**
 * The explorer's log API, used for the one thing `eth_getLogs` cannot do here:
 * reach back further than the last few hours.
 *
 * The 30-block cap above is fine for keeping up and hopeless for catching up.
 * The escrow was deployed millions of blocks into Coston2's history, and at 30
 * blocks a call with 40 calls a tick, a backfill from the deploy would need tens
 * of thousands of ticks — which is why the cold-start cursor gives up and begins
 * at head-6000, leaving every earlier bet permanently invisible to the
 * leaderboard.
 *
 * Blockscout serves the same logs paginated with no block-range limit. Ported
 * from _references/flare-prediction-market, which hit the identical wall.
 *
 * ONE DIFFERENCE FROM THE REFERENCE, AND IT MATTERS: it matched on
 * `item.decoded.method_call`, which the explorer only populates for VERIFIED
 * contracts. Molfi's are not verified, so `decoded` comes back `null` on every
 * row and that approach silently indexes nothing — no error, just an empty
 * leaderboard. Topics and data are always present, so they are decoded here
 * with the same ABI the RPC path uses.
 */
const EXPLORER_API = process.env.MOLFI_EXPLORER_API || `${"https://coston2-explorer.flare.network"}/api/v2`;
const EXPLORER_MAX_PAGES = Number(process.env.MOLFI_EXPLORER_MAX_PAGES || 100);

export async function readEscrowLogsViaExplorer(fromBlock = 0) {
  const address = getAddress(CONTRACTS.predictEscrow);
  const rows = [];
  let url = `${EXPLORER_API}/addresses/${address}/logs`;
  let pages = 0;
  let truncated = false;

  while (url && pages < EXPLORER_MAX_PAGES) {
    pages += 1;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`explorer ${res.status} on ${url}`);
    const body = await res.json();
    const items = body.items ?? [];

    let reachedFloor = false;
    for (const item of items) {
      const blockNumber = Number(item.block_number);
      if (blockNumber < fromBlock) {
        // Results come newest-first, so anything below the floor means the rest
        // of this page — and every later page — is already indexed.
        reachedFloor = true;
        continue;
      }
      let decoded;
      try {
        decoded = decodeEventLog({ abi: ESCROW_EVENTS, topics: item.topics, data: item.data });
      } catch {
        continue; // an event this ABI does not describe
      }
      if (decoded.eventName !== "Bet" && decoded.eventName !== "Redeem") continue;

      const kind = decoded.eventName === "Bet" ? "bet" : "redeem";
      const raw = kind === "bet" ? decoded.args.amount : decoded.args.payout;
      rows.push({
        _id: `${item.transaction_hash}:${Number(item.index)}`,
        kind,
        market: decoded.args.marketId,
        address: getAddress(decoded.args.bettor),
        outcome: kind === "bet" ? Number(decoded.args.outcome) : null,
        amount: Number(raw) / U,
        blockNumber,
        txHash: item.transaction_hash,
        // Included in the payload — the RPC path has to fetch each block
        // separately for this.
        ts: new Date(item.block_timestamp).getTime(),
      });
    }

    if (reachedFloor || !body.next_page_params) break;
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
    url = `${EXPLORER_API}/addresses/${address}/logs?${qs}`;
    if (pages + 1 >= EXPLORER_MAX_PAGES) truncated = true;
  }

  // A silent cap would read as "fully backfilled" when it is not.
  return { rows, pages, truncated };
}

/**
 * Settlement prices, keyed by market id, from MolfiMarket's `Resolved` event.
 *
 * The market struct does not store the price it settled against — only the
 * winning outcome — so a resolved market rendered "Settles at —", which reads
 * as broken data rather than as a settled market. The price is in the event,
 * so read it from there.
 *
 * Uses the explorer for the same reason the escrow indexer does: Coston2's RPC
 * caps `eth_getLogs` at 30 blocks, which cannot reach a market that settled an
 * hour ago.
 */
const RESOLVED_EVENT = [
  {
    type: "event",
    name: "Resolved",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "winningOutcome", type: "uint32", indexed: false },
      { name: "price", type: "uint256", indexed: false },
    ],
  },
];

let settleCache = { at: 0, byId: new Map() };
const SETTLE_TTL_MS = 60_000;

export async function settlePrices() {
  if (Date.now() - settleCache.at < SETTLE_TTL_MS) return settleCache.byId;

  const address = getAddress(CONTRACTS.market);
  const byId = new Map();
  let url = `${EXPLORER_API}/addresses/${address}/logs`;
  let pages = 0;

  while (url && pages < EXPLORER_MAX_PAGES) {
    pages += 1;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`explorer ${res.status} on ${url}`);
    const body = await res.json();
    for (const item of body.items ?? []) {
      let decoded;
      try {
        decoded = decodeEventLog({ abi: RESOLVED_EVENT, topics: item.topics, data: item.data });
      } catch {
        continue;
      }
      if (decoded.eventName !== "Resolved") continue;
      // `emit Resolved(id, outcome, 0)` is the manual-resolve path, which has
      // no oracle price. Zero means "unknown", not "settled at zero".
      const price = Number(decoded.args.price) / 1e18;
      if (price > 0 && !byId.has(decoded.args.id)) byId.set(decoded.args.id, price);
    }
    if (!body.next_page_params) break;
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)])),
    ).toString();
    url = `${EXPLORER_API}/addresses/${address}/logs?${qs}`;
  }

  settleCache = { at: Date.now(), byId };
  return byId;
}

export const FXRP_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

export const ORACLE_ABI = [
  { type: "function", name: "getPrice", stateMutability: "view", inputs: [{ type: "bytes21" }], outputs: [{ name: "price", type: "uint256" }, { name: "timestamp", type: "uint64" }] },
  { type: "function", name: "getRawFeed", stateMutability: "view", inputs: [{ type: "bytes21" }], outputs: [{ name: "value", type: "uint256" }, { name: "decimals", type: "int8" }, { name: "timestamp", type: "uint64" }] },
];

const asHex = (h) => (String(h).startsWith("0x") ? h : `0x${h}`);

/** Generic read-only contract call. */
export async function readContract(address, abi, functionName, args = []) {
  if (!address) throw new Error(`missing contract address for ${functionName}`);
  return publicClient.readContract({
    address: getAddress(address),
    abi,
    functionName,
    args,
  });
}

/** Enumerate on-chain market ids (32-byte hex). */
export async function listMarketIds() {
  const ids = await readContract(CONTRACTS.market, MARKET_ABI, "markets");
  return ids ?? [];
}

/** Read a single market's state. Returns null on missing/revert. */
export async function getMarket(idHex) {
  try {
    const [question, closeTs, status, outcome] = await readContract(
      CONTRACTS.market, MARKET_ABI, "getMarket", [asHex(idHex)],
    );
    return {
      question,
      closeTs: Number(closeTs),
      status: Number(status),
      outcome: Number(outcome),
    };
  } catch {
    return null;
  }
}

/** Full market record including its FTSO feed and strike. */
export async function getMarketFull(idHex) {
  try {
    const m = await readContract(CONTRACTS.market, MARKET_ABI, "marketOf", [asHex(idHex)]);
    if (!m || !m[8]) return null; // exists
    return {
      question: m[0],
      closeTs: Number(m[1]),
      feedId: m[2],
      strike: Number(m[3]) / 1e18, // oracle prices are 18-decimal
      op: Number(m[4]),
      maxStaleness: Number(m[5]),
      status: Number(m[6]),
      outcome: Number(m[7]),
      exists: Boolean(m[8]),
      hasOracle: Boolean(m[9]),
    };
  } catch {
    return null;
  }
}

/**
 * The price this market would settle at right now, straight from the contract.
 * Free (`view`), and identical to what settlement will use.
 */
export async function previewResolution(idHex) {
  try {
    const r = await readContract(CONTRACTS.market, MARKET_ABI, "previewResolution", [asHex(idHex)]);
    return {
      price: Number(r[0]) / 1e18,
      timestamp: Number(r[1]),
      wouldBeYes: Boolean(r[2]),
    };
  } catch {
    return null;
  }
}

export async function isResolved(idHex) {
  try {
    return Boolean(await readContract(CONTRACTS.market, MARKET_ABI, "isResolved", [asHex(idHex)]));
  } catch {
    return false;
  }
}

export async function winningOutcome(idHex) {
  return Number(await readContract(CONTRACTS.market, MARKET_ABI, "winningOutcome", [asHex(idHex)]));
}

/** Both-sided escrow pools (human units) for a market. */
export async function escrowPools(idHex) {
  try {
    const p = await readContract(CONTRACTS.predictEscrow, ESCROW_ABI, "pools", [asHex(idHex)]);
    return {
      yes: Number(p[0]) / U,
      no: Number(p[1]) / U,
      total: Number(p[2]) / U,
    };
  } catch {
    return { yes: 0, no: 0, total: 0 };
  }
}

/** A wallet's escrowed stake (human units) on (market, outcome). */
export async function escrowPosition(idHex, outcome, who) {
  const v = await readContract(
    CONTRACTS.predictEscrow, ESCROW_ABI, "position", [asHex(idHex), outcome, getAddress(who)],
  ).catch(() => 0n);
  return Number(v) / U;
}

/** FXRP balance (base units, as BigInt). */
export async function fxrpBalance(who) {
  const v = await readContract(CONTRACTS.fxrp, FXRP_ABI, "balanceOf", [getAddress(who)]).catch(() => 0n);
  return BigInt(v);
}

/** Back-compat alias — the app/SDK historically called this musdcBalance. */
export const musdcBalance = fxrpBalance;

/**
 * Read an FTSOv2 price for `symbol` (XRP/FLR/BTC/ETH) through the deployed
 * FtsoOracle. Returns the USD price as a human number, or null.
 *
 * This is the same value the market contract settles on — the backend and the
 * chain cannot disagree about price, because they read the same contract.
 */
export async function ftsoPrice(symbol) {
  const feedId = FEEDS[String(symbol).toUpperCase()];
  if (!feedId || !CONTRACTS.ftsoOracle) return null;
  try {
    const [price] = await readContract(CONTRACTS.ftsoOracle, ORACLE_ABI, "getPrice", [feedId]);
    return Number(price) / 1e18;
  } catch {
    return null;
  }
}

/** Read every supported feed at once. Returns { SYM: price|null }. */
export async function ftsoPrices() {
  const out = {};
  await Promise.all(
    Object.keys(FEEDS).map(async (sym) => {
      out[sym] = await ftsoPrice(sym);
    }),
  );
  return out;
}

/** Back-compat alias for the old Chainlink entry point. */
export const chainlinkPrice = ftsoPrice;

export const EXPLORER = "https://coston2-explorer.flare.network";
export const txUrl = (h) => `${EXPLORER}/tx/${h}`;
export const addressUrl = (a) => `${EXPLORER}/address/${a}`;
