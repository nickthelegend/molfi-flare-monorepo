/**
 * BN254 Groth16 ZK layer for Molfi's confidential betting.
 *
 * Uses the compiled confidential_bet circuit
 * (molfi-circuits/build/confidential_bet/) via snarkjs. Public signals order is
 * `[root, nullifierHash, outcome, recipient]` — mirrors
 * molfi-predict-sdk/demo/agent-confidential-bet.mjs. Proofs are returned in the
 * Solidity-calldata shape the on-chain BN254 verifier expects (a:[2],
 * b:[2][2] with G2 coords swapped, c:[2]).
 */
import { groth16 } from "snarkjs";
import { randomBytes, createHash } from "node:crypto";
import { keccak256, encodeAbiParameters } from "viem";
import { planStake, describePlan, summarizePlan } from "./stake-plan.js";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CIRCUIT_DIR =
  process.env.MOLFI_CONF_CIRCUIT ||
  `${HERE}../molfi-circuits/build/confidential_bet`;
export const WASM = `${CIRCUIT_DIR}/confidential_bet_js/confidential_bet.wasm`;
export const ZKEY = `${CIRCUIT_DIR}/final.zkey`;

/**
 * Selectable stake sizes, in whole FXRP, read from the deploy artifact.
 *
 * A single fixed size was never about hiding the amount — the amount moves
 * through `transferFrom` and is public regardless. It buys UNLINKABILITY:
 * uniform deposits mean a payout can't be traced to one deposit. Tiers keep
 * that within each tier while letting people size a position.
 *
 * Derived, never hardcoded: these numbers are printed verbatim in the bet
 * ticket, and they were once 100/200 against a contract whose denom was 1 FXRP.
 */
function loadConfDenoms() {
  try {
    const d = JSON.parse(
      readFileSync(`${HERE}../molfi-contracts/deployments/coston2.json`, "utf8"),
    );
    const dec = Number(d.fxrpDecimals ?? 6);
    const raw = Array.isArray(d.confDenoms) && d.confDenoms.length
      ? d.confDenoms
      : [d.confDenom ?? 1_000_000];
    return raw.map((v) => Number(v) / 10 ** dec);
  } catch {
    return [1];
  }
}
export const CONF_DENOMS = loadConfDenoms();
export const CONF_PAYOUT_MULT = 2;
/** Back-compat: the smallest tier, for callers that predate tiering. */
export const CONF_DENOM = CONF_DENOMS[0];
export const CONF_PAYOUT = CONF_DENOM * CONF_PAYOUT_MULT;

/** BN254 scalar field order — public signals must be reduced into it. */
const SNARK_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * The `outcome` public signal a note must carry:
 *   keccak256(abi.encode(bytes32 marketId, uint256 tier, uint256 side)) % r
 *
 * MUST match ConfidentialBet.sideSignal exactly — the contract recomputes it
 * from the resolved winner and the tier the caller names, so any disagreement
 * makes every proof fail rather than mis-pay. abi.encode of (bytes32, uint256,
 * uint256) is just three left-padded 32-byte words.
 */
export function sideSignal(marketId, tier, side) {
  // keccak256, NOT node's "sha3-256" — those are different functions (padding
  // differs), and a mismatch here would make every proof fail at claim time.
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
    [marketId, BigInt(tier), BigInt(side)],
  );
  return (BigInt(keccak256(encoded)) % SNARK_R).toString();
}

/** True if the compiled circuit artifacts are present (proofs can be generated). */
export function circuitAvailable() {
  return existsSync(WASM) && existsSync(ZKEY);
}

/** A random BN254 field element (< 2^248, safely below the field modulus) as a decimal string. */
export function confField() {
  return BigInt("0x" + randomBytes(31).toString("hex")).toString();
}

/**
 * snarkjs G1/G2 → Solidity calldata shape. G2 coordinates are swapped relative
 * to the EVM verifier (mirrors the SDK demo's toSol()).
 */
export function toSolProof(p) {
  return {
    a: [p.pi_a[0], p.pi_a[1]],
    b: [
      [p.pi_b[0][1], p.pi_b[0][0]],
      [p.pi_b[1][1], p.pi_b[1][0]],
    ],
    c: [p.pi_c[0], p.pi_c[1]],
  };
}

/**
 * Build a confidential note for `side` ("YES" | "NO"). The commitment is a
 * binding hash of the note that reveals nothing about the chosen outcome.
 */
export function prepareCommit(side, marketId, tier = 0) {
  const s = String(side || "YES").toUpperCase();
  const sideBit = s === "NO" ? 1 : 0;
  if (!marketId) throw new Error("marketId is required — a note is bound to one market");
  if (!(tier >= 0 && tier < CONF_DENOMS.length)) throw new Error(`bad tier ${tier}`);

  // The note's `outcome` is NOT the raw 0/1 — it is the market+tier-bound
  // signal. That binding is what stops a 1 FXRP note being claimed at 1000, and
  // a losing note on one market being claimed on another.
  const outcome = sideSignal(marketId, tier, sideBit);
  const note = { secret: confField(), nullifier: confField(), outcome, recipient: confField() };
  const commitment = createHash("sha256")
    .update([note.secret, note.nullifier, String(note.outcome), note.recipient].join("|"))
    .digest("hex");
  return {
    note,
    commitment,
    marketId,
    tier,
    denom: CONF_DENOMS[tier],
    payout: CONF_DENOMS[tier] * CONF_PAYOUT_MULT,
    side: sideBit === 0 ? "YES" : "NO",
  };
}

/**
 * Generate a BN254 Groth16 proof for a confidential note. Returns the proof in
 * Solidity-calldata shape plus the public signals `[root, nullifierHash,
 * outcome, recipient]`.
 */
export async function proveNote(note, recipient) {
  // The recipient public signal MUST equal uint256(uint160(claimer)) — that's what
  // ConfidentialBet.claim injects and the verifier checks. Bind it to the claiming
  // address (0x…); fall back to the note's field only if none is supplied.
  const recipientField =
    recipient != null && String(recipient).startsWith("0x")
      ? BigInt(recipient).toString()
      : String(note.recipient);
  const input = {
    secret: String(note.secret),
    nullifier: String(note.nullifier),
    outcome: String(note.outcome),
    recipient: recipientField,
    pathElements: ["1", "2", "3", "4", "5", "6", "7", "8"],
    pathIndices: ["0", "1", "0", "1", "0", "0", "1", "0"],
  };
  const { proof, publicSignals } = await groth16.fullProve(input, WASM, ZKEY);
  return {
    proof: toSolProof(proof),
    root: publicSignals[0],
    nullifierHash: publicSignals[1],
    outcome: publicSignals[2],
    recipientField: publicSignals[3],
    publicSignals,
  };
}

/**
 * Build the notes for an ARBITRARY stake amount.
 *
 * Returns one note per standard denomination the amount decomposes into, each
 * independently claimable. The caller escrows the total in a single
 * `commitBatch`, and claims note by note afterwards.
 */
export function prepareCommitBatch(side, marketId, amount) {
  const notes = planStake(amount, CONF_DENOMS);
  if (notes.length > 40) {
    throw new Error(
      `${amount} FXRP needs ${notes.length} notes, over the 40-note batch cap — ` +
        `round to a larger denomination.`,
    );
  }
  const prepared = notes.map((tier) => prepareCommit(side, marketId, tier));
  return {
    marketId,
    side: prepared[0].side,
    amount: Number(amount),
    payout: Number(amount) * CONF_PAYOUT_MULT,
    noteCount: prepared.length,
    plan: summarizePlan(notes, CONF_DENOMS),
    planLabel: describePlan(notes, CONF_DENOMS),
    notes: prepared,
  };
}

export { planStake, describePlan, summarizePlan };
