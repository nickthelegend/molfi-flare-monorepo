/**
 * Decompose an arbitrary stake into standard confidential-bet notes.
 *
 * The user types any amount. This turns it into notes the protocol can keep
 * uniform, exactly the way cash makes change: 137 = 1x100 + 3x10 + 7x1.
 *
 * Greedy is optimal here because the ladder is canonical (each denomination
 * divides the next), so it always yields the fewest notes — which matters,
 * since note count is the one thing a deposit leaks.
 *
 * Kept byte-identical in logic to molfi-backend/stake-plan.js. Both sides must
 * agree or the client would escrow a different total than it built notes for.
 */

/** Amounts are whole multiples of the smallest note; anything finer can't be
 *  represented and would silently round away part of the stake. */
export function planStake(amount: number | string, denoms: readonly number[]): number[] {
  const tiers = [...denoms].map(Number).sort((a, b) => a - b);
  const smallest = tiers[0];
  const amt = Number(amount);

  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error("amount must be greater than 0");
  }
  // Compare in units of the smallest note to dodge float dust (0.1+0.2 != 0.3).
  const units = Math.round(amt / smallest);
  if (Math.abs(units * smallest - amt) > 1e-9) {
    throw new Error(`amount must be a multiple of ${smallest} FXRP`);
  }

  const notes: number[] = [];
  let left = units;
  for (let i = tiers.length - 1; i >= 0; i--) {
    const step = Math.round(tiers[i] / smallest);
    const count = Math.floor(left / step);
    for (let k = 0; k < count; k++) notes.push(i);
    left -= count * step;
  }
  return notes; // tier indices, largest first
}

/** `[{ tier, denom, count }]`, largest first — for display. */
export function summarizePlan(
  notes: readonly number[],
  denoms: readonly number[],
): { tier: number; denom: number; count: number }[] {
  const byTier = new Map<number, number>();
  for (const t of notes) byTier.set(t, (byTier.get(t) ?? 0) + 1);
  return [...byTier.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([tier, count]) => ({ tier, denom: Number(denoms[tier]), count }));
}

/** Human summary, e.g. "1x100 + 3x10 + 7x1". */
export function describePlan(notes: readonly number[], denoms: readonly number[]): string {
  return summarizePlan(notes, denoms)
    .map(({ denom, count }) => `${count}x${denom}`)
    .join(" + ");
}
