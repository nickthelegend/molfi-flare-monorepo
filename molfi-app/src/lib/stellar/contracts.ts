/**
 * Molfi — deployed **Flare Coston2** contract addresses and market constants.
 *
 * (This module keeps its `stellar/` path + export names so the premium UI keeps
 * compiling across chain migrations; the chain underneath is now Flare's
 * Coston2 C-Chain.) Override any value via VITE_* env.
 *
 * Source of truth: molfi-contracts/deployments/coston2.json
 */

/** Coston2 network config (the viem client is built from this in ./soroban). */
export const FLARE = {
  chainId: Number(import.meta.env.VITE_FLARE_CHAIN_ID ?? 114),
  rpcUrl:
    (import.meta.env.VITE_FLARE_RPC_URL as string | undefined) ??
    "https://coston2-api.flare.network/ext/C/rpc",
} as const;

/** Back-compat alias — the UI imports `FUJI` in a few places. */
export const FUJI = FLARE;

/** Legacy read-source (Soroban needed a funded account to simulate). viem reads
 * need no sender, so this is retained only for import compatibility. */
export const READ_SOURCE = "0x0000000000000000000000000000000000000000";

/** Live Coston2 deployment (see molfi-contracts/deployments/coston2.json). */
export const CONTRACTS = {
  verifier:
    (import.meta.env.VITE_VERIFIER_CONTRACT_ID as string | undefined) ??
    "0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5",
  market:
    (import.meta.env.VITE_MARKET_CONTRACT_ID as string | undefined) ??
    "0xD709773A1128c1160b292F505FAA8E3e8d0786fF",
  /** predict-escrow — FXRP-collateralized pari-mutuel betting + ZK-gated bets. */
  predictEscrow:
    (import.meta.env.VITE_PREDICT_ESCROW_CONTRACT_ID as string | undefined) ??
    "0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067",
  /** confidential-bet — hidden-side commitment notes + on-chain ZK claim. */
  confidentialBet:
    (import.meta.env.VITE_CONF_BET_CONTRACT_ID as string | undefined) ??
    "0xd765Fa0886FD534A176190828fc4A47c8C3Fbfd0",
  /** FtsoOracle — reads FTSOv2, normalized to 18 decimals. */
  ftsoOracle:
    (import.meta.env.VITE_FTSO_ORACLE_CONTRACT_ID as string | undefined) ??
    "0xABB3FAFD87F60a8dEA8C2074C1A36984305fB099",
  /**
   * FXRP — FAssets-wrapped XRP, the collateral for every market.
   *
   * Resolved on Coston2 via ContractRegistry.getAssetManagerFXRP().fAsset().
   * NOTE: unlike the mock token this replaces, FXRP has NO open mint() — it is
   * a real over-collateralized claim on XRP, so the app sends users to the
   * Flare faucet rather than minting.
   */
  fxrp:
    (import.meta.env.VITE_FXRP_CONTRACT_ID as string | undefined) ??
    "0x0b6A3645c240605887a5532109323A3E12273dc7",
  // ── legacy aliases kept for display links; escrow is the settlement contract ──
  get musdc() {
    return this.fxrp;
  },
  clobSettlement:
    (import.meta.env.VITE_PREDICT_ESCROW_CONTRACT_ID as string | undefined) ??
    "0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067",
  vault:
    (import.meta.env.VITE_PREDICT_ESCROW_CONTRACT_ID as string | undefined) ??
    "0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067",
} as const;

/**
 * FTSOv2 feed ids (bytes21): [category byte][hex-encoded name][zero padding].
 * Category 0x01 = crypto. These are IDs, not addresses — one FTSO contract
 * serves every pair, unlike Chainlink's per-pair aggregator addresses.
 */
export const FEEDS = {
  XRP: "0x015852502f55534400000000000000000000000000",
  FLR: "0x01464c522f55534400000000000000000000000000",
  BTC: "0x014254432f55534400000000000000000000000000",
  ETH: "0x014554482f55534400000000000000000000000000",
} as const;

/** The feed Molfi's flagship XRP markets settle against. */
export const XRP_USD_FEED = FEEDS.XRP;

/**
 * FXRP has 6 decimals — XRP is denominated in drops (1 XRP = 1e6 drops).
 * The token this replaced used 7, so every amount conversion changed.
 */
export const FXRP_DECIMALS = 6;
export const FXRP_UNIT = 1_000_000;
export const FXRP_SYMBOL = "FXRP";

/**
 * ConfidentialBet's fixed stake per note — `denom()` on the deployed contract
 * (molfi-contracts/deployments/coston2.json `confDenom`).
 *
 * The UI used to hardcode 100 / 200 FXRP here, a 100x overstatement of what the
 * contract actually escrows and pays. Every displayed figure now derives from
 * these two constants.
 */
export const CONF_DENOM_BASE = 1_000_000n;
export const CONF_DENOM_FXRP = Number(CONF_DENOM_BASE) / FXRP_UNIT;
export const CONF_PAYOUT_FXRP = CONF_DENOM_FXRP * 2; // PAYOUT_MULT

/** Back-compat aliases used throughout the premium UI. */
export const MUSDC_DECIMALS = FXRP_DECIMALS;
export const MUSDC_UNIT = FXRP_UNIT;

export const PREDICT_ESCROW = CONTRACTS.predictEscrow;

/** Outcome encoding shared by the market + escrow contracts. */
export const OUTCOME = { YES: 0, NO: 1, INVALID: 2 } as const;

/** Market lifecycle status from the `MolfiMarket` contract. */
export const MARKET_STATUS = { TRADING: 0, RESOLVING: 1, RESOLVED: 2 } as const;

/**
 * Markets are seeded dynamically from live FTSO prices (see
 * molfi-contracts/scripts/seed-markets.ts) rather than hardcoded at deploy
 * time, so there is no fixed id list — the app enumerates them from chain.
 */
export const MARKET_IDS = {} as const;

/** Where to get testnet FXRP + C2FLR. FXRP has no open mint. */
export const FAUCET_URL = "https://faucet.flare.network/coston2";

export const EXPLORER = "https://coston2-explorer.flare.network";
export const contractUrl = (id: string): string => `${EXPLORER}/address/${id}`;
export const txUrl = (hash: string): string => `${EXPLORER}/tx/${hash}`;
