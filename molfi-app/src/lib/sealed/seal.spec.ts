import { describe, it, expect } from "vitest";
import { sealSide, CIPHERTEXT_BYTES } from "./seal";
// The REAL enclave opener — not a reimplementation. If the browser sealer and
// the enclave ever drift, a sealed bid becomes permanently unreadable and the
// bettor's FXRP is stuck until the market opens with their side guessed wrong.
// @ts-expect-error — plain-JS enclave module, no types
import { openSealed, enclaveKeypair } from "../../../../molfi-fcc/src/seal.mjs";
// The COMPILED opener from the TEE image — the artifact that actually runs
// inside the registered Confidential Compute container, not its source. Three
// implementations now have to agree: this browser sealer (WebCrypto, @noble v2),
// the standalone enclave (node:crypto, @noble v1) and the image. They differ in
// runtime, crypto library and major version, which is exactly why agreement has
// to be tested rather than assumed.
// `dist/` is a build artifact, so `npm test` builds it first via pretest. Running
// vitest directly on a clean tree fails here with MODULE_NOT_FOUND — loudly,
// which is the right outcome: skipping this silently is the exact failure this
// file exists to prevent.
// @ts-expect-error — compiled JS, no types alongside
import { openSealed as openInImage } from "../../../../molfi-fcc/extension/dist/app/seal.js";

const MKT = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

describe("browser sealer ↔ enclave opener", () => {
  it("the enclave can read what the browser sealed, both sides", async () => {
    const e = enclaveKeypair();
    for (const side of [0, 1] as const) {
      const ct = await sealSide(e.publicKey, MKT, ALICE, side);
      expect(openSealed(e.privateKey, MKT, ALICE, ct)).toBe(side);
    }
  });

  it("produces the enclave's exact byte layout", async () => {
    const e = enclaveKeypair();
    const ct = await sealSide(e.publicKey, MKT, ALICE, 1);
    expect((ct.length - 2) / 2).toBe(CIPHERTEXT_BYTES);
  });

  it("every seal is a different ciphertext, so the side never leaks by comparison", async () => {
    const e = enclaveKeypair();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(await sealSide(e.publicKey, MKT, ALICE, 0));
    expect(seen.size).toBe(20);
  });

  it("cannot be replayed into another market or by another bidder", async () => {
    const e = enclaveKeypair();
    const ct = await sealSide(e.publicKey, MKT, ALICE, 0);
    expect(() => openSealed(e.privateKey, OTHER, ALICE, ct)).toThrow();
    expect(() => openSealed(e.privateKey, MKT, BOB, ct)).toThrow();
  });

  it("a different enclave key cannot read it", async () => {
    const e = enclaveKeypair();
    const other = enclaveKeypair();
    const ct = await sealSide(e.publicKey, MKT, ALICE, 1);
    expect(() => openSealed(other.privateKey, MKT, ALICE, ct)).toThrow();
  });

  it("refuses an out-of-range side", async () => {
    const e = enclaveKeypair();
    // @ts-expect-error — deliberately wrong
    await expect(sealSide(e.publicKey, MKT, ALICE, 2)).rejects.toThrow(/side must be 0 or 1/);
  });
});

describe("browser sealer ↔ the compiled TEE image", () => {
  it("the image reads what the browser sealed, both sides", async () => {
    const e = enclaveKeypair();
    for (const side of [0, 1] as const) {
      const ct = await sealSide(e.publicKey, MKT, ALICE, side);
      expect(openInImage(e.privateKey, MKT, ALICE, ct)).toBe(side);
    }
  });

  it("the image enforces the same (market, bidder) binding", async () => {
    const e = enclaveKeypair();
    const ct = await sealSide(e.publicKey, MKT, ALICE, 0);
    expect(() => openInImage(e.privateKey, OTHER, ALICE, ct)).toThrow();
    expect(() => openInImage(e.privateKey, MKT, BOB, ct)).toThrow();
  });

  it("the image and the standalone enclave read a bid identically", async () => {
    // The one failure this catches is the expensive one: an HKDF or AAD
    // difference derives a different key, and every bid sealed in between is
    // unopenable by whichever side did not change.
    const e = enclaveKeypair();
    for (const side of [0, 1] as const) {
      const ct = await sealSide(e.publicKey, MKT, ALICE, side);
      expect(openInImage(e.privateKey, MKT, ALICE, ct)).toBe(
        openSealed(e.privateKey, MKT, ALICE, ct),
      );
    }
  });
});
