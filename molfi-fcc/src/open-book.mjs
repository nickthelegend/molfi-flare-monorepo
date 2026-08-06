/**
 * Opening a sealed book — the computation that only a TEE can do.
 *
 * Every bid's side is encrypted to this enclave. Nobody else — not the
 * operator, not the other bettors, not the chain — can read any of them. At
 * close the enclave decrypts all of them at once, totals the two pools, commits
 * the individual openings to a Merkle tree, and signs the result for
 * `SealedBidBook.openMarket`.
 *
 * The signature does NOT ask anyone to take the totals on faith. The contract
 * independently knows the bid count and the exact FXRP escrowed, and rejects an
 * opening that fails to reconcile with both. This module therefore has no
 * discretion worth abusing: it can only report the truth or be rejected.
 */
import { keccak256, encodeAbiParameters, concatHex } from "viem";
import { openSealed } from "./seal.mjs";

export const OUTCOME_YES = 0;
export const OUTCOME_NO = 1;

/** Leaf = keccak(keccak(abi.encode(bidIndex, side))), matching the contract. */
export function openingLeaf(bidIndex, side) {
  return keccak256(
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint32" }],
        [BigInt(bidIndex), side],
      ),
    ),
  );
}

const hashPair = (a, b) =>
  a.toLowerCase() <= b.toLowerCase() ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));

/**
 * Sorted-pair Merkle tree over the openings.
 *
 * Sorted pairs mean the contract's verifier needs no direction bits, and an odd
 * node carries up unchanged. Must match `SealedBidBook._verifyProof` exactly.
 */
export function buildTree(leaves) {
  if (leaves.length === 0) {
    return { root: `0x${"00".repeat(32)}`, proof: () => [] };
  }
  const levels = [[...leaves]];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(hashPair(cur[i], cur[i + 1] ?? cur[i]));
    }
    levels.push(next);
  }
  return {
    root: levels[levels.length - 1][0],
    proof(index) {
      const out = [];
      let idx = index;
      for (let d = 0; d < levels.length - 1; d++) {
        const lvl = levels[d];
        const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
        out.push(lvl[sib] ?? lvl[idx]);
        idx = Math.floor(idx / 2);
      }
      return out;
    },
  };
}

/**
 * Open every sealed bid and total the pools.
 *
 * @param bids `[{ bidder, amount (bigint), ciphertext }]` read from the book
 * @returns `{ yesPool, noPool, bidCount, openingsRoot, openings }`
 *
 * A bid whose ciphertext will not authenticate is a real possibility — someone
 * can call `sealBid` with arbitrary bytes. It cannot be dropped (the contract
 * counts it and holds its FXRP) and it cannot be guessed at. It is assigned to
 * NO deterministically and reported, so the totals still reconcile and the
 * bidder can still prove their leaf. Silently discarding it would make the
 * conservation check fail and the whole market unopenable — one malformed bid
 * would grief everybody.
 */
export function openBook(enclavePrivKey, marketId, bids) {
  let yesPool = 0n;
  let noPool = 0n;
  const openings = [];

  bids.forEach((bid, index) => {
    let side;
    let malformed = false;
    try {
      side = openSealed(enclavePrivKey, marketId, bid.bidder, bid.ciphertext);
    } catch {
      side = OUTCOME_NO;
      malformed = true;
    }
    if (side === OUTCOME_YES) yesPool += BigInt(bid.amount);
    else noPool += BigInt(bid.amount);
    openings.push({ index, side, amount: BigInt(bid.amount), bidder: bid.bidder, malformed });
  });

  const tree = buildTree(openings.map((o) => openingLeaf(o.index, o.side)));
  return {
    marketId,
    yesPool,
    noPool,
    bidCount: bids.length,
    openingsRoot: tree.root,
    openings,
    proofFor: (index) => tree.proof(index),
  };
}

/**
 * The digest `SealedBidBook.openDigest` produces, recomputed here.
 *
 * Derived from the same fields in the same order rather than fetched, so the
 * enclave never signs something it did not itself construct.
 */
export function openDigest({ chainId, book, marketId, yesPool, noPool, bidCount, openingsRoot }) {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" }, { type: "address" }, { type: "bytes32" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" },
      ],
      [BigInt(chainId), book, marketId, yesPool, noPool, bidCount, openingsRoot],
    ),
  );
  // EIP-191 personal-sign prefix — "\x19Ethereum Signed Message:\n32".
  return keccak256(concatHex(["0x19457468657265756d205369676e6564204d6573736167653a0a3332", inner]));
}
