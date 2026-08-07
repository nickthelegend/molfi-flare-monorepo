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
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** HKDF `info` as BYTES — see the note in molfi-app/src/lib/sealed/seal.ts.
 *  @noble/hashes v2 rejects a string, v1 UTF-8 encoded it; being explicit keeps
 *  both sides deriving the same key across versions. */
const HKDF_INFO = new TextEncoder().encode("molfi-sealed-bid-v1");

const EPH_LEN = 33;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER = EPH_LEN + NONCE_LEN + TAG_LEN;

const hexToBytes = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");
const bytesToHex = (b) => `0x${Buffer.from(b).toString("hex")}`;

/** Bind the ciphertext to exactly one (market, bidder). */
function aad(marketId, bidder) {
  return Buffer.concat([
    hexToBytes(marketId),
    hexToBytes(String(bidder).toLowerCase()),
  ]);
}

function deriveKey(shared, ephPub) {
  // The ephemeral public key is in the salt so two bids that somehow shared a
  // secret still derive different keys.
  return Buffer.from(hkdf(sha256, shared, ephPub, HKDF_INFO, 32));
}

/**
 * Seal a side (0 = YES, 1 = NO) for one market and bidder.
 * @returns {`0x${string}`} the ciphertext to pass to `SealedBidBook.sealBid`
 */
export function sealSide(enclavePubKeyHex, marketId, bidder, side) {
  if (side !== 0 && side !== 1) throw new Error(`side must be 0 or 1, got ${side}`);
  const enclavePub = hexToBytes(enclavePubKeyHex);

  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, enclavePub, true);
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
 * @returns {0|1} the side
 */
export function openSealed(enclavePrivKeyHex, marketId, bidder, ciphertextHex) {
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
  return pt[0];
}

/** The enclave's keypair. In production the private half never leaves the TEE. */
export function enclaveKeypair(privHex) {
  const priv = privHex ? hexToBytes(privHex) : secp256k1.utils.randomPrivateKey();
  return {
    privateKey: bytesToHex(priv),
    publicKey: bytesToHex(secp256k1.getPublicKey(priv, true)),
  };
}

export const CIPHERTEXT_BYTES = HEADER + 1;
