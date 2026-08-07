/**
 * ★ Configuration for the Molfi extension.
 *
 * Replaces the scaffold's GREETING identifiers. The op-type and op-command
 * strings MUST match the bytes32 constants in InstructionSender.sol exactly, or
 * actions fall through to "unsupported op type".
 */

/** Bumped from the scaffold's 0.1.0 so a running node's version is unambiguous. */
export const VERSION = "0.2.0-molfi";

export const OP_TYPE_MOLFI = "MOLFI";
export const OP_COMMAND_SEAL_KEY = "SEAL_KEY";
export const OP_COMMAND_OPEN_BOOK = "OPEN_BOOK";

export interface MolfiConfig {
  chainId: number;
  chainUrl: string;
  /** SealedBidBook address. Reads fail loudly rather than guessing if unset. */
  book: string | null;
  /**
   * The ECIES key bids are sealed to.
   *
   * Supplied from outside ONLY under SIMULATED_TEE. A real Confidential Space
   * deployment cannot accept it that way — the operator would then hold the key
   * that the whole design says nobody holds — so it is generated in-enclave when
   * absent. The cost of generating is that a restart strands every bid already
   * sealed to the old key; a production deployment needs sealed storage or
   * attestation-derived key material, and this is the honest boundary of the
   * simulated posture.
   */
  enclavePrivateKey: string | null;
  /** Signs openings. Distinct from the sealing key so it can rotate freely. */
  teeSignerKey: string | null;
  simulatedTee: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MolfiConfig {
  return {
    chainId: Number(env.CHAIN_ID ?? 114),
    chainUrl: env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc",
    book: env.SEALED_BID_BOOK ?? null,
    enclavePrivateKey: env.ENCLAVE_PRIVATE_KEY ?? null,
    teeSignerKey: env.TEE_SIGNER_KEY ?? null,
    simulatedTee: env.SIMULATED_TEE === "true",
  };
}
