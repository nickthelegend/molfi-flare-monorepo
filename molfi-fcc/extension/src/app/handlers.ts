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
import { encodeAbiParameters, type Hex } from "viem";

import { decodeMarketId } from "./abi.js";
import { BookReader } from "./chain.js";
import {
  loadConfig,
  OP_COMMAND_OPEN_BOOK,
  OP_COMMAND_OPENINGS,
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

/**
 * Computed openings, keyed by market.
 *
 * Safe to cache indefinitely, and that is not an optimisation gamble: `sealBid`
 * reverts once a market has closed, so a closed book can never gain a bid. Its
 * opening is therefore final the moment it is first computed.
 *
 * This exists because of the 2-second ceiling. Even fully batched, reading a
 * book costs a round trip per multicall and grows with the number of bids — a
 * large book would blow the budget however well it is written. Computing once
 * and answering from memory makes the second attempt instant regardless of size.
 */
const openings = new Map<string, { book: Hex; result: ReturnType<typeof openBook> }>();

/** Lazy so a missing SEALED_BID_BOOK breaks OPEN_BOOK only, never startup. */
function bookReader(): BookReader {
  if (!reader) reader = new BookReader(cfg);
  return reader;
}

// --- Extension state ---------------------------------------------------------
let cachedSigner: string | null = null;
let openedCount = 0;
let lastMarketOpened: string | null = null;
let lastBidCount = 0;

/** Reset all state. Used by tests; not part of the wire contract. */
export function resetState(env?: NodeJS.ProcessEnv): void {
  openedCount = 0;
  lastMarketOpened = null;
  lastBidCount = 0;
  openings.clear();
  cachedSigner = null;
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
  framework.handle(OP_TYPE_MOLFI, OP_COMMAND_OPENINGS, handleOpenings);

  // Once per process. The container registers once; test suites construct a
  // Server per case, and repeating the key on every one buries the output.
  if (bannerShown) return;
  bannerShown = true;

  // Pay the RPC's fixed costs now — see BookReader.warm(). tee-node allows two
  // seconds per action and a cold client spends most of that before it reads
  // anything.
  if (cfg.book) {
    bookReader()
      .warm()
      .then(() => console.log("[molfi] chain client warm — multicall + market cached"))
      .catch((e) => console.warn(`[molfi] warmup failed (will retry lazily): ${e.message}`));
  }

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
    commands: [OP_COMMAND_SEAL_KEY, OP_COMMAND_OPEN_BOOK, OP_COMMAND_OPENINGS],
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
 * Everything both open-paths need, computed once.
 *
 * Returns either a failure string or the opened book plus what the chain says
 * about it, so the two handlers cannot drift on the guards that matter.
 */
async function computeOpening(
  msg: string,
): Promise<
  | { error: string }
  | {
      marketId: Hex;
      book: Hex;
      result: ReturnType<typeof openBook>;
      expectedSigner: string;
    }
> {
  let marketId: Hex;
  try {
    marketId = decodeMarketId(msg);
  } catch (e) {
    return { error: `decoding request: ${e instanceof Error ? e.message : String(e)}` };
  }

  // A cached opening answers in microseconds. The guards below still run on the
  // first computation; re-deriving them per call would reintroduce the latency
  // the cache exists to remove, and a closed book cannot change.
  const hit = openings.get(marketId.toLowerCase());
  if (hit) {
    return { marketId, book: hit.book, result: hit.result, expectedSigner: cachedSigner ?? signer.address };
  }

  let summary;
  let bids;
  let expectedSigner;
  let closeInfo;
  let reader;
  // Two round trips, not three.
  //
  // `bids()` used to fetch the bid count itself, and that read could only start
  // after the client was ready — so the critical path was
  // `books` → `bidCount` → `getBid`, three Coston2 round trips at 0.4-0.6s
  // each, against tee-node's hard 2s ProxyTimeout. `books()` already carries
  // the count, so the first group now yields it and the `getBid` batch is the
  // only thing left to wait for.
  try {
    reader = bookReader();
    [summary, expectedSigner, closeInfo] = await Promise.all([
      reader.summary(marketId), reader.teeSigner(), reader.closeInfo(marketId),
    ]);
    bids = await reader.bids(marketId, summary.bidCount);
  } catch (e) {
    return { error: `reading book: ${e instanceof Error ? e.message : String(e)}` };
  }

  // THE MARKET MUST BE CLOSED. This is the whole product.
  //
  // Opening reveals every bidder's plaintext side. `openMarket` already refuses
  // an early opening with NotClosedYet — but that protects settlement, not
  // secrecy: the response has already left the enclave by the time the contract
  // says no. Without this, anyone who can reach the extension reads the live
  // book and front-runs it.
  if (closeInfo.now < closeInfo.closeTs) {
    return {
      error:
        `market is still open — closes in ${closeInfo.closeTs - closeInfo.now}s. ` +
        "The book cannot be opened before close.",
    };
  }
  if (bids.length === 0) return { error: "no sealed bids for this market" };

  // The confidential part. Plaintext sides exist only in here.
  const result = openBook(enclave.privateKey, marketId, bids);
  openings.set(marketId.toLowerCase(), { book: reader.book, result });

  // The contract will reject an opening that fails to reconcile. Checking the
  // same invariants here turns that revert into a diagnosis: a mismatch means
  // the chain moved under the read, not that the decryption was wrong.
  const reported = result.yesPool + result.noPool;
  if (reported !== summary.totalEscrowed) {
    return { error: `conservation failed: pools ${reported} vs escrow ${summary.totalEscrowed}` };
  }
  if (result.bidCount !== summary.bidCount) {
    return { error: `bid count mismatch: read ${result.bidCount} vs book ${summary.bidCount}` };
  }

  cachedSigner = expectedSigner;
  return { marketId, book: reader.book, result, expectedSigner };
}

/**
 * MOLFI/OPEN_BOOK — payload is a market id (raw bytes32 or `{"marketId":…}`).
 *
 * THE RESPONSE IS CONSUMED BY A CONTRACT, so it is the ABI tuple
 * `SealedBidBook.openMarketFromTee` decodes and nothing else. tee-node signs
 * whatever an extension returns here with the node's attested identity key, and
 * that signed pair — data plus signature — IS the authorisation. A JSON blob
 * would be just as signed and completely unusable.
 *
 * The per-bid openings and Merkle proofs live in MOLFI/OPENINGS instead; there
 * is no room for them here and they are not what settles the market.
 *
 * Everything except the id is read from chain, so a caller cannot substitute a
 * bidder or an amount.
 */
export async function handleOpenBook(msg: string): Promise<HandlerResult> {
  const opened = await computeOpening(msg);
  if ("error" in opened) return fail(opened.error);
  const { marketId, book, result } = opened;

  openedCount++;
  lastMarketOpened = marketId;
  lastBidCount = result.bidCount;

  // The book address is inside the signed bytes so a result meant for one
  // deployment cannot be relayed into another that trusts the same machine.
  return [
    encodeAbiParameters(
      [
        { type: "address" }, { type: "bytes32" }, { type: "uint256" },
        { type: "uint256" }, { type: "uint32" }, { type: "bytes32" },
      ],
      [book, marketId, result.yesPool, result.noPool, result.bidCount, result.openingsRoot],
    ),
    1,
    null,
  ];
}

/**
 * MOLFI/OPENINGS — the per-bid sides and Merkle proofs, for claiming.
 *
 * Same close guard as OPEN_BOOK: these ARE the book, and publishing them early
 * would leak it just as completely.
 *
 * Also carries a signature over `SealedBidBook.openDigest` for the older
 * `openMarket` path. That signature is only meaningful if the book still trusts
 * this enclave's signing key, so a drift is reported rather than hidden — the
 * TEE-node path does not need it at all, and refusing outright would block a
 * settlement that has another way through.
 */
export async function handleOpenings(msg: string): Promise<HandlerResult> {
  const opened = await computeOpening(msg);
  if ("error" in opened) return fail(opened.error);
  const { marketId, book, result, expectedSigner } = opened;

  const digest = openDigest({
    chainId: cfg.chainId,
    book,
    marketId,
    yesPool: result.yesPool,
    noPool: result.noPool,
    bidCount: result.bidCount,
    openingsRoot: result.openingsRoot,
  });
  // Sign the digest itself — openDigest already applied the EIP-191 prefix, so
  // signMessage would prefix it twice and the contract would recover garbage.
  let signature: Hex | null = null;
  try {
    signature = await signer.sign({ hash: digest });
  } catch {
    signature = null;
  }

  return ok({
    marketId,
    book,
    yesPool: result.yesPool.toString(),
    noPool: result.noPool.toString(),
    bidCount: result.bidCount,
    openingsRoot: result.openingsRoot,
    signature,
    teeSigner: signer.address,
    signerAccepted: expectedSigner.toLowerCase() === signer.address.toLowerCase(),
    bookTrusts: expectedSigner,
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
