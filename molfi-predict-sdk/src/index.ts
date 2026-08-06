/**
 * molfi-predict-sdk — the modular SDK for Molfi on Flare Coston2.
 *
 * Two layers, one package:
 *  • Agent layer (`MolfiAgent`, `MolfiChain`, wallet, data) — generate a
 *    wallet, fund its gas, read live markets/odds, and place REAL on-chain
 *    (FXRP-escrowed, optionally ZK-gated) bets. This is what lets an AI agent
 *    trade autonomously. See SKILL.md.
 *  • CLOB layer (`signClobOrder`, `buildOrder`) — canonical order signing for a
 *    limit order book. Signing is real and tested; the matching engine and the
 *    on-chain settlement verifier are NOT built, so nothing consumes these
 *    orders yet. Treat it as the wire format, not a working exchange.
 */

// ── Agent / on-chain layer ───────────────────────────────────────────────────
export { MolfiAgent } from "./agent.js";
export type { OnboardResult } from "./agent.js";
export { MolfiChain } from "./chain.js";
export type { Groth16Proof, ChainOptions } from "./chain.js";
export { generateWallet, walletFromSecret } from "./wallet.js";
export type { MolfiWallet } from "./wallet.js";
export {
  TESTNET,
  toBaseUnits,
  fromBaseUnits,
  OUTCOME_YES,
  OUTCOME_NO,
} from "./config.js";
export type { MolfiConfig, MolfiContracts } from "./config.js";
export {
  fetchMarkets,
  fetchMarket,
  fetchOrderBook,
  fetchPrices,
  fetchLeaderboard,
  fetchVaults,
  fetchOnChainMarkets,
} from "./data.js";
export type {
  BackendMarket,
  OrderBook,
  OrderLevel,
  PricePoint,
  LeaderboardRow,
  Vault,
  OnChainMarketRef,
} from "./data.js";

// ── CLOB order-signing layer ─────────────────────────────────────────────────
export {
  canonicalOrderBytes,
  signClobOrder,
  PrivateKeyOrderSigner,
} from "./clob.js";
export type { ClobOrder, SignedClobOrder, OrderSigner } from "./clob.js";

export { buildOrder, canonicalize } from "./order.js";
export type { Side, Outcome, Order } from "./types.js";

// `MolfiClient` used to live here. It was fork residue from the Stellar build:
// it POSTed to `${apiUrl}/v1/orders`, an endpoint that exists nowhere in this
// repo, and its `signOrder` took a Stellar `Signer` (base64 ed25519 over a
// pubkey string) while the only implementation the package ships,
// `PrivateKeyOrderSigner`, is secp256k1 over `Uint8Array`. Passing one to the
// other produced a `SignedOrder` whose `maker` serialized as `{"0":0,"1":0,…}`.
// Removed rather than repaired — making it compile would only have made broken
// code typecheck. Use `signClobOrder` + `PrivateKeyOrderSigner` above.
