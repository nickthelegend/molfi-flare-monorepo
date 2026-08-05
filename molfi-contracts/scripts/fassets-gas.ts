/**
 * Gas handling for FAssets FXRP.
 *
 * WHY THIS EXISTS — a real, reproducible Coston2 gotcha:
 *
 * `eth_estimateGas` under-estimates FXRP transfers. Measured on Coston2, an
 * FXRP `transfer` consistently BURNS 151,388 gas, but estimateGas intermittently
 * returns 130,981 depending on state. When the low estimate is used as the gas
 * limit the transaction runs out of gas and reverts with `status: 0` and EMPTY
 * revert data — which looks exactly like a policy rejection ("the token refused
 * my transfer") and sends you hunting for a whitelist that does not exist.
 *
 * The cause is that FAssets does extra bookkeeping on transfer (transfer-fee
 * epoch accounting) whose cost depends on whether an epoch boundary is crossed.
 * Estimation samples current state; execution may land on the expensive path.
 *
 * So: never let ethers estimate gas for a call that moves FXRP. That includes
 * calls that move it INDIRECTLY — PredictEscrow.bet does `transferFrom` and
 * redeem does `transfer`, so they inherit the same variance.
 */

/** Comfortably above the observed 151,388 worst case, plus escrow overhead. */
export const FXRP_GAS = { gasLimit: 900_000n };

/** Approvals are cheap and predictable, but kept explicit for consistency. */
export const FXRP_APPROVE_GAS = { gasLimit: 200_000n };

/**
 * Generous limit for Molfi contract writes.
 *
 * `resolveFromOracle` is under-estimated for the same reason: it resolves
 * FTSOv2 through ContractRegistry and reads a feed, and the cost depends on
 * FTSO's internal state at execution time rather than at estimation time. A
 * settlement that runs out of gas leaves the market unresolved with an empty
 * revert — indistinguishable from a stale-feed rejection unless you probe with
 * a staticCall first.
 */
export const TX_GAS = { gasLimit: 1_500_000n };
