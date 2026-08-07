/**
 * ★ MAIN CUSTOMIZATION POINT: Molfi's handlers.
 *
 * Two operations, both under opType MOLFI:
 *
 *   SEAL_KEY   → publish the enclave's ECIES public key so clients can seal to it
 *   OPEN_BOOK  → decrypt a closed market's bids, total the pools, sign the result
 *
 * Handler contract:
 *   (originalMessageHex) => [dataHexOrNull, status, errorOrNull]
 *   status 0 = error, 1 = success. See docs/extension-contract.md §4.6.
 *
 * The framework serializes handler calls, so plain module-level state is safe.
 *
 * WHAT THE SIGNATURE IS AND IS NOT. `OPEN_BOOK` returns an EIP-191 signature over
 * the aggregate. It is NOT a request to believe the enclave: `SealedBidBook`
 * independently knows how many bids it holds and exactly how much FXRP it
 * escrowed, and rejects any opening whose pools do not sum to that escrow or
 * whose count disagrees. A compromised enclave cannot move a bettor's stake to
 * the other side without the totals failing to reconcile. The confidentiality is
 * a TEE assumption; the integrity is not.
 */

import { bytesToHex } from "../base/encoding.js";
import type { Framework, HandlerResult } from "../base/types.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { decodeMarketId } from "./abi.js";
import { BookReader } from "./chain.js";
import {
  loadConfig,
  OP_COMMAND_OPEN_BOOK,
  OP_COMMAND_SEAL_KEY,
  OP_TYPE_MOLFI,
  type MolfiConfig,
} from "./config.js";
import { openBook, openDigest } from "./open-book.js";
import { enclaveKeypair, type EnclaveKeypair } from "./seal.js";

// --- Enclave identity --------------------------------------------------------
// Built once at module load. A key that rotated mid-market would strand every
// bid already sealed to the previous one, so this is deliberately not lazy and
// deliberately not per-request.

let cfg: MolfiConfig = loadConfig();
let enclave: EnclaveKeypair = enclaveKeypair(cfg.enclavePrivateKey);
let signer = privateKeyToAccount(
  (cfg.teeSignerKey ?? `0x${"11".repeat(32)}`) as Hex,
);
let reader: BookReader | null = null;

/** Lazy so a missing SEALED_BID_BOOK breaks OPEN_BOOK only, never startup. */
function bookReader(): BookReader {
  if (!reader) reader = new BookReader(cfg);
  return reader;
}

// --- Extension state ---------------------------------------------------------
let openedCount = 0;
let lastMarketOpened: string | null = null;
let lastBidCount = 0;

/** Reset all state. Used by tests; not part of the wire contract. */
export function resetState(env?: NodeJS.ProcessEnv): void {
  openedCount = 0;
  lastMarketOpened = null;
  lastBidCount = 0;
  if (env) {
    cfg = loadConfig(env);
    enclave = enclaveKeypair(cfg.enclavePrivateKey);
    signer = privateKeyToAccount((cfg.teeSignerKey ?? `0x${"11".repeat(32)}`) as Hex);
    reader = null;
  }
}

/**
 * Wire handlers to (opType, opCommand) pairs.
 *
 * Called once at startup, which makes it the right place for the identity
 * banner: the sealing key and signer address are what an operator needs in order
 * to point `SealedBidBook.setTeeSigner` at this enclave, and when the keys are
 * generated in-enclave this log is the only place they are ever announced.
 */
let bannerShown = false;

export function register(framework: Framework): void {
  framework.handle(OP_TYPE_MOLFI, OP_COMMAND_SEAL_KEY, handleSealKey);
  framework.handle(OP_TYPE_MOLFI, OP_COMMAND_OPEN_BOOK, handleOpenBook);

  // Once per process. The container registers once; test suites construct a
  // Server per case, and repeating the key on every one buries the output.
  if (bannerShown) return;
  bannerShown = true;

  console.log(`[molfi] enclave sealing key ${enclave.publicKey}`);
  console.log(`[molfi] tee signer          ${signer.address}`);
  console.log(`[molfi] sealed bid book     ${cfg.book ?? "(unset — OPEN_BOOK will fail)"}`);
  if (!cfg.enclavePrivateKey) {
    console.log(
      "[molfi] ENCLAVE_PRIVATE_KEY unset — generated in-enclave. " +
        "Bids sealed to this key become unopenable if the container restarts.",
    );
  }
  if (cfg.simulatedTee) {
    console.log(
      "[molfi] SIMULATED_TEE=true — confidentiality is a development posture, " +
        "not a hardware guarantee. Integrity is enforced on-chain regardless.",
    );
  }
}

/**
 * Snapshot returned by GET /state.
 *
 * The sealing public key and the signer address belong here — a client that
 * cannot see them cannot seal a bid, and neither reveals anything. What is NOT
 * here is any market's split, ever: the whole product is that nobody, including
 * whoever is reading this endpoint, can see which way the book is leaning before
 * it closes.
 */
export function reportState(): unknown {
  return {
    extension: "molfi-sealed-book",
    opType: OP_TYPE_MOLFI,
    commands: [OP_COMMAND_SEAL_KEY, OP_COMMAND_OPEN_BOOK],
    enclavePublicKey: enclave.publicKey,
    teeSigner: signer.address,
    book: cfg.book,
    chainId: cfg.chainId,
    simulatedTee: cfg.simulatedTee,
    openedCount,
    lastMarketOpened,
    lastBidCount,
  };
}

const ok = (payload: unknown): HandlerResult => [
  bytesToHex(Buffer.from(JSON.stringify(payload), "utf-8")),
  1,
  null,
];
const fail = (message: string): HandlerResult => [null, 0, message];

/**
 * MOLFI/SEAL_KEY — no payload.
 *
 * Public by design. Handing out the sealing key is what lets a bettor encrypt a
 * side that only the enclave can read; it reveals nothing about any bid.
 */
export function handleSealKey(_msg: string): HandlerResult {
  return ok({
    publicKey: enclave.publicKey,
    teeSigner: signer.address,
    chainId: cfg.chainId,
    book: cfg.book,
  });
}

/**
 * MOLFI/OPEN_BOOK — payload is a market id (raw bytes32 or `{"marketId":…}`).
 *
 * Everything except the id is read from chain, so a caller cannot substitute a
 * bidder or an amount.
 */
export async function handleOpenBook(msg: string): Promise<HandlerResult> {
  // 1. Decode
  let marketId: Hex;
  try {
    marketId = decodeMarketId(msg);
  } catch (e) {
    return fail(`decoding request: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Validate against chain
  let summary;
  let bids;
  let expectedSigner;
  let closeInfo;
  try {
    const r = bookReader();
    [summary, bids, expectedSigner, closeInfo] = await Promise.all([
      r.summary(marketId), r.bids(marketId), r.teeSigner(), r.closeInfo(marketId),
    ]);
  } catch (e) {
    return fail(`reading book: ${e instanceof Error ? e.message : String(e)}`);
  }

  // THE MARKET MUST BE CLOSED. This is the whole product.
  //
  // Opening returns every bidder's plaintext side. `openMarket` already refuses
  // an early opening with NotClosedYet — but that protects settlement, not
  // secrecy: the response still leaves the enclave. Without this check anyone
  // who can reach the extension reads the live book and front-runs it, which is
  // precisely what a sealed book exists to prevent. The confidentiality is
  // worth nothing if the enclave will simply tell you.
  if (closeInfo.now < closeInfo.closeTs) {
    return fail(
      `market is still open — closes in ${closeInfo.closeTs - closeInfo.now}s. ` +
        "The book cannot be opened before close.",
    );
  }
  if (bids.length === 0) return fail("no sealed bids for this market");
  if (summary.opened) return fail("book is already opened");

  // Refuse to produce a signature the contract will not accept.
  //
  // The enclave's signing key is generated in here. Rebuild the image, or
  // restart without a pinned key, and this address changes while the contract
  // still trusts the old one — sealing keeps working and bids keep landing, so
  // nothing looks wrong until close, when `openMarket` reverts with
  // BadSignature and every stake in the book is stuck behind an opening that
  // cannot be accepted. Catching it here turns a frozen market into one line of
  // output and one `setTeeSigner` call.
  if (expectedSigner.toLowerCase() !== signer.address.toLowerCase()) {
    return fail(
      `tee signer mismatch: the book accepts ${expectedSigner} but this enclave ` +
        `signs as ${signer.address} — run set-tee-signer.ts before opening`,
    );
  }

  // 3. Execute — the confidential part. Plaintext sides exist only in here.
  const result = openBook(enclave.privateKey, marketId, bids);

  // The contract will reject an opening that fails to reconcile. Checking the
  // same invariants here turns that revert into a diagnosis: a mismatch means
  // the chain moved under the read, not that the decryption was wrong.
  const reported = result.yesPool + result.noPool;
  if (reported !== summary.totalEscrowed) {
    return fail(
      `conservation failed: pools ${reported} vs escrow ${summary.totalEscrowed}`,
    );
  }
  if (result.bidCount !== summary.bidCount) {
    return fail(`bid count mismatch: read ${result.bidCount} vs book ${summary.bidCount}`);
  }

  const digest = openDigest({
    chainId: cfg.chainId,
    book: bookReader().book,
    marketId,
    yesPool: result.yesPool,
    noPool: result.noPool,
    bidCount: result.bidCount,
    openingsRoot: result.openingsRoot,
  });
  // Sign the digest itself — openDigest already applied the EIP-191 prefix, so
  // signMessage would prefix it twice and the contract would recover garbage.
  let signature: Hex;
  try {
    signature = await signer.sign({ hash: digest });
  } catch (e) {
    return fail(`signing opening: ${e instanceof Error ? e.message : String(e)}`);
  }

  openedCount++;
  lastMarketOpened = marketId;
  lastBidCount = result.bidCount;

  // 4. Respond
  return ok({
    marketId,
    yesPool: result.yesPool.toString(),
    noPool: result.noPool.toString(),
    bidCount: result.bidCount,
    openingsRoot: result.openingsRoot,
    signature,
    teeSigner: signer.address,
    // Openings are published so bettors can build claim proofs. Safe now and
    // only now: the market is closed, so nothing here can be front-run.
    openings: result.openings.map((o) => ({
      index: o.index,
      side: o.side,
      amount: o.amount.toString(),
      bidder: o.bidder,
      malformed: o.malformed,
      proof: result.proofFor(o.index),
    })),
  });
}
