/**
 * Network + deployed-contract configuration for Molfi on **Flare Coston2**.
 * Every address is overridable via env so the SDK works against a fresh deploy.
 */
export interface MolfiContracts {
  /** FXRP — FAssets-wrapped XRP, the collateral for every market. */
  fxrp: string;
  verifier: string;
  market: string;
  confidentialBet: string;
  /** FXRP-collateralized pari-mutuel betting + on-chain ZK-gated bets. */
  predictEscrow: string;
  /** FtsoOracle — reads FTSOv2, normalized to 18 decimals. */
  ftsoOracle: string;
  /** Back-compat alias for callers that still say `mUSDC`. */
  mUSDC: string;
}

export interface MolfiConfig {
  /** Molfi market-engine REST API (auto-rolling markets, prices, leaderboard). */
  backendUrl: string;
  /** EVM JSON-RPC endpoint (Coston2 C-Chain). */
  rpcUrl: string;
  chainId: number;
  explorer: string;
  /** FXRP has 6 decimals — XRP is denominated in drops (1 XRP = 1e6 drops). */
  decimals: number;
  contracts: MolfiContracts;
  /**
   * FTSOv2 feed ids (bytes21) — NOT addresses. One FTSO contract serves every
   * pair, keyed by id, unlike Chainlink's per-pair aggregator addresses.
   */
  feeds: Record<string, string>;
  /**
   * Explicit gas limits for calls Coston2 under-estimates.
   *
   * `eth_estimateGas` under-reports FXRP transfers (measured 151,388 actual vs
   * 130,981 estimated) and FTSO-reading writes; the resulting out-of-gas revert
   * carries EMPTY revert data, which is indistinguishable from a real rejection.
   */
  gas: { fxrp: bigint; tx: bigint; approve: bigint };
}

const env = (k: string, d: string) =>
  (typeof process !== "undefined" && process.env?.[k]) || d;

const FXRP_ADDRESS = env("MOLFI_FXRP", "0x0b6A3645c240605887a5532109323A3E12273dc7");

/**
 * Default Molfi network config — Flare Coston2 (chainId 114).
 * (Named `TESTNET` for import compatibility with the agent/chain/wallet/data
 * modules.)
 */
export const TESTNET: MolfiConfig = {
  backendUrl: env("MOLFI_BACKEND_URL", "http://localhost:4100"),
  rpcUrl: env("MOLFI_RPC", "https://coston2-api.flare.network/ext/C/rpc"),
  chainId: Number(env("MOLFI_CHAIN_ID", "114")),
  explorer: "https://coston2-explorer.flare.network",
  decimals: 6,
  contracts: {
    fxrp: FXRP_ADDRESS,
    mUSDC: FXRP_ADDRESS,
    verifier: env("MOLFI_VERIFIER", "0x7a6995201d02bE66a2394587Dc31E72818ca2365"),
    market: env("MOLFI_MARKET", "0x6a9bC905c9ba5976BBaE19A92B6Fc032Ff0233FC"),
    confidentialBet: env("MOLFI_CBET", "0xde2C0105DC046bd428E68d425ad6177507f64BBE"),
    predictEscrow: env("MOLFI_ESCROW", "0x220BB958923eF274Fe61C8318559EeC2D5c5492f"),
    ftsoOracle: env("MOLFI_ORACLE", "0xDaeBBa2A3A354E7677f5F005F0fCa0b24b8189B3"),
  },
  feeds: {
    "XRP/USD": "0x015852502f55534400000000000000000000000000",
    "FLR/USD": "0x01464c522f55534400000000000000000000000000",
    "BTC/USD": "0x014254432f55534400000000000000000000000000",
    "ETH/USD": "0x014554482f55534400000000000000000000000000",
  },
  gas: { fxrp: 900_000n, tx: 1_500_000n, approve: 200_000n },
};

/** Back-compat alias — some callers imported the config as `config`. */
export const config: MolfiConfig = TESTNET;

/** Outcome encoding shared by the market + escrow contracts. */
export const OUTCOME_YES = 0;
export const OUTCOME_NO = 1;
export const OUTCOME_INVALID = 2;

/**
 * Convert a human token amount to base units (integer). FXRP has 6
 * decimals, so `toBaseUnits(1.5)` → `1500000n`. Truncates sub-unit dust.
 */
export function toBaseUnits(amount: number | string, decimals = TESTNET.decimals): bigint {
  const s = String(amount).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === "" || s === "." || s === "-") {
    throw new Error(`invalid amount: ${amount}`);
  }
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const digits = `${whole || "0"}${fracPadded}`.replace(/^0+(?=\d)/, "");
  const value = BigInt(digits || "0");
  return neg ? -value : value;
}

/** Convert base units back to a human number. Inverse of {@link toBaseUnits}. */
export function fromBaseUnits(base: bigint | number | string, decimals = TESTNET.decimals): number {
  const b = BigInt(base);
  const divisor = 10n ** BigInt(decimals);
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0");
  const num = Number(`${whole}.${fracStr}`);
  return neg ? -num : num;
}
