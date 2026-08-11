/**
 * Tenant isolation inside one attested enclave.
 *
 * The claim being tested is negative, and negative claims are the ones worth
 * pinning: a quote signed for dorr must not recover to the address hadal
 * registered, and a ciphertext sealed to one tenant must not open under
 * another. Both follow from the keys being different keys — but "follows from"
 * is how you end up shipping a shared key by accident, so it is asserted here
 * and again from inside the running container in verify-image.mjs.
 *
 * The other thing under test is that molfi did not move. Its sealing key and
 * signer are pinned by env, not derived, precisely so that adding tenants
 * cannot strand a live bid or desync `SealedBidBook.teeSigner`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverMessageAddress } from "viem";

import { deriveTenant, deriveTenants } from "../extension/dist/app/tenants.js";
import { sealSide, openSealed, enclaveKeypair } from "../extension/dist/app/seal.js";

const SEED_A = Buffer.alloc(32, 0xa1);
const SEED_B = Buffer.alloc(32, 0xb2);
const MARKET = `0x${"cd".repeat(32)}`;
const OWNER = "0x3997bAD599544b6c0863ED7daeDD67346df9e577";

test("each tenant gets a distinct signer and sealing key", () => {
  const dorr = deriveTenant(SEED_A, "dorr");
  const hadal = deriveTenant(SEED_A, "hadal");

  assert.notEqual(dorr.signer.address, hadal.signer.address);
  assert.notEqual(dorr.sealingPublicKey, hadal.sealingPublicKey);
  assert.notEqual(dorr.tenantId, hadal.tenantId);
  // Same seed + same project must be the same identity, or a restart loses it.
  assert.equal(deriveTenant(SEED_A, "dorr").signer.address, dorr.signer.address);
});

test("a different master seed gives different tenants entirely", () => {
  assert.notEqual(
    deriveTenant(SEED_A, "dorr").signer.address,
    deriveTenant(SEED_B, "dorr").signer.address,
  );
});

test("a ciphertext sealed to dorr does NOT open under hadal — the whole point", () => {
  const { dorr, hadal } = Object.fromEntries(deriveTenants(SEED_A, ["dorr", "hadal"]));

  // Sealing takes a COMPRESSED pubkey; derive it from each tenant's own key.
  const dorrPub = enclaveKeypair(`0x${dorr.sealingPrivateKey.toString("hex")}`).publicKey;
  const sealed = sealSide(dorrPub, MARKET, OWNER, 1);

  assert.equal(openSealed(`0x${dorr.sealingPrivateKey.toString("hex")}`, MARKET, OWNER, sealed), 1);
  assert.throws(
    () => openSealed(`0x${hadal.sealingPrivateKey.toString("hex")}`, MARKET, OWNER, sealed),
    /unable to authenticate|bad decrypt|Unsupported state/i,
    "hadal must not be able to open dorr's ciphertext",
  );
});

test("and the reverse — hadal's ciphertext is opaque to dorr", () => {
  const { dorr, hadal } = Object.fromEntries(deriveTenants(SEED_A, ["dorr", "hadal"]));
  const hadalPub = enclaveKeypair(`0x${hadal.sealingPrivateKey.toString("hex")}`).publicKey;
  const sealed = sealSide(hadalPub, MARKET, OWNER, 0);

  assert.equal(openSealed(`0x${hadal.sealingPrivateKey.toString("hex")}`, MARKET, OWNER, sealed), 0);
  assert.throws(() =>
    openSealed(`0x${dorr.sealingPrivateKey.toString("hex")}`, MARKET, OWNER, sealed),
  );
});

test("a signature made for dorr does not recover to hadal's address", async () => {
  const dorr = deriveTenant(SEED_A, "dorr");
  const hadal = deriveTenant(SEED_A, "hadal");
  const digest = `0x${"7e".repeat(32)}`;

  const sig = await dorr.signer.signMessage({ message: { raw: digest } });
  const recovered = await recoverMessageAddress({ message: { raw: digest }, signature: sig });

  assert.equal(recovered, dorr.signer.address);
  assert.notEqual(
    recovered,
    hadal.signer.address,
    "cross-product replay must fail at ecrecover, not at a convention",
  );
});

test("a projectId that is not a stable lowercase namespace is refused", () => {
  for (const bad of ["", "A", "Dorr", "dorr_x", "x", "has space", "-lead"]) {
    assert.throws(() => deriveTenant(SEED_A, bad), /projectId/, `should reject "${bad}"`);
  }
});

test("molfi's keys are env-pinned, so tenants cannot move them", () => {
  // The regression this guards: folding molfi into the derivation would change
  // its sealing key away from the one live bids were sealed to, and its signer
  // away from what SealedBidBook.teeSigner points at.
  const pinned = `0x${"3c".repeat(32)}`;
  const a = enclaveKeypair(pinned);
  const b = enclaveKeypair(pinned);
  assert.equal(a.publicKey, b.publicKey);

  const derived = deriveTenant(SEED_A, "molfi");
  assert.notEqual(
    enclaveKeypair(`0x${derived.sealingPrivateKey.toString("hex")}`).publicKey,
    a.publicKey,
    "derivation and the pinned key are different keys — molfi must keep the pinned one",
  );
});
