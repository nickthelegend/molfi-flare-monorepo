// BN254 confidential-proof tests — exercise the REAL snarkjs proof generation
// against the compiled confidential_bet circuit. These are the honest proof the
// ZK layer was ported to BN254 (mirrors the SDK demo). Slower (proof-gen), so
// kept in their own file; skipped cleanly if the circuit artifacts are absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as zk from "../zk.js";
import { bootApp, mockChain } from "./helpers.mjs";

const have = zk.circuitAvailable();

test("zk.proveNote produces a Solidity-shaped BN254 proof + [root,nullifier,outcome,recipient]", { skip: !have && "circuit artifacts not built" }, async () => {
  const note = { secret: zk.confField(), nullifier: zk.confField(), outcome: 0, recipient: zk.confField() };
  const p = await zk.proveNote(note);
  // proof shape: a[2], b[2][2], c[2]
  assert.equal(p.proof.a.length, 2);
  assert.equal(p.proof.b.length, 2);
  assert.equal(p.proof.b[0].length, 2);
  assert.equal(p.proof.c.length, 2);
  // public signals: [root, nullifierHash, outcome, recipient]
  assert.equal(p.publicSignals.length, 4);
  assert.equal(String(p.outcome), "0");
  assert.match(String(p.root), /^\d+$/);
  assert.match(String(p.nullifierHash), /^\d+$/);
});

test("GET /api/zk/proof returns a fresh BN254 proof", { skip: !have && "circuit artifacts not built" }, async () => {
  const h = await bootApp();
  try {
    const { status, body } = await h.get("/api/zk/proof");
    assert.equal(status, 200);
    assert.equal(body.proof.a.length, 2);
    assert.equal(body.publicInputs.length, 4);
  } finally {
    await h.close();
  }
});

test("confidential/prepare-claim WON path generates a real proof for the winning side", { skip: !have && "circuit artifacts not built" }, async () => {
  // Winner = 0 (YES); the note also backs 0 → won, so a proof is generated.
  const h = await bootApp({
    chain: mockChain({ isResolved: async () => true, winningOutcome: async () => 0 }),
  });
  try {
    // The note's outcome is the market+tier-bound signal for the WINNING side,
    // which is what the contract will inject — a bare 0 would no longer match.
    const MKT = "0x" + "fe".repeat(32);
    const note = {
      secret: zk.confField(),
      nullifier: zk.confField(),
      outcome: zk.sideSignal(MKT, 0, 0),
      recipient: zk.confField(),
    };
    const { status, body } = await h.post("/api/confidential/prepare-claim", {
      note,
      marketId: MKT,
      tier: 0,
      recipient: "0x1111111111111111111111111111111111111111",
    });
    assert.equal(status, 200);
    assert.equal(body.resolved, true);
    assert.equal(body.won, true);
    assert.equal(body.winningOutcome, 0);
    assert.equal(body.payout, zk.CONF_DENOMS[0] * zk.CONF_PAYOUT_MULT);
    assert.equal(body.proof.a.length, 2);
    assert.match(String(body.root), /^\d+$/);
    assert.match(String(body.nullifierHash), /^\d+$/);

    // The root MUST have been published for this exact (market, tier) before
    // the proof was returned. ConfidentialBet.claim rejects an unregistered
    // root outright, so a proof handed back without this is dead on arrival —
    // which is exactly what shipped until the claim path was wired to the
    // keeper. Assert the registration, not just the proof.
    assert.deepEqual(h.keeper.roots, [{ marketId: MKT, tier: 0, root: String(body.root) }]);
    assert.match(String(body.rootTx), /^0x[0-9a-f]{64}$/);
  } finally {
    await h.close();
  }
});

test("confidential/prepare-claim refuses to hand back a proof it could not publish", async () => {
  // A proof whose root is not on-chain is worse than no proof: the wallet pays
  // gas for a claim that always reverts with UnknownRoot. 503 instead.
  const h = await bootApp({
    chain: mockChain({ isResolved: async () => true, winningOutcome: async () => 0 }),
    keeper: {
      ensureConfidentialRoot: async () => {
        throw new Error("keeper is out of gas");
      },
    },
  });
  try {
    const MKT = "0x" + "fe".repeat(32);
    const { status, body } = await h.post("/api/confidential/prepare-claim", {
      note: {
        secret: zk.confField(),
        nullifier: zk.confField(),
        outcome: zk.sideSignal(MKT, 0, 0),
        recipient: zk.confField(),
      },
      marketId: MKT,
      tier: 0,
      recipient: "0x1111111111111111111111111111111111111111",
    });
    assert.equal(status, 503);
    assert.match(body.error, /claim root could not be published/);
    assert.equal(body.proof, undefined);
  } finally {
    await h.close();
  }
});
