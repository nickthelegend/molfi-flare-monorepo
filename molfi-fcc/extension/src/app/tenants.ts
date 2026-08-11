/**
 * Tenant identities inside one attested enclave.
 *
 * Molfi's machine reached PRODUCTION on Coston2 — Flare's own data providers
 * requested `tee-attestation`, matched policy against a reward epoch, and voted
 * it available. That artifact is expensive and it is per-machine, so the useful
 * move for sibling products (dorr, hadal) is to run inside THIS machine rather
 * than stand up their own box, which would have no such artifact at all.
 *
 * The naive way to share is worse than not sharing: one signing key and one
 * sealing key for everybody means a quote issued for dorr verifies just as well
 * against hadal's contract, and a ciphertext sealed "to the enclave" is
 * readable by whichever tenant asks first. So every tenant gets its own keys,
 * derived from one master seed:
 *
 *     signingKey(p) = HKDF-SHA256(seed, salt = "flare-tee-kit/v1/sign",  info = p)
 *     sealingKey(p) = HKDF-SHA256(seed, salt = "flare-tee-kit/v1/ecies", info = p)
 *
 * Salts and infos match `flare-tee-kit` (dorr's packages/tee-kit) byte for byte,
 * so a tenant derived there and one derived here are the same identity. This is
 * VENDORED rather than depended on deliberately: the file is ~100 lines with no
 * imports the extension did not already have, and the registered image is the
 * one place where a smaller audited surface beats dependency hygiene. Adding a
 * package to the enclave means auditing that package's tree inside the trust
 * boundary; copying 100 readable lines does not.
 *
 * WHAT THIS IS NOT. Tenants are separated by IDENTITY, not by blast radius.
 * Code running in this process can derive any tenant's key, so a compromise of
 * the enclave compromises all of them. Two products that must be safe from each
 * other's *bugs* need two enclaves. What this buys is that cross-product replay
 * is impossible by construction — no domain-separation discipline to remember,
 * no shared payload format to keep collision-free.
 */
import { hkdfSync } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

const SIGN_SALT = "flare-tee-kit/v1/sign";
const SEAL_SALT = "flare-tee-kit/v1/ecies";
const ID_SALT = "flare-tee-kit/v1/id";

/** A project namespace. Lowercase, stable, never reused for a different app. */
export type ProjectId = string;

export interface Tenant {
  projectId: ProjectId;
  /** Registered on-chain; what a verifier recovers a quote to. */
  signer: PrivateKeyAccount;
  /** secp256k1 private key clients seal to (via `sealingPublicKey`). */
  sealingPrivateKey: Buffer;
  /** Uncompressed 65-byte public key, `0x04…` — hand this to clients. */
  sealingPublicKey: Hex;
  /** Stable id derived from the name; useful as a `teeId`. */
  tenantId: Hex;
}

const derive = (seed: Buffer, salt: string, info: string, bytes = 32): Buffer =>
  Buffer.from(hkdfSync("sha256", seed, Buffer.from(salt), Buffer.from(info), bytes));

/**
 * A secp256k1 scalar must be in [1, n). HKDF output is uniform over 2^256, so a
 * value outside the curve order is astronomically unlikely but not impossible —
 * rejection-sample rather than reduce, because reducing biases the key.
 */
const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
function deriveScalar(seed: Buffer, salt: string, info: string): Buffer {
  for (let i = 0; i < 256; i++) {
    const candidate = derive(seed, salt, i === 0 ? info : `${info}/${i}`);
    const v = BigInt("0x" + candidate.toString("hex"));
    if (v > 0n && v < N) return candidate;
  }
  throw new Error("HKDF failed to produce a valid secp256k1 scalar");
}

/** Derive a tenant's identity from the enclave's master seed. */
export function deriveTenant(masterSeed: Buffer, projectId: ProjectId): Tenant {
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(projectId)) {
    throw new Error(`projectId must be lowercase alphanumeric with dashes, got "${projectId}"`);
  }
  const signKey = deriveScalar(masterSeed, SIGN_SALT, projectId);
  const sealKey = deriveScalar(masterSeed, SEAL_SALT, projectId);

  return {
    projectId,
    signer: privateKeyToAccount(`0x${signKey.toString("hex")}` as Hex),
    sealingPrivateKey: sealKey,
    sealingPublicKey: `0x${Buffer.from(secp256k1.getPublicKey(sealKey, false)).toString("hex")}` as Hex,
    tenantId: `0x${derive(masterSeed, ID_SALT, projectId).toString("hex")}` as Hex,
  };
}

/** Derive every configured tenant once at boot. */
export function deriveTenants(masterSeed: Buffer, projectIds: ProjectId[]): Map<ProjectId, Tenant> {
  const out = new Map<ProjectId, Tenant>();
  for (const id of projectIds) out.set(id, deriveTenant(masterSeed, id));
  return out;
}
