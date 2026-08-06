import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const XRP_USD = "0x015852502f55534400000000000000000000000000";
const FLR_USD = "0x01464c522f55534400000000000000000000000000";
const ZERO_FEED = "0x000000000000000000000000000000000000000000";

const id = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const usd = (n: string) => ethers.parseUnits(n, 18); // oracle prices are 18-dec

const OP_GTE = 0;
const OP_LT = 1;
const YES = 0n;
const NO = 1n;
const DAY = 86_400;

async function deploy() {
  const [admin, alice] = await ethers.getSigners();
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
  const market = await (
    await ethers.getContractFactory("MolfiMarket")
  ).deploy(await oracle.getAddress());
  return { admin, alice, oracle, market };
}

describe("MolfiMarket — FTSO-settled lifecycle", () => {
  describe("creation", () => {
    it("creates a basic admin-resolved market", async () => {
      const { market } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.create(id("m1"), "Will it rain?", close);

      const m = await market.getMarket(id("m1"));
      expect(m.question).to.equal("Will it rain?");
      expect(m.closeTs).to.equal(close);
      expect(m.status).to.equal(0); // Trading
      expect(await market.marketCount()).to.equal(1);
    });

    it("creates an FTSO price market carrying its feed id", async () => {
      const { market } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("xrp"),
        "XRP >= $3 ?",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        3600,
      );

      const stored = await market.marketOf(id("xrp"));
      expect(stored.feedId).to.equal(XRP_USD);
      expect(stored.threshold).to.equal(usd("3"));
      expect(stored.hasOracle).to.equal(true);
    });

    it("rejects duplicate ids, past close times, and bad ops", async () => {
      const { market } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.create(id("dup"), "q", close);

      await expect(market.create(id("dup"), "q", close)).to.be.revertedWithCustomError(
        market,
        "Exists",
      );
      await expect(
        market.create(id("past"), "q", (await time.latest()) - 1),
      ).to.be.revertedWithCustomError(market, "BadClose");
      await expect(
        market.createPriceMarket(id("op"), "q", close, XRP_USD, usd("3"), 2, 3600),
      ).to.be.revertedWithCustomError(market, "BadOp");
    });

    it("rejects a market that could never resolve (zero feed or zero staleness)", async () => {
      const { market } = await deploy();
      const close = (await time.latest()) + DAY;

      await expect(
        market.createPriceMarket(id("nofeed"), "q", close, ZERO_FEED, usd("3"), OP_GTE, 3600),
      ).to.be.revertedWithCustomError(market, "BadFeed");

      await expect(
        market.createPriceMarket(id("nostale"), "q", close, XRP_USD, usd("3"), OP_GTE, 0),
      ).to.be.revertedWithCustomError(market, "BadFeed");
    });

    it("only admin may create", async () => {
      const { market, alice } = await deploy();
      const close = (await time.latest()) + DAY;
      await expect(
        market.connect(alice).create(id("x"), "q", close),
      ).to.be.revertedWithCustomError(market, "NotAdmin");
    });
  });

  describe("FTSO settlement", () => {
    it("resolves YES when price >= threshold", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("xrp"),
        "XRP >= $3 ?",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        DAY * 2,
      );

      await time.increaseTo(close + 1);
      await oracle.setPrice(XRP_USD, usd("3.42"));
      await market.resolveFromOracle(id("xrp"));

      expect(await market.isResolved(id("xrp"))).to.equal(true);
      expect(await market.winningOutcome(id("xrp"))).to.equal(YES);
    });

    it("resolves NO when price < threshold", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("xrp"),
        "XRP >= $3 ?",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        DAY * 2,
      );

      await time.increaseTo(close + 1);
      await oracle.setPrice(XRP_USD, usd("2.10"));
      await market.resolveFromOracle(id("xrp"));

      expect(await market.winningOutcome(id("xrp"))).to.equal(NO);
    });

    it("treats price exactly at the strike as YES under GTE", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("eq"),
        "XRP >= $3 ?",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        DAY * 2,
      );

      await time.increaseTo(close + 1);
      await oracle.setPrice(XRP_USD, usd("3")); // exactly the strike
      await market.resolveFromOracle(id("eq"));

      expect(await market.winningOutcome(id("eq"))).to.equal(YES);
    });

    it("honours the LT operator", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("lt"),
        "XRP < $3 ?",
        close,
        XRP_USD,
        usd("3"),
        OP_LT,
        DAY * 2,
      );

      await time.increaseTo(close + 1);
      await oracle.setPrice(XRP_USD, usd("2.10"));
      await market.resolveFromOracle(id("lt"));

      expect(await market.winningOutcome(id("lt"))).to.equal(YES); // price < strike
    });

    it("is permissionless — anyone may settle after close", async () => {
      const { market, oracle, alice } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("perm"),
        "q",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        DAY * 2,
      );

      await time.increaseTo(close + 1);
      await oracle.setPrice(XRP_USD, usd("4"));
      await expect(market.connect(alice).resolveFromOracle(id("perm"))).to.not.be.reverted;
      expect(await market.isResolved(id("perm"))).to.equal(true);
    });

    it("refuses to settle before close", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("early"),
        "q",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        DAY * 2,
      );
      await oracle.setPrice(XRP_USD, usd("4"));

      await expect(market.resolveFromOracle(id("early"))).to.be.revertedWithCustomError(
        market,
        "NotClosed",
      );
    });

    it("refuses to settle twice", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("twice"),
        "q",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        DAY * 2,
      );

      await time.increaseTo(close + 1);
      await oracle.setPrice(XRP_USD, usd("4"));
      await market.resolveFromOracle(id("twice"));

      await expect(market.resolveFromOracle(id("twice"))).to.be.revertedWithCustomError(
        market,
        "AlreadyResolved",
      );
    });

    it("leaves the market UNRESOLVED rather than settling on a stale feed", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("stale"),
        "q",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        60, // 60s staleness bound
      );

      await time.increaseTo(close + 1);
      // Price stamped well before close — older than the bound.
      await oracle.setPriceAt(XRP_USD, usd("4"), BigInt(close - 10_000));

      await expect(market.resolveFromOracle(id("stale"))).to.be.revertedWithCustomError(
        oracle,
        "StalePrice",
      );
      // Critically, it stays open so it can settle once the feed recovers.
      expect(await market.isResolved(id("stale"))).to.equal(false);

      await oracle.setPrice(XRP_USD, usd("4"));
      await market.resolveFromOracle(id("stale"));
      expect(await market.isResolved(id("stale"))).to.equal(true);
    });

    it("refuses to settle a market that has no feed", async () => {
      const { market } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.create(id("basic"), "q", close);
      await time.increaseTo(close + 1);

      await expect(market.resolveFromOracle(id("basic"))).to.be.revertedWithCustomError(
        market,
        "Missing",
      );
    });

    it("settles independent markets on independent feeds", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("a"),
        "XRP >= $3",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        DAY * 2,
      );
      await market.createPriceMarket(
        id("b"),
        "FLR >= $1",
        close,
        FLR_USD,
        usd("1"),
        OP_GTE,
        DAY * 2,
      );

      await time.increaseTo(close + 1);
      await oracle.setPrice(XRP_USD, usd("3.5")); // YES
      await oracle.setPrice(FLR_USD, usd("0.02")); // NO
      await market.resolveFromOracle(id("a"));
      await market.resolveFromOracle(id("b"));

      expect(await market.winningOutcome(id("a"))).to.equal(YES);
      expect(await market.winningOutcome(id("b"))).to.equal(NO);
    });
  });

  describe("previewResolution", () => {
    it("reports the outcome the market would settle to, without settling it", async () => {
      const { market, oracle } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.createPriceMarket(
        id("pv"),
        "q",
        close,
        XRP_USD,
        usd("3"),
        OP_GTE,
        DAY * 2,
      );
      await oracle.setPrice(XRP_USD, usd("3.42"));

      const p = await market.previewResolution(id("pv"));
      expect(p.price).to.equal(usd("3.42"));
      expect(p.wouldBeYes).to.equal(true);
      // Still open — preview must not mutate.
      expect(await market.isResolved(id("pv"))).to.equal(false);
    });
  });

  describe("admin resolution", () => {
    it("lets admin resolve a non-price market", async () => {
      const { market } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.create(id("adm"), "q", close);
      await market.resolve(id("adm"), 1);
      expect(await market.winningOutcome(id("adm"))).to.equal(NO);
    });

    it("rejects a non-binary outcome", async () => {
      const { market } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.create(id("bad"), "q", close);
      await expect(market.resolve(id("bad"), 2)).to.be.revertedWithCustomError(
        market,
        "BadOutcome",
      );
    });

    it("blocks non-admin", async () => {
      const { market, alice } = await deploy();
      const close = (await time.latest()) + DAY;
      await market.create(id("na"), "q", close);
      await expect(
        market.connect(alice).resolve(id("na"), 0),
      ).to.be.revertedWithCustomError(market, "NotAdmin");
    });
  });

  it("reverts winningOutcome on an unresolved market", async () => {
    const { market } = await deploy();
    const close = (await time.latest()) + DAY;
    await market.create(id("open"), "q", close);
    await expect(market.winningOutcome(id("open"))).to.be.revertedWith("not resolved");
  });
});

describe("MolfiMarket — admin override is an escape hatch, not an override", () => {
  it("REFUSES an admin hand-settle of a live oracle market", async () => {
    const { market } = await deploy();
    const close = (await time.latest()) + DAY;
    await market.createPriceMarket(
      id("live"), "q", close, XRP_USD, usd("3"), OP_GTE, DAY * 2,
    );
    // Before close: admin must not be able to pick the winner at all.
    await expect(market.resolve(id("live"), 1)).to.be.revertedWithCustomError(
      market,
      "NotClosed",
    );
  });

  it("REFUSES an admin hand-settle while FTSO could still settle it", async () => {
    const { market } = await deploy();
    const close = (await time.latest()) + DAY;
    await market.createPriceMarket(
      id("recent"), "q", close, XRP_USD, usd("3"), OP_GTE, DAY * 2,
    );
    await time.increaseTo(close + 60); // closed, but well inside the delay
    await expect(market.resolve(id("recent"), 1)).to.be.revertedWithCustomError(
      market,
      "OracleSettlementAvailable",
    );
  });

  it("ALLOWS an admin hand-settle once the feed has been stuck past the delay", async () => {
    const { market } = await deploy();
    const close = (await time.latest()) + DAY;
    await market.createPriceMarket(
      id("stuck"), "q", close, XRP_USD, usd("3"), OP_GTE, DAY * 2,
    );
    await time.increaseTo(close + 24 * 3600 + 1);
    await market.resolve(id("stuck"), 1);
    expect(await market.winningOutcome(id("stuck"))).to.equal(NO);
  });

  it("still lets admin resolve a non-oracle market immediately", async () => {
    const { market } = await deploy();
    const close = (await time.latest()) + DAY;
    await market.create(id("manual"), "q", close);
    await market.resolve(id("manual"), 0);
    expect(await market.winningOutcome(id("manual"))).to.equal(YES);
  });
});
