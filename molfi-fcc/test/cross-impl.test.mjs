/**
 * The standalone enclave and the compiled TEE image must agree exactly.
 *
 * `src/` is the enclave that runs on the host during development; `extension/`
 * is the same logic compiled into the Confidential Compute image that Flare
 * actually registered. They are separate codebases in separate languages'
 * dialects (plain ESM vs compiled TypeScript) resolving different @noble minor
 * versions, and the failure mode when they diverge is silent and expensive:
 * a bid sealed under one key derivation cannot be opened under another, so the
 * bettor's FXRP sits in the book until the market opens with their side guessed
 * wrong. Nothing throws at the moment of divergence — it throws weeks later, in
 * production, for someone else.
 *
 * These tests are the reason that cannot happen quietly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, hashMessage, keccak256, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import * as host from "../src/seal.mjs";
import * as hostBook from "../src/open-book.mjs";
import * as image from "../extension/dist/app/seal.js";
import * as imageBook from "../extension/dist/app/open-book.js";
import { decodeMarketId } from "../extension/dist/app/abi.js";

const MKT = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;
const BOOK = "0x22B0F197b12e86653d449326b7677e65e2162c90";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const ENCLAVE = `0x${"a1".repeat(32)}`;

const keys = host.enclaveKeypair(ENCLAVE);

test("both implementations derive the same enclave identity", () => {
  assert.deepEqual(image.enclaveKeypair(ENCLAVE), keys);
});

test("each implementation opens what the other sealed", () => {
  for (const side of [0, 1]) {
    const fromHost = host.sealSide(keys.publicKey, MKT, ALICE, side);
    const fromImage = image.sealSide(keys.publicKey, MKT, ALICE, side);

    assert.equal(image.openSealed(keys.privateKey, MKT, ALICE, fromHost), side);
    assert.equal(host.openSealed(keys.privateKey, MKT, ALICE, fromImage), side);
  }
});

test("ciphertexts are the same size, so length leaks nothing about the side", () => {
  const a = image.sealSide(keys.publicKey, MKT, ALICE, 0);
  const b = image.sealSide(keys.publicKey, MKT, ALICE, 1);
  assert.equal(a.length, b.length);
  assert.equal((a.length - 2) / 2, host.CIPHERTEXT_BYTES);
  assert.equal(image.CIPHERTEXT_BYTES, host.CIPHERTEXT_BYTES);
});

test("the image rejects a bid lifted into another market or by another bidder", () => {
  const ct = host.sealSide(keys.publicKey, MKT, ALICE, 0);
  assert.throws(() => image.openSealed(keys.privateKey, OTHER, ALICE, ct));
  assert.throws(() => image.openSealed(keys.privateKey, MKT, BOB, ct));
});

/** A book with both sides, uneven stakes, and one deliberately broken bid. */
function fixture(seal) {
  return [
    { bidder: ALICE, amount: 7_300_000n, ciphertext: seal(keys.publicKey, MKT, ALICE, 0) },
    { bidder: BOB, amount: 1_000_000n, ciphertext: seal(keys.publicKey, MKT, BOB, 1) },
    { bidder: CAROL, amount: 250_000n, ciphertext: seal(keys.publicKey, MKT, CAROL, 0) },
    // Not sealed to this enclave at all — anyone can call sealBid with garbage.
    { bidder: BOB, amount: 500_000n, ciphertext: `0x${"ee".repeat(62)}` },
  ];
}

test("both implementations open a whole book identically", () => {
  const bids = fixture(host.sealSide);
  const a = hostBook.openBook(keys.privateKey, MKT, bids);
  const b = imageBook.openBook(keys.privateKey, MKT, bids);

  assert.equal(a.yesPool, b.yesPool);
  assert.equal(a.noPool, b.noPool);
  assert.equal(a.bidCount, b.bidCount);
  assert.equal(a.openingsRoot, b.openingsRoot);
  assert.deepEqual(
    a.openings.map((o) => [o.index, o.side, o.amount, o.malformed]),
    b.openings.map((o) => [o.index, o.side, o.amount, o.malformed]),
  );
  for (let i = 0; i < bids.length; i++) {
    assert.deepEqual(a.proofFor(i), b.proofFor(i));
  }
});

test("conservation holds even with a malformed bid", () => {
  const bids = fixture(image.sealSide);
  const r = imageBook.openBook(keys.privateKey, MKT, bids);
  const escrow = bids.reduce((sum, b) => sum + b.amount, 0n);

  // Dropping the unreadable bid would break this sum and make the market
  // permanently unopenable — one griefer could freeze everybody's stake.
  assert.equal(r.yesPool + r.noPool, escrow);
  assert.equal(r.yesPool, 7_550_000n); // Alice + Carol
  assert.equal(r.noPool, 1_500_000n); // Bob + the malformed one, assigned to NO
  assert.equal(r.openings[3].malformed, true);
});

test("the openings root commits to the sides — flipping one changes it", () => {
  const bids = fixture(image.sealSide);
  const real = imageBook.openBook(keys.privateKey, MKT, bids);
  const flipped = imageBook.buildTree(
    real.openings.map((o, i) => imageBook.openingLeaf(i, i === 0 ? 1 : o.side)),
  );
  assert.notEqual(flipped.root, real.openingsRoot);
});

test("both implementations produce the same signing digest", () => {
  const bids = fixture(image.sealSide);
  const r = imageBook.openBook(keys.privateKey, MKT, bids);
  const args = {
    chainId: 114,
    book: BOOK,
    marketId: MKT,
    yesPool: r.yesPool,
    noPool: r.noPool,
    bidCount: r.bidCount,
    openingsRoot: r.openingsRoot,
  };
  assert.equal(imageBook.openDigest(args), hostBook.openDigest(args));
});

/** The pre-prefix hash openDigest wraps — the thing that gets personal-signed. */
function innerHash({ chainId, book, marketId, yesPool, noPool, bidCount, openingsRoot }) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" }, { type: "address" }, { type: "bytes32" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" },
      ],
      [BigInt(chainId), book, marketId, yesPool, noPool, bidCount, openingsRoot],
    ),
  );
}

test("the digest is the EIP-191 hash the contract recovers against", async () => {
  // openDigest applies the personal-sign prefix itself. Signing its output with
  // signMessage instead of sign would prefix a second time, ecrecover would
  // return a stranger, and openMarket would revert with BadSignature — leaving
  // the market permanently closed and every stake locked. This pins the prefix
  // to exactly one application.
  const bids = fixture(image.sealSide);
  const r = imageBook.openBook(keys.privateKey, MKT, bids);
  const args = { chainId: 114, book: BOOK, marketId: MKT, yesPool: r.yesPool,
    noPool: r.noPool, bidCount: r.bidCount, openingsRoot: r.openingsRoot };

  const digest = imageBook.openDigest(args);
  const inner = innerHash(args);
  assert.equal(hashMessage({ raw: inner }), digest);

  // And the signature the handler produces recovers to the configured signer,
  // which is what SealedBidBook compares against `teeSigner`.
  const signer = privateKeyToAccount(`0x${"b2".repeat(32)}`);
  const signature = await signer.sign({ hash: digest });
  assert.equal(
    await recoverMessageAddress({ message: { raw: inner }, signature }),
    signer.address,
  );
});

test("OPEN_BOOK accepts both payload encodings and rejects the rest", () => {
  // On-chain: abi.encode(bytes32). Off-chain keeper/app: JSON.
  assert.equal(decodeMarketId(MKT), MKT);
  assert.equal(
    decodeMarketId(`0x${Buffer.from(JSON.stringify({ marketId: MKT })).toString("hex")}`),
    MKT,
  );
  assert.throws(() => decodeMarketId("0x"), /empty payload/);
  assert.throws(() => decodeMarketId("0xdeadbeef"));
  assert.throws(() => decodeMarketId("0xZZ"), /non-hex/);
});
