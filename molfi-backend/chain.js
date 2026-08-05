/**
 * Molfi backend on-chain layer — **Flare Coston2** (viem).
 *
 * Read-only: a public client reads MolfiMarket / PredictEscrow / FXRP and the
 * FTSOv2 price feeds. There are NO write paths here — the backend never
 * broadcasts a transaction (the app's own wallet sends the real on-chain bets).
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
import { createPublicClient, defineChain, http, getAddress } from "viem";
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
  blockExplorers: {
    default: {
      name: "Coston2 Explorer",
      url: "https://coston2-explorer.flare.network",
    },
  },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: coston2Chain,
  transport: http(COSTON2.rpcUrl),
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
