/**
 * Quote shapes shared with the position-metrics maths.
 *
 * This file used to build Sui programmable transactions to read DeepBook
 * Predict quotes. That layer is gone; only the two types that `position-metrics`
 * computes over are still referenced, so only they remain.
 */

export type RedeemQuote = {
  marketBidPerUnit: bigint;
  expectedPayout: bigint;
};

export type PositionLedgerHealthInputs = {
  borrowedQuote: bigint;
  leverageBps: bigint;
  keyQuoteBalance: bigint;
};

/** On-chain key ledger fields used for liquidation health (matches keeper dev-inspect). */
