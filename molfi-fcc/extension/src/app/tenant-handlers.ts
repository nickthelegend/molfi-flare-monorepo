/**
 * Sibling products hosted inside molfi's attested machine.
 *
 * dorr (sealed perp orders) and hadal (confidential FXRP amounts) are separate
 * Flare Summer Signal entries that each want confidential compute. Standing up
 * a box per product gets them a server; running here gets them a machine whose
 * availability Flare's own data providers attested and voted on. So they are
 * tenants, not deployments.
 *
 * Three ops per tenant, and no product logic — deliberately. Anything specific
 * to how dorr prices a perp belongs in dorr's repo, not inside the enclave that
 * settles molfi's markets. What lives here is the identity boundary:
 *
 *   SEAL_KEY  → the tenant's own ECIES public key, so clients seal TO A TENANT
 *   OPEN      → decrypt a ciphertext sealed to this tenant (and only this one)
 *   SIGN      → EIP-191 signature under the tenant's own signer address
 *
 * The property that makes this worth doing is negative and is tested rather
 * than asserted: a ciphertext sealed to dorr does not open under hadal's key,
 * and a signature produced for dorr does not recover to the address hadal
 * registered on-chain. Both follow from the derivation in `tenants.ts` — the
 * keys are different keys — but "follows from" is not "verified", so
 * `verify-image.mjs` proves it from inside the running container.
 *
 * MOLFI IS NOT A TENANT HERE. Its sealing and signing keys stay exactly where
 * they were, pinned by ENCLAVE_PRIVATE_KEY / TEE_SIGNER_KEY. Folding it into
 * the derivation would change its sealing key from 0x02a26c71… and strand every
 * bid already sealed to it, and change its signer from 0x6a066930… which
 * `SealedBidBook.teeSigner` still points at. Existing behaviour is bit-identical
 * by construction: nothing in this file is reachable from a MOLFI action.
 */
import type { Framework, HandlerResult } from "../base/types.js";
import { openSealed, type Side } from "./seal.js";
import { deriveTenant, type Tenant } from "./tenants.js";
import { hexToBytes } from "../base/encoding.js";

export const OP_TYPE_DORR = "DORR";
export const OP_TYPE_HADAL = "HADAL";

export const OP_COMMAND_TENANT_SEAL_KEY = "SEAL_KEY";
export const OP_COMMAND_TENANT_OPEN = "OPEN";
export const OP_COMMAND_TENANT_SIGN = "SIGN";

/** opType → the lowercase project id its keys are derived under. */
export const TENANTS: ReadonlyArray<{ opType: string; projectId: string }> = [
  { opType: OP_TYPE_DORR, projectId: "dorr" },
  { opType: OP_TYPE_HADAL, projectId: "hadal" },
];

const ok = (data: string): HandlerResult => [data, 1, null];
const fail = (msg: string): HandlerResult => [null, 0, msg];

/** Payloads arrive hex-encoded; every op here takes JSON. */
function decodeJson(msg: string): unknown {
  return JSON.parse(Buffer.from(hexToBytes(msg)).toString("utf8"));
}

function utf8ToHex(s: string): `0x${string}` {
  return `0x${Buffer.from(s, "utf8").toString("hex")}`;
}

/**
 * Build the three handlers for one tenant.
 *
 * The tenant is derived once and captured, for the same reason molfi's keypair
 * is built at module load: a key that changed between two calls would strand
 * whatever was sealed to the previous one.
 */
export function tenantHandlers(tenant: Tenant) {
  /** Publish the sealing public key. Reveals nothing; clients need it to seal. */
  const handleSealKey = (): HandlerResult =>
    ok(
      utf8ToHex(
        JSON.stringify({
          projectId: tenant.projectId,
          tenantId: tenant.tenantId,
          sealingPublicKey: tenant.sealingPublicKey,
          signer: tenant.signer.address,
        }),
      ),
    );

  /**
   * Open a ciphertext sealed to THIS tenant.
   *
   * `openSealed` binds (marketId, bidder) as AAD and authenticates with
   * AES-GCM, so a ciphertext sealed to a different tenant fails the tag check
   * rather than decrypting to a plausible-looking wrong answer. That is the
   * isolation, and it is why this returns an error instead of a guess.
   */
  const handleOpen = (msg: string): HandlerResult => {
    let body: { contextId?: string; owner?: string; ciphertext?: string };
    try {
      body = decodeJson(msg) as typeof body;
    } catch (e) {
      return fail(`decoding request: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { contextId, owner, ciphertext } = body;
    if (!contextId || !owner || !ciphertext) {
      return fail("expected { contextId, owner, ciphertext }");
    }
    try {
      const side: Side = openSealed(
        `0x${tenant.sealingPrivateKey.toString("hex")}`,
        contextId,
        owner,
        ciphertext,
      );
      return ok(utf8ToHex(JSON.stringify({ projectId: tenant.projectId, value: side })));
    } catch (e) {
      // A wrong tenant, a wrong context, a wrong owner and a tampered
      // ciphertext are indistinguishable here, and all four must be refused.
      return fail(
        `cannot open under tenant "${tenant.projectId}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  };

  /**
   * Sign a digest under this tenant's signer.
   *
   * Each product registers its own tenant address on-chain, so a quote signed
   * here recovers to dorr's address and not to hadal's — cross-product replay
   * fails at `ecrecover`, with no domain-separation convention to remember.
   */
  const handleSign = async (msg: string): Promise<HandlerResult> => {
    let body: { digest?: string };
    try {
      body = decodeJson(msg) as typeof body;
    } catch (e) {
      return fail(`decoding request: ${e instanceof Error ? e.message : String(e)}`);
    }
    const digest = body.digest;
    if (!digest || !/^0x[0-9a-fA-F]{64}$/.test(digest)) {
      return fail("expected { digest } as a 32-byte hex string");
    }
    const signature = await tenant.signer.signMessage({
      message: { raw: digest as `0x${string}` },
    });
    return ok(
      utf8ToHex(
        JSON.stringify({
          projectId: tenant.projectId,
          signer: tenant.signer.address,
          digest,
          signature,
        }),
      ),
    );
  };

  return { handleSealKey, handleOpen, handleSign };
}

/**
 * Register DORR and HADAL. Returns what was registered, for `/state`.
 *
 * `masterSeed` is the whole security boundary for these tenants — losing it
 * loses both identities, and anyone holding it can reconstruct them. It is
 * generated in-enclave when unset, with the same restart caveat molfi's own key
 * carries.
 */
export function registerTenants(
  framework: Framework,
  masterSeed: Buffer,
): Array<{ opType: string; projectId: string; signer: string; sealingPublicKey: string }> {
  const registered = [];
  for (const { opType, projectId } of TENANTS) {
    const tenant = deriveTenant(masterSeed, projectId);
    const h = tenantHandlers(tenant);
    framework.handle(opType, OP_COMMAND_TENANT_SEAL_KEY, h.handleSealKey);
    framework.handle(opType, OP_COMMAND_TENANT_OPEN, h.handleOpen);
    framework.handle(opType, OP_COMMAND_TENANT_SIGN, h.handleSign);
    registered.push({
      opType,
      projectId,
      signer: tenant.signer.address,
      sealingPublicKey: tenant.sealingPublicKey,
    });
  }
  return registered;
}
