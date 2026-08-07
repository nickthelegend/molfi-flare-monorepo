/**
 * Sealing a bid to the enclave.
 *
 * ECIES over secp256k1: an ephemeral keypair per bid, ECDH against the
 * enclave's attested public key, HKDF-SHA256 to an AES-256-GCM key. The
 * ciphertext goes on-chain in the clear — it is only readable inside the
 * enclave, which is the entire point.
 *
 * Wire format (all binary, concatenated):
 *   [0..33)   ephemeral compressed public key (33 bytes)
 *   [33..45)  GCM nonce (12 bytes)
 *   [45..61)  GCM auth tag (16 bytes)
 *   [61..]    ciphertext
 *
 * The market id and bidder address are bound in as ADDITIONAL AUTHENTICATED
 * DATA, not encrypted. That means a sealed bid cannot be lifted from one market
 * and replayed into another, or resubmitted by a different address to
 * impersonate a side — GCM authentication fails and the enclave rejects it
 * rather than silently counting it somewhere it does not belong.
 *
 * THREE IMPLEMENTATIONS MUST AGREE BYTE FOR BYTE: this one (inside the TEE
 * image), molfi-fcc/src/seal.mjs (the standalone enclave), and
 * molfi-app/src/lib/sealed/seal.ts (the browser, on WebCrypto). A divergence
 * here does not fail loudly — it derives a different key, and every bid sealed
 * in the meantime becomes permanently unopenable. test/cross-impl.test.mjs
 * pins all three together.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * HKDF `info`, as BYTES.
 *
 * @noble/hashes v1 accepted a string here and UTF-8 encoded it; v2 rejects
 * anything but a Uint8Array. Passing bytes explicitly means every
 * implementation derives the same key regardless of which minor version it
 * happens to resolve.
 */
const HKDF_INFO = new TextEncoder().encode("molfi-sealed-bid-v1");

const EPH_LEN = 33;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER = EPH_LEN + NONCE_LEN + TAG_LEN;

export const CIPHERTEXT_BYTES = HEADER + 1;

export const OUTCOME_YES = 0;
export const OUTCOME_NO = 1;
export type Side = 0 | 1;

const hexToBytes = (h: string): Buffer =>
  Buffer.from(String(h).replace(/^0x/, ""), "hex");
const bytesToHex = (b: Uint8Array): `0x${string}` =>
  `0x${Buffer.from(b).toString("hex")}`;

/** Bind the ciphertext to exactly one (market, bidder). */
function aad(marketId: string, bidder: string): Buffer {
  return Buffer.concat([
    hexToBytes(marketId),
    hexToBytes(String(bidder).toLowerCase()),
  ]);
}

function deriveKey(shared: Uint8Array, ephPub: Uint8Array): Buffer {
  // The ephemeral public key is in the salt so two bids that somehow shared a
  // secret still derive different keys.
  return Buffer.from(hkdf(sha256, shared, ephPub, HKDF_INFO, 32));
}

/**
 * Generate a secret key across @noble/curves v1 and v2.
 *
 * v2 renamed `randomPrivateKey` to `randomSecretKey`. Reaching for the old name
 * on v2 yields `undefined()` — a runtime TypeError, not a compile error — so
 * both names are accepted rather than assumed.
 */
function randomSecretKey(): Uint8Array {
  const utils = secp256k1.utils as unknown as {
    randomSecretKey?: () => Uint8Array;
    randomPrivateKey?: () => Uint8Array;
  };
  const gen = utils.randomSecretKey ?? utils.randomPrivateKey;
  if (!gen) throw new Error("@noble/curves: no secret-key generator found");
  return gen.call(utils);
}

/**
 * Seal a side (0 = YES, 1 = NO) for one market and bidder.
 * @returns the ciphertext to pass to `SealedBidBook.sealBid`
 */
export function sealSide(
  enclavePubKeyHex: string,
  marketId: string,
  bidder: string,
  side: Side,
): `0x${string}` {
  if (side !== 0 && side !== 1) throw new Error(`side must be 0 or 1, got ${side}`);

  const ephPriv = randomSecretKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, hexToBytes(enclavePubKeyHex), true);
  const key = deriveKey(shared, ephPub);

  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(marketId, bidder));
  // One byte of plaintext. Padding it would only invite the assumption that
  // ciphertext length carries information — it does not, every bid is identical
  // in size by construction.
  const ct = Buffer.concat([cipher.update(Buffer.from([side])), cipher.final()]);
  const tag = cipher.getAuthTag();

  return bytesToHex(Buffer.concat([ephPub, nonce, tag, ct]));
}

/**
 * Open a sealed bid. Runs ONLY inside the enclave — this is the one place the
 * plaintext side exists.
 */
export function openSealed(
  enclavePrivKeyHex: string,
  marketId: string,
  bidder: string,
  ciphertextHex: string,
): Side {
  const buf = hexToBytes(ciphertextHex);
  if (buf.length <= HEADER) throw new Error("ciphertext too short");

  const ephPub = buf.subarray(0, EPH_LEN);
  const nonce = buf.subarray(EPH_LEN, EPH_LEN + NONCE_LEN);
  const tag = buf.subarray(EPH_LEN + NONCE_LEN, HEADER);
  const ct = buf.subarray(HEADER);

  const shared = secp256k1.getSharedSecret(hexToBytes(enclavePrivKeyHex), ephPub, true);
  const key = deriveKey(shared, ephPub);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad(marketId, bidder));
  decipher.setAuthTag(tag);
  // Throws on a tampered ciphertext, a wrong market, or a wrong bidder — all of
  // which MUST be rejected rather than guessed at.
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);

  if (pt.length !== 1 || (pt[0] !== 0 && pt[0] !== 1)) {
    throw new Error(`decrypted to an invalid side: ${pt.toString("hex")}`);
  }
  return pt[0] as Side;
}

export interface EnclaveKeypair {
  privateKey: `0x${string}`;
  publicKey: `0x${string}`;
}

/** The enclave's keypair. In production the private half never leaves the TEE. */
export function enclaveKeypair(privHex?: string | null): EnclaveKeypair {
  const priv = privHex ? hexToBytes(privHex) : Buffer.from(randomSecretKey());
  return {
    privateKey: bytesToHex(priv),
    publicKey: bytesToHex(secp256k1.getPublicKey(priv, true)),
  };
}
