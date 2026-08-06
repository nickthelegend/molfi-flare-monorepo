import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { id, Wallet } from "ethers";
// @ts-expect-error — plain-JS enclave modules, no types
import { openBook, openDigest, openingLeaf } from "../../molfi-fcc/src/open-book.mjs";
// @ts-expect-error
import { sealSide, enclaveKeypair } from "../../molfi-fcc/src/seal.mjs";

const DAY = 86_400;
const XRP_USD = "0x015852502f55534400000000000000000000000000";
const fxrp = (n: string) => ethers.parseUnits(n, 6);
const usd = (n: string) => ethers.parseUnits(n, 18);

/**
 * End-to-end against the REAL enclave code — not a reimplementation of it.
 *
 * Bids are sealed with the extension's own `sealSide`, opened with its own
 * `openBook`, and the resulting root, digest and proofs are handed to the
 * deployed contract. If the two sides ever disagree on a leaf ordering, a hash
 * preimage or the digest layout, these fail — which is the point, because in
 * production that disagreement would strand every bettor's payout.
 */
describe("SealedBidBook × enclave — cross-implementation", () => {
  it("opens a real sealed book and every bettor can claim with the enclave's proof", async () => {
    const [admin, alice, bob, carol] = await ethers.getSigners();
    const enclave = enclaveKeypair();
    const teeWallet = Wallet.createRandom();

    const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
    const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
    const market = await (
      await ethers.getContractFactory("MolfiMarket")
    ).deploy(await oracle.getAddress());
    const book = await (
      await ethers.getContractFactory("SealedBidBook")
    ).deploy(await token.getAddress(), await market.getAddress(), teeWallet.address, admin.address);
    const bookAddr = await book.getAddress();

    for (const s of [alice, bob, carol]) {
      await token.mintUnits(s.address, 10_000n);
      await token.connect(s).approve(bookAddr, ethers.MaxUint256);
    }

    const close = (await time.latest()) + DAY;
    const MKT = id("xrp-enclave");
    await market.createPriceMarket(MKT, "XRP >= $3?", close, XRP_USD, usd("3"), 0, DAY * 2);

    // Three bettors seal real ciphertexts with the extension's own code.
    const plan = [
      { signer: alice, amount: fxrp("100"), side: 0 },
      { signer: bob, amount: fxrp("400"), side: 1 },
      { signer: carol, amount: fxrp("250"), side: 0 },
    ];
    for (const p of plan) {
      const ct = sealSide(enclave.publicKey, MKT, p.signer.address, p.side);
      await book.connect(p.signer).sealBid(MKT, p.amount, ct);
    }

    // Nothing on-chain reveals the split while it is live.
    const [total, count, opened] = await book.bookStatus(MKT);
    expect(total).to.equal(fxrp("750"));
    expect(count).to.equal(3);
    expect(opened).to.equal(false);

    await time.increaseTo(close + 1);
    await oracle.setPrice(XRP_USD, usd("3.50"));
    await market.resolveFromOracle(MKT); // YES wins

    // The enclave reads the book straight off the contract and opens it.
    const bids = [];
    for (let i = 0; i < Number(count); i++) {
      const [bidder, amount, ciphertext] = await book.getBid(MKT, i);
      bids.push({ bidder, amount, ciphertext });
    }
    const result = openBook(enclave.privateKey, MKT, bids);

    expect(result.yesPool).to.equal(fxrp("350")); // alice 100 + carol 250
    expect(result.noPool).to.equal(fxrp("400"));
    expect(result.openings.every((o: any) => !o.malformed)).to.equal(true);

    // Its digest must match the contract's, byte for byte.
    const mine = openDigest({
      chainId: (await ethers.provider.getNetwork()).chainId,
      book: bookAddr,
      marketId: MKT,
      yesPool: result.yesPool,
      noPool: result.noPool,
      bidCount: result.bidCount,
      openingsRoot: result.openingsRoot,
    });
    const theirs = await book.openDigest(
      MKT, result.yesPool, result.noPool, result.bidCount, result.openingsRoot,
    );
    expect(mine).to.equal(theirs, "enclave and contract disagree on the signing digest");

    const sig = teeWallet.signingKey.sign(theirs).serialized;
    await book.openMarket(
      MKT, result.yesPool, result.noPool, result.bidCount, result.openingsRoot, sig,
    );

    // Both YES bettors claim with proofs the enclave produced.
    const pot = fxrp("750");
    for (const idx of [0, 2]) {
      const o = result.openings[idx];
      const before = await token.balanceOf(o.bidder);
      await book.claim(MKT, idx, o.side, result.proofFor(idx));
      const gross = (o.amount * pot) / result.yesPool;
      const fee = (gross * 200n) / 10_000n;
      expect((await token.balanceOf(o.bidder)) - before).to.equal(gross - fee);
    }

    // The NO bettor lost, and his own proof proves it.
    await expect(
      book.claim(MKT, 1, result.openings[1].side, result.proofFor(1)),
    ).to.be.revertedWithCustomError(book, "NotAWinner");
  });

  it("a garbage ciphertext is still counted, so one bad bid cannot grief the market", async () => {
    // sealBid takes arbitrary bytes. If the enclave dropped what it could not
    // decrypt, the totals would stop reconciling and NOBODY could be paid.
    const [admin, alice, bob] = await ethers.getSigners();
    const enclave = enclaveKeypair();
    const teeWallet = Wallet.createRandom();

    const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
    const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
    const market = await (
      await ethers.getContractFactory("MolfiMarket")
    ).deploy(await oracle.getAddress());
    const book = await (
      await ethers.getContractFactory("SealedBidBook")
    ).deploy(await token.getAddress(), await market.getAddress(), teeWallet.address, admin.address);

    for (const s of [alice, bob]) {
      await token.mintUnits(s.address, 10_000n);
      await token.connect(s).approve(await book.getAddress(), ethers.MaxUint256);
    }
    const close = (await time.latest()) + DAY;
    const MKT = id("xrp-garbage");
    await market.createPriceMarket(MKT, "XRP >= $3?", close, XRP_USD, usd("3"), 0, DAY * 2);

    await book.connect(alice).sealBid(MKT, fxrp("100"), sealSide(enclave.publicKey, MKT, alice.address, 0));
    await book.connect(bob).sealBid(MKT, fxrp("60"), "0xdeadbeefdeadbeef"); // not a real seal

    await time.increaseTo(close + 1);
    const bids = [];
    for (let i = 0; i < 2; i++) {
      const [bidder, amount, ciphertext] = await book.getBid(MKT, i);
      bids.push({ bidder, amount, ciphertext });
    }
    const r = openBook(enclave.privateKey, MKT, bids);

    expect(r.openings[1].malformed).to.equal(true);
    // Still conserved — which is what lets the opening be accepted at all.
    expect(r.yesPool + r.noPool).to.equal(fxrp("160"));

    const digest = await book.openDigest(MKT, r.yesPool, r.noPool, r.bidCount, r.openingsRoot);
    const sig = teeWallet.signingKey.sign(digest).serialized;
    await expect(
      book.openMarket(MKT, r.yesPool, r.noPool, r.bidCount, r.openingsRoot, sig),
    ).to.not.be.reverted;
  });
});
