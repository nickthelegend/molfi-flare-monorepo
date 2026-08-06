import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { id, keccak256, AbiCoder, solidityPacked, Wallet } from "ethers";

const DAY = 86_400;
const XRP_USD = "0x015852502f55534400000000000000000000000000";
const fxrp = (n: string) => ethers.parseUnits(n, 6);
const usd = (n: string) => ethers.parseUnits(n, 18);
const abi = AbiCoder.defaultAbiCoder();

const YES = 0;
const NO = 1;

/** Same leaf the contract computes: keccak(keccak(abi.encode(index, side))). */
const leafOf = (i: number, side: number) =>
  keccak256(solidityPacked(["bytes32"], [keccak256(abi.encode(["uint256", "uint32"], [i, side]))]));

/** Sorted-pair Merkle root + proofs, matching `_verifyProof`. */
function merkle(leaves: string[]) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, proof: () => [] as string[] };
  let level = [...leaves];
  const levels = [level];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a; // odd node carries up
      next.push(
        a <= b
          ? keccak256(solidityPacked(["bytes32", "bytes32"], [a, b]))
          : keccak256(solidityPacked(["bytes32", "bytes32"], [b, a])),
      );
    }
    level = next;
    levels.push(level);
  }
  return {
    root: level[0],
    proof(index: number) {
      const out: string[] = [];
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

async function deploy() {
  const [admin, alice, bob, carol, relayer] = await ethers.getSigners();
  // Stands in for the enclave's attested signing key.
  const tee = Wallet.createRandom();

  const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
  const market = await (
    await ethers.getContractFactory("MolfiMarket")
  ).deploy(await oracle.getAddress());
  const book = await (
    await ethers.getContractFactory("SealedBidBook")
  ).deploy(await token.getAddress(), await market.getAddress(), tee.address, admin.address);

  for (const s of [alice, bob, carol]) {
    await token.mintUnits(s.address, 10_000n);
    await token.connect(s).approve(await book.getAddress(), ethers.MaxUint256);
  }

  const close = (await time.latest()) + DAY;
  const MKT = id("xrp-sealed");
  await market.createPriceMarket(MKT, "XRP >= $3?", close, XRP_USD, usd("3"), 0, DAY * 2);

  const settle = async (price: string) => {
    await time.increaseTo(close + 1);
    await oracle.setPrice(XRP_USD, usd(price));
    await market.resolveFromOracle(MKT);
  };

  /** Sign an opening the way the enclave will. */
  const signOpen = async (
    yesPool: bigint,
    noPool: bigint,
    count: number,
    root: string,
    signer = tee,
  ) => {
    const digest = await book.openDigest(MKT, yesPool, noPool, count, root);
    // openDigest already applies the EIP-191 prefix, so sign the raw digest.
    return signer.signingKey.sign(digest).serialized;
  };

  return { admin, alice, bob, carol, relayer, tee, token, oracle, market, book, MKT, close, settle, signOpen };
}

describe("SealedBidBook — the book nobody can read while it fills", () => {
  it("reveals the size at stake but never the side, while the market is live", async () => {
    const { book, alice, bob, MKT } = await deploy();
    await book.connect(alice).sealBid(MKT, fxrp("100"), "0xdeadbeef");
    await book.connect(bob).sealBid(MKT, fxrp("400"), "0xfeedface");

    const [total, count, opened] = await book.bookStatus(MKT);
    expect(total).to.equal(fxrp("500"));
    expect(count).to.equal(2);
    expect(opened).to.equal(false);

    // Nothing on-chain says which way the 500 leans — the pools are still 0.
    const b = await book.books(MKT);
    expect(b.yesPool).to.equal(0);
    expect(b.noPool).to.equal(0);
  });

  it("rejects a bid once the market has closed", async () => {
    const { book, alice, MKT, close } = await deploy();
    await time.increaseTo(close + 1);
    await expect(
      book.connect(alice).sealBid(MKT, fxrp("10"), "0x01"),
    ).to.be.revertedWithCustomError(book, "MarketClosed");
  });

  it("rejects an empty ciphertext — that would be a bid with no sealed side", async () => {
    const { book, alice, MKT } = await deploy();
    await expect(
      book.connect(alice).sealBid(MKT, fxrp("10"), "0x"),
    ).to.be.revertedWithCustomError(book, "EmptyCiphertext");
  });

  describe("opening", () => {
    it("accepts the enclave's signed opening and publishes the pools", async () => {
      const { book, alice, bob, MKT, close, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("100"), "0x01");
      await book.connect(bob).sealBid(MKT, fxrp("400"), "0x02");
      await time.increaseTo(close + 1);

      const m = merkle([leafOf(0, YES), leafOf(1, NO)]);
      const sig = await signOpen(fxrp("100"), fxrp("400"), 2, m.root);

      await expect(book.openMarket(MKT, fxrp("100"), fxrp("400"), 2, m.root, sig))
        .to.emit(book, "MarketOpened")
        .withArgs(MKT, fxrp("100"), fxrp("400"), 2, m.root);

      const b = await book.books(MKT);
      expect(b.opened).to.equal(true);
      expect(b.yesPool).to.equal(fxrp("100"));
      expect(b.noPool).to.equal(fxrp("400"));
    });

    it("is permissionless to relay — the signature is the authority", async () => {
      const { book, alice, relayer, MKT, close, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("50"), "0x01");
      await time.increaseTo(close + 1);
      const m = merkle([leafOf(0, YES)]);
      const sig = await signOpen(fxrp("50"), 0n, 1, m.root);
      // A random account submits it; the enclave never needs gas.
      await expect(book.connect(relayer).openMarket(MKT, fxrp("50"), 0n, 1, m.root, sig)).to.not.be
        .reverted;
    });

    it("REJECTS an opening that does not conserve the escrowed total", async () => {
      // The enclave's whole opportunity to cheat is under-reporting a pool and
      // pocketing the difference. The chain already knows the total.
      const { book, alice, bob, MKT, close, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("100"), "0x01");
      await book.connect(bob).sealBid(MKT, fxrp("400"), "0x02");
      await time.increaseTo(close + 1);

      const m = merkle([leafOf(0, YES), leafOf(1, NO)]);
      const short = await signOpen(fxrp("100"), fxrp("300"), 2, m.root); // 100 missing
      await expect(
        book.openMarket(MKT, fxrp("100"), fxrp("300"), 2, m.root, short),
      ).to.be.revertedWithCustomError(book, "ConservationFailed");

      const inflated = await signOpen(fxrp("100"), fxrp("900"), 2, m.root);
      await expect(
        book.openMarket(MKT, fxrp("100"), fxrp("900"), 2, m.root, inflated),
      ).to.be.revertedWithCustomError(book, "ConservationFailed");
    });

    it("REJECTS an opening that drops a bid from the count", async () => {
      const { book, alice, bob, MKT, close, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("100"), "0x01");
      await book.connect(bob).sealBid(MKT, fxrp("400"), "0x02");
      await time.increaseTo(close + 1);
      const m = merkle([leafOf(0, YES)]);
      const sig = await signOpen(fxrp("100"), fxrp("400"), 1, m.root); // says 1, really 2
      await expect(
        book.openMarket(MKT, fxrp("100"), fxrp("400"), 1, m.root, sig),
      ).to.be.revertedWithCustomError(book, "CountMismatch");
    });

    it("REJECTS an opening signed by anyone but the attested enclave", async () => {
      const { book, alice, MKT, close, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("50"), "0x01");
      await time.increaseTo(close + 1);
      const m = merkle([leafOf(0, YES)]);
      const impostor = Wallet.createRandom();
      const sig = await signOpen(fxrp("50"), 0n, 1, m.root, impostor);
      await expect(
        book.openMarket(MKT, fxrp("50"), 0n, 1, m.root, sig),
      ).to.be.revertedWithCustomError(book, "BadSignature");
    });

    it("rejects opening before close, and opening twice", async () => {
      const { book, alice, MKT, close, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("50"), "0x01");
      const m = merkle([leafOf(0, YES)]);
      const sig = await signOpen(fxrp("50"), 0n, 1, m.root);

      await expect(
        book.openMarket(MKT, fxrp("50"), 0n, 1, m.root, sig),
      ).to.be.revertedWithCustomError(book, "NotClosedYet");

      await time.increaseTo(close + 1);
      await book.openMarket(MKT, fxrp("50"), 0n, 1, m.root, sig);
      await expect(
        book.openMarket(MKT, fxrp("50"), 0n, 1, m.root, sig),
      ).to.be.revertedWithCustomError(book, "AlreadyOpened");
    });
  });

  describe("claiming", () => {
    it("pays a winner pro-rata over the whole pot, net of the 2% fee", async () => {
      const { book, token, alice, bob, MKT, close, settle, signOpen, admin } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("100"), "0x01"); // YES
      await book.connect(bob).sealBid(MKT, fxrp("400"), "0x02"); //  NO
      await settle("3.50"); // YES wins

      const m = merkle([leafOf(0, YES), leafOf(1, NO)]);
      const sig = await signOpen(fxrp("100"), fxrp("400"), 2, m.root);
      await book.openMarket(MKT, fxrp("100"), fxrp("400"), 2, m.root, sig);

      const before = await token.balanceOf(alice.address);
      const vaultBefore = await token.balanceOf(admin.address);
      await book.connect(alice).claim(MKT, 0, YES, m.proof(0));

      // Sole YES bettor takes the whole 500 pot, less 2%.
      const gross = fxrp("500");
      const fee = (gross * 200n) / 10_000n;
      expect((await token.balanceOf(alice.address)) - before).to.equal(gross - fee);
      expect((await token.balanceOf(admin.address)) - vaultBefore).to.equal(fee);
    });

    it("REJECTS claiming a side you did not seal", async () => {
      // The side comes from the enclave's openings tree, not the caller.
      const { book, alice, bob, MKT, settle, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("100"), "0x01");
      await book.connect(bob).sealBid(MKT, fxrp("400"), "0x02");
      await settle("3.50"); // YES wins; bob sealed NO

      const m = merkle([leafOf(0, YES), leafOf(1, NO)]);
      const sig = await signOpen(fxrp("100"), fxrp("400"), 2, m.root);
      await book.openMarket(MKT, fxrp("100"), fxrp("400"), 2, m.root, sig);

      // Bob claims his own index but asserts YES — no proof exists for that leaf.
      await expect(
        book.connect(bob).claim(MKT, 1, YES, m.proof(1)),
      ).to.be.revertedWithCustomError(book, "BadOpeningProof");

      // And with his true side, he simply lost.
      await expect(
        book.connect(bob).claim(MKT, 1, NO, m.proof(1)),
      ).to.be.revertedWithCustomError(book, "NotAWinner");
    });

    it("rejects a double claim", async () => {
      const { book, alice, MKT, settle, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("100"), "0x01");
      await settle("3.50");
      const m = merkle([leafOf(0, YES)]);
      const sig = await signOpen(fxrp("100"), 0n, 1, m.root);
      await book.openMarket(MKT, fxrp("100"), 0n, 1, m.root, sig);

      await book.connect(alice).claim(MKT, 0, YES, m.proof(0));
      await expect(
        book.connect(alice).claim(MKT, 0, YES, m.proof(0)),
      ).to.be.revertedWithCustomError(book, "AlreadyClaimed");
    });

    it("refunds rather than paying an undefined multiple on a one-sided book", async () => {
      // Everyone picked the losing side: winPool is 0, so pro-rata is undefined.
      const { book, token, alice, MKT, settle, signOpen } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("100"), "0x01");
      await settle("2.00"); // NO wins, but the only bid was… also NO here
      const m = merkle([leafOf(0, NO)]);
      const sig = await signOpen(0n, fxrp("100"), 1, m.root);
      await book.openMarket(MKT, 0n, fxrp("100"), 1, m.root, sig);

      const before = await token.balanceOf(alice.address);
      await book.connect(alice).claim(MKT, 0, NO, m.proof(0));
      // Sole NO bettor in a NO-winning book: pot is entirely hers, minus fee.
      expect((await token.balanceOf(alice.address)) - before).to.equal(
        fxrp("100") - (fxrp("100") * 200n) / 10_000n,
      );
    });

    it("cannot claim before the book is opened", async () => {
      const { book, alice, MKT, settle } = await deploy();
      await book.connect(alice).sealBid(MKT, fxrp("100"), "0x01");
      await settle("3.50");
      const m = merkle([leafOf(0, YES)]);
      await expect(
        book.connect(alice).claim(MKT, 0, YES, m.proof(0)),
      ).to.be.revertedWithCustomError(book, "NotOpened");
    });
  });

  it("lets the admin rotate the enclave key after a TEE redeploy", async () => {
    const { book, admin, alice, MKT, close, signOpen } = await deploy();
    const next = Wallet.createRandom();
    await expect(book.connect(alice).setTeeSigner(next.address)).to.be.revertedWithCustomError(
      book,
      "NotAdmin",
    );
    await book.connect(admin).setTeeSigner(next.address);
    expect(await book.teeSigner()).to.equal(next.address);

    await book.connect(alice).sealBid(MKT, fxrp("10"), "0x01");
    await time.increaseTo(close + 1);
    const m = merkle([leafOf(0, YES)]);
    // The OLD key no longer opens anything.
    const stale = await signOpen(fxrp("10"), 0n, 1, m.root);
    await expect(
      book.openMarket(MKT, fxrp("10"), 0n, 1, m.root, stale),
    ).to.be.revertedWithCustomError(book, "BadSignature");
    const fresh = await signOpen(fxrp("10"), 0n, 1, m.root, next);
    await expect(book.openMarket(MKT, fxrp("10"), 0n, 1, m.root, fresh)).to.not.be.reverted;
  });
});
