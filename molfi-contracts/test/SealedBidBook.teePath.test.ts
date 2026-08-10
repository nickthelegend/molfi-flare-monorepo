import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { AbiCoder, concat, getBytes, id, keccak256, toUtf8Bytes, Wallet } from "ethers";
// @ts-expect-error — plain-JS enclave modules, no types
import { sealSide, enclaveKeypair } from "../../molfi-fcc/src/seal.mjs";
// @ts-expect-error
import { openBook } from "../../molfi-fcc/src/open-book.mjs";

/**
 * `openMarketFromTee` — the second authorisation path.
 *
 * `openMarket` trusts `teeSigner`, a key the extension is handed through its
 * environment. This path trusts `teeMachine`: the identity Flare's registry
 * attested, whose key signs ActionResults inside tee-node where the extension
 * cannot reach it.
 *
 * The thing worth testing hardest is that a stronger signer buys no extra
 * latitude. Authorisation decides WHO may publish an opening; the chain still
 * decides whether the numbers are allowed to be true.
 */
const abi = AbiCoder.defaultAbiCoder();
const PREFIX = "0x" + Buffer.from("TEE_ACTION_RESULT", "utf8").toString("hex").padEnd(64, "0");
const DAY = 86_400;
const XRP_USD = "0x015852502f55534400000000000000000000000000";
const fxrp = (n: string) => ethers.parseUnits(n, 6);
const usd = (n: string) => ethers.parseUnits(n, 18);
const TAG = "threshold";
const ACTION_ID = `0x${"a7".repeat(32)}`;

function signedResult(node: Wallet, chainId: bigint, data: string, status = 1, tag = TAG) {
  const rh = keccak256(
    concat([keccak256(data), getBytes(ACTION_ID), keccak256(toUtf8Bytes(tag)), Uint8Array.of(status)]),
  );
  const payload = keccak256(abi.encode(["bytes32", "uint256", "bytes32"], [PREFIX, chainId, rh]));
  return node.signMessage(getBytes(payload));
}

const encodeResult = (book: string, marketId: string, yes: bigint, no: bigint, count: number, root: string) =>
  abi.encode(
    ["address", "bytes32", "uint256", "uint256", "uint32", "bytes32"],
    [book, marketId, yes, no, count, root],
  );

describe("SealedBidBook × TEE_ACTION_RESULT", () => {
  async function fixture() {
    const [admin, alice, bob] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const enclave = enclaveKeypair();
    // Deliberately distinct: the point of this path is that the machine
    // identity, not the configured signer, is what authorises.
    const teeSignerWallet = Wallet.createRandom();
    const node = Wallet.createRandom();

    const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
    const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
    const market = await (
      await ethers.getContractFactory("MolfiMarket")
    ).deploy(await oracle.getAddress());
    const book = await (
      await ethers.getContractFactory("SealedBidBook")
    ).deploy(await token.getAddress(), await market.getAddress(), teeSignerWallet.address, admin.address);
    const bookAddr = await book.getAddress();
    await book.setTeeMachine(node.address);

    for (const s of [alice, bob]) {
      await token.mintUnits(s.address, 10_000n);
      await token.connect(s).approve(bookAddr, ethers.MaxUint256);
    }
    const close = (await time.latest()) + DAY;
    const MKT = id(`tee-path-${Math.floor(Math.random() * 1e9)}`);
    await market.createPriceMarket(MKT, "XRP >= $3?", close, XRP_USD, usd("3"), 0, DAY * 2);

    await book.connect(alice).sealBid(MKT, fxrp("100"), sealSide(enclave.publicKey, MKT, alice.address, 0));
    await book.connect(bob).sealBid(MKT, fxrp("400"), sealSide(enclave.publicKey, MKT, bob.address, 1));

    await time.increaseTo(close + 1);
    await oracle.setPrice(XRP_USD, usd("3.50"));
    await market.resolveFromOracle(MKT);

    const bids = [];
    for (let i = 0; i < 2; i++) {
      const [bidder, amount, ciphertext] = await book.getBid(MKT, i);
      bids.push({ bidder, amount, ciphertext });
    }
    const opened = openBook(enclave.privateKey, MKT, bids);

    return { admin, alice, bob, book, bookAddr, token, market, node, chainId, MKT, opened, enclave };
  }

  it("opens a book on the registered machine's signature alone", async () => {
    const { book, bookAddr, node, chainId, MKT, opened } = await fixture();
    const data = encodeResult(bookAddr, MKT, opened.yesPool, opened.noPool, opened.bidCount, opened.openingsRoot);
    await expect(book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(node, chainId, data)))
      .to.emit(book, "MarketOpened")
      .withArgs(MKT, opened.yesPool, opened.noPool, opened.bidCount, opened.openingsRoot);

    const [, , isOpen] = await book.bookStatus(MKT);
    expect(isOpen).to.equal(true);
  });

  it("pays out identically to the teeSigner path — same settlement core", async () => {
    const { book, bookAddr, token, node, chainId, MKT, opened } = await fixture();
    const data = encodeResult(bookAddr, MKT, opened.yesPool, opened.noPool, opened.bidCount, opened.openingsRoot);
    await book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(node, chainId, data));

    const winner = opened.openings.find((o: any) => o.side === 0);
    const before = await token.balanceOf(winner.bidder);
    await book.claim(MKT, winner.index, winner.side, opened.proofFor(winner.index));
    const pot = fxrp("500");
    const gross = (BigInt(winner.amount) * pot) / opened.yesPool;
    expect((await token.balanceOf(winner.bidder)) - before).to.equal(gross - (gross * 200n) / 10_000n);
  });

  describe("a stronger signer buys no latitude", () => {
    it("STILL rejects an opening that does not conserve the escrow", async () => {
      // The whole security argument. If the machine signature were enough on
      // its own, a compromised enclave could move a bettor's stake to the other
      // side and the contract would take its word for it.
      const { book, bookAddr, node, chainId, MKT, opened } = await fixture();
      const data = encodeResult(bookAddr, MKT, fxrp("450"), fxrp("400"), opened.bidCount, opened.openingsRoot);
      await expect(
        book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(node, chainId, data)),
      ).to.be.revertedWithCustomError(book, "ConservationFailed");
    });

    it("STILL rejects a mismatched bid count", async () => {
      const { book, bookAddr, node, chainId, MKT, opened } = await fixture();
      const data = encodeResult(bookAddr, MKT, opened.yesPool, opened.noPool, 1, opened.openingsRoot);
      await expect(
        book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(node, chainId, data)),
      ).to.be.revertedWithCustomError(book, "CountMismatch");
    });
  });

  describe("what the machine signature does not license", () => {
    it("rejects a result signed by anyone else", async () => {
      const { book, bookAddr, chainId, MKT, opened } = await fixture();
      const impostor = Wallet.createRandom();
      const data = encodeResult(bookAddr, MKT, opened.yesPool, opened.noPool, opened.bidCount, opened.openingsRoot);
      await expect(
        book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(impostor, chainId, data)),
      ).to.be.revertedWithCustomError(book, "BadSignature");
    });

    it("rejects a result addressed to a different book", async () => {
      // resultData carries the book address INSIDE the signed bytes, so a
      // legitimately-signed opening for one deployment cannot be relayed into
      // another that trusts the same machine.
      const { book, node, chainId, MKT, opened } = await fixture();
      const elsewhere = "0x000000000000000000000000000000000000dEaD";
      const data = encodeResult(elsewhere, MKT, opened.yesPool, opened.noPool, opened.bidCount, opened.openingsRoot);
      await expect(
        book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(node, chainId, data)),
      ).to.be.revertedWithCustomError(book, "WrongBook");
    });

    it("rejects a FAILED action's payload", async () => {
      // status 0 is the extension reporting its own failure. Publishing that
      // payload would settle the market on whatever was in the error path.
      const { book, bookAddr, node, chainId, MKT, opened } = await fixture();
      const data = encodeResult(bookAddr, MKT, opened.yesPool, opened.noPool, opened.bidCount, opened.openingsRoot);
      await expect(
        book.openMarketFromTee(data, ACTION_ID, TAG, 0, await signedResult(node, chainId, data, 0)),
      ).to.be.revertedWithCustomError(book, "TeeReportedFailure");
    });

    it("rejects the proxy's other result for the same action", async () => {
      // The proxy serves a second result under tag "end" carrying an internal
      // consensus payload, not the extension's. It must not verify here.
      const { book, bookAddr, node, chainId, MKT, opened } = await fixture();
      const data = encodeResult(bookAddr, MKT, opened.yesPool, opened.noPool, opened.bidCount, opened.openingsRoot);
      await expect(
        book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(node, chainId, data, 1, "end")),
      ).to.be.revertedWithCustomError(book, "BadSignature");
    });

    it("cannot re-open an already-open book", async () => {
      const { book, bookAddr, node, chainId, MKT, opened } = await fixture();
      const data = encodeResult(bookAddr, MKT, opened.yesPool, opened.noPool, opened.bidCount, opened.openingsRoot);
      await book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(node, chainId, data));
      await expect(
        book.openMarketFromTee(data, ACTION_ID, TAG, 1, await signedResult(node, chainId, data)),
      ).to.be.revertedWithCustomError(book, "AlreadyOpened");
    });
  });

  describe("configuration", () => {
    it("refuses the path entirely when no machine is registered", async () => {
      const [admin, alice] = await ethers.getSigners();
      const enclave = enclaveKeypair();
      const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
      const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
      const market = await (
        await ethers.getContractFactory("MolfiMarket")
      ).deploy(await oracle.getAddress());
      const book = await (
        await ethers.getContractFactory("SealedBidBook")
      ).deploy(await token.getAddress(), await market.getAddress(), Wallet.createRandom().address, admin.address);
      // teeMachine deliberately left unset — an unconfigured deployment must not
      // fall through to accepting whatever recovers from address(0).
      await expect(
        book.openMarketFromTee("0x", ACTION_ID, TAG, 1, `0x${"11".repeat(65)}`),
      ).to.be.revertedWithCustomError(book, "TeeMachineNotSet");
      expect(enclave.publicKey).to.match(/^0x0[23]/);
      expect(alice.address).to.be.a("string");
    });

    it("only admin may point the book at a machine", async () => {
      const { book, alice, node } = await fixture();
      await expect(book.connect(alice).setTeeMachine(node.address)).to.be.revertedWithCustomError(
        book,
        "NotAdmin",
      );
    });
  });
});
