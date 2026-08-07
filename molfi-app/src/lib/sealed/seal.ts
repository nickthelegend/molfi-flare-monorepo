/**
 * Sealing a bid, browser side.
 *
 * Wire-compatible with `molfi-fcc/src/seal.mjs` — same ECIES construction, same
 * byte layout, same HKDF info string — but built on WebCrypto instead of
 * `node:crypto`, which does not exist here.
 *
 *   [0..33)   ephemeral compressed public key
 *   [33..45)  GCM nonce
 *   [45..61)  GCM auth tag
 *   [61..]    ciphertext
 *
 * WebCrypto appends the tag to the ciphertext rather than exposing it
 * separately, so it is split back out on seal to keep the layout identical to
 * the enclave's. If these two ever diverge the enclave simply cannot read the
 * bid — so `sealRoundTrip` in the test suite pins them together.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * HKDF `info`, as BYTES.
 *
 * @noble/hashes v1 accepted a string here and UTF-8 encoded it; v2 rejects
 * anything but a Uint8Array. Passing the bytes explicitly on BOTH sides means
 * the app and the enclave derive the same key even on different minor
 * versions — a mismatch here would make every sealed bid unreadable.
 */
const HKDF_INFO = new TextEncoder().encode("molfi-sealed-bid-v1");

const EPH_LEN = 33;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export const OUTCOME_YES = 0;
export const OUTCOME_NO = 1;

const hexToBytes = (h: string): Uint8Array => {
  const s = h.replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToHex = (b: Uint8Array): `0x${string}` =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Bind the ciphertext to exactly one (market, bidder) — mirrors the enclave. */
const aad = (marketId: string, bidder: string) =>
  concat(hexToBytes(marketId), hexToBytes(bidder.toLowerCase()));

/**
 * Encrypt `side` to the enclave's public key.
 *
 * The result is what goes to `SealedBidBook.sealBid`. Nothing here — not the
 * page, not the RPC, not the chain — can recover the side afterwards; only the
 * enclave holding the matching private key can.
 */
export async function sealSide(
  enclavePublicKey: string,
  marketId: string,
  bidder: string,
  side: 0 | 1,
): Promise<`0x${string}`> {
  if (side !== 0 && side !== 1) throw new Error(`side must be 0 or 1, got ${side}`);

  // @noble/curves v2 renamed randomPrivateKey -> randomSecretKey. Accept
  // either, so the app and the enclave can be on different minor versions
  // without this silently becoming undefined().
  const utils = secp256k1.utils as unknown as {
    randomSecretKey?: () => Uint8Array;
    randomPrivateKey?: () => Uint8Array;
  };
  const gen = utils.randomSecretKey ?? utils.randomPrivateKey;
  if (!gen) throw new Error("@noble/curves: no secret-key generator found");
  const ephPriv = gen();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, hexToBytes(enclavePublicKey), true);
  const keyBytes = hkdf(sha256, shared, ephPub, HKDF_INFO, 32);

  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(marketId, bidder) as BufferSource },
      key,
      new Uint8Array([side]),
    ),
  );

  // WebCrypto returns ciphertext||tag; the enclave's layout is tag before
  // ciphertext, so split and reorder.
  const ct = sealed.subarray(0, sealed.length - TAG_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);

  return bytesToHex(concat(ephPub, nonce, tag, ct));
}

/** Length every sealed bid has — no bid leaks its side by size. */
export const CIPHERTEXT_BYTES = EPH_LEN + NONCE_LEN + TAG_LEN + 1;
