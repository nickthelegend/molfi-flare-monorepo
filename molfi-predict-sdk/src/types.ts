/** Core CLOB order types for Molfi prediction markets (EVM / Flare Coston2). */

export type Side = "BUY" | "SELL";
export type Outcome = "YES" | "NO";

/** A CLOB order before signing. Prices are probabilities in [0, 1]. */
export interface Order {
  /** Market identifier (32-byte hex market id). */
  market: string;
  side: Side;
  outcome: Outcome;
  /** Probability price, 0..1. */
  price: number;
  /** Number of outcome shares. */
  size: number;
  /** EVM address (0x…) placing the order. Filled in at sign time if omitted. */
  maker?: string;
  /** Unix ms; defaults to now at build time. */
  expiry?: number;
  /** Anti-replay nonce; defaults to a random value at build time. */
  nonce?: string;
}
