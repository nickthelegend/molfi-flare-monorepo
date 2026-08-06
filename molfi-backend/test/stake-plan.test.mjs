/**
 * The decomposition is what turns "stake any amount" into notes the protocol
 * can keep uniform. If it ever loses value or emits a tier that does not exist,
 * a user's stake silently shrinks — so pin it hard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planStake, describePlan, summarizePlan } from "../stake-plan.js";

const D = [1, 10, 100, 1000];
const total = (notes) => notes.reduce((s, t) => s + D[t], 0);

test("decomposes an arbitrary amount exactly", () => {
  assert.equal(describePlan(planStake(137, D), D), "1x100 + 3x10 + 7x1");
  assert.equal(describePlan(planStake(1042, D), D), "1x1000 + 4x10 + 2x1");
  assert.equal(describePlan(planStake(1, D), D), "1x1");
});

test("never loses value, for every amount up to 2000", () => {
  for (let a = 1; a <= 2000; a++) {
    assert.equal(total(planStake(a, D)), a, `lost value at ${a}`);
  }
});

test("is minimal — a canonical ladder makes greedy optimal", () => {
  // 999 is the worst case under 1000: 9+9+9.
  assert.equal(planStake(999, D).length, 27);
  // Any single denomination is exactly one note.
  for (const d of D) assert.equal(planStake(d, D).length, 1);
});

test("only ever emits tiers that exist", () => {
  for (let a = 1; a <= 500; a++) {
    for (const t of planStake(a, D)) {
      assert.ok(t >= 0 && t < D.length, `bad tier ${t} at amount ${a}`);
    }
  }
});

test("rejects amounts the notes cannot represent", () => {
  // Sub-denomination dust would round away part of the stake.
  assert.throws(() => planStake(0.5, D), /multiple of 1/);
  assert.throws(() => planStake(1.5, D), /multiple of 1/);
  assert.throws(() => planStake(0, D), /greater than 0/);
  assert.throws(() => planStake(-5, D), /greater than 0/);
  assert.throws(() => planStake("abc", D), /greater than 0/);
});

test("summarizePlan groups largest-first for display", () => {
  const s = summarizePlan(planStake(137, D), D);
  assert.deepEqual(s, [
    { tier: 2, denom: 100, count: 1 },
    { tier: 1, denom: 10, count: 3 },
    { tier: 0, denom: 1, count: 7 },
  ]);
});

test("float dust does not break the multiple check", () => {
  // 0.1 + 0.2 = 0.30000000000000004; a naive % would reject legitimate totals.
  const fine = [1, 10];
  assert.equal(total(planStake(0.1 + 0.2 + 0.7, fine)), 1);
});
