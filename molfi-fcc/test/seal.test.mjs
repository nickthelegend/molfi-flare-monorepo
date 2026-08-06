/**
 * The sealing layer is the confidentiality guarantee. If any of these fail, a
 * sealed bid is readable or forgeable by someone who should not be able to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sealSide, openSealed, enclaveKeypair, CIPHERTEXT_BYTES } from "../src/seal.mjs";

const MKT = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

test("the enclave — and only the enclave — can read a sealed side", () => {
  const e = enclaveKeypair();
  for (const side of [0, 1]) {
    const ct = sealSide(e.publicKey, MKT, ALICE, side);
    assert.equal(openSealed(e.privateKey, MKT, ALICE, ct), side);
  }

  // A different enclave key cannot.
  const other = enclaveKeypair();
  const ct = sealSide(e.publicKey, MKT, ALICE, 1);
  assert.throws(() => openSealed(other.privateKey, MKT, ALICE, ct));
});

test("every ciphertext is the same length, so size leaks nothing", () => {
  const e = enclaveKeypair();
  const lens = new Set();
  for (let i = 0; i < 20; i++) {
    const ct = sealSide(e.publicKey, MKT, ALICE, i % 2);
    lens.add((ct.length - 2) / 2);
  }
  assert.deepEqual([...lens], [CIPHERTEXT_BYTES]);
});

test("two seals of the SAME side are not equal — no side leaks by comparison", () => {
  // Deterministic encryption would let anyone bucket the book into two groups
  // and read the split without a key at all.
  const e = enclaveKeypair();
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(sealSide(e.publicKey, MKT, ALICE, 0));
  assert.equal(seen.size, 50);
});

test("a sealed bid cannot be replayed into another market", () => {
  const e = enclaveKeypair();
  const ct = sealSide(e.publicKey, MKT, ALICE, 0);
  assert.equal(openSealed(e.privateKey, MKT, ALICE, ct), 0);
  assert.throws(
    () => openSealed(e.privateKey, OTHER, ALICE, ct),
    /unable to authenticate|Unsupported state|bad decrypt/i,
  );
});

test("a sealed bid cannot be lifted by another bidder", () => {
  const e = enclaveKeypair();
  const ct = sealSide(e.publicKey, MKT, ALICE, 0);
  assert.throws(() => openSealed(e.privateKey, MKT, BOB, ct));
});

test("a tampered ciphertext is rejected, never guessed at", () => {
  const e = enclaveKeypair();
  const ct = sealSide(e.publicKey, MKT, ALICE, 0);
  const buf = Buffer.from(ct.slice(2), "hex");
  buf[buf.length - 1] ^= 0xff; // flip the payload
  assert.throws(() => openSealed(e.privateKey, MKT, ALICE, `0x${buf.toString("hex")}`));

  const buf2 = Buffer.from(ct.slice(2), "hex");
  buf2[5] ^= 0xff; // flip the ephemeral pubkey
  assert.throws(() => openSealed(e.privateKey, MKT, ALICE, `0x${buf2.toString("hex")}`));
});

test("rejects an out-of-range side rather than sealing nonsense", () => {
  const e = enclaveKeypair();
  assert.throws(() => sealSide(e.publicKey, MKT, ALICE, 2), /side must be 0 or 1/);
  assert.throws(() => sealSide(e.publicKey, MKT, ALICE, -1), /side must be 0 or 1/);
});

test("a keypair round-trips from its private half", () => {
  const a = enclaveKeypair();
  const b = enclaveKeypair(a.privateKey);
  assert.equal(b.publicKey, a.publicKey);
});
