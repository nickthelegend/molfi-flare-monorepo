import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const XRP_USD = "0x015852502f55534400000000000000000000000000";
const id = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

/** FXRP carries 6 decimals — XRP is denominated in drops. */
const fxrp = (n: string) => ethers.parseUnits(n, 6);
const usd = (n: string) => ethers.parseUnits(n, 18);

const YES = 0;
const NO = 1;
const DAY = 86_400;

// Dummy Groth16 calldata — MockVerifier ignores the points, so only the public
// signals matter for the state-machine tests.
const A: [bigint, bigint] = [1n, 2n];
const B: [[bigint, bigint], [bigint, bigint]] = [
  [3n, 4n],
  [5n, 6n],
];
const C: [bigint, bigint] = [7n, 8n];
const pub = (nullifier: bigint): [bigint, bigint, bigint, bigint] => [
  111n,
  nullifier,
  0n,
  0n,
];

async function deploy() {
  const [admin, alice, bob, carol, vault] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
  const verifier = await (await ethers.getContractFactory("MockVerifier")).deploy();
  const market = await (
    await ethers.getContractFactory("MolfiMarket")
  ).deploy(await oracle.getAddress());
  const escrow = await (
    await ethers.getContractFactory("PredictEscrow")
  ).deploy(
    await token.getAddress(),
    await verifier.getAddress(),
    await market.getAddress(),
    vault.address,
  );

  // Fund and approve the players.
  for (const s of [alice, bob, carol]) {
    await token.mintUnits(s.address, 10_000n);
    await token.connect(s).approve(await escrow.getAddress(), ethers.MaxUint256);
  }

  const close = (await time.latest()) + DAY;
  const MKT = id("xrp-market");
  await market.createPriceMarket(
    MKT,
    "XRP >= $3 at close?",
    close,
    XRP_USD,
    usd("3"),
    0, // GTE
    DAY * 2,
  );

  const settle = async (price: string) => {
    await time.increaseTo(close + 1);
    await oracle.setPrice(XRP_USD, usd(price));
    await market.resolveFromOracle(MKT);
  };

  return {
    admin, alice, bob, carol, vault,
    token, oracle, verifier, market, escrow,
    MKT, close, settle,
  };
}

describe("PredictEscrow — pari-mutuel in FXRP", () => {
  describe("betting", () => {
    it("escrows FXRP and records the position", async () => {
      const { escrow, token, alice, MKT } = await deploy();
      const before = await token.balanceOf(alice.address);

      await escrow.connect(alice).bet(MKT, YES, fxrp("100"));

      expect(await token.balanceOf(alice.address)).to.equal(before - fxrp("100"));
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(fxrp("100"));
      expect(await escrow.position(MKT, YES, alice.address)).to.equal(fxrp("100"));
      expect(await escrow.pool(MKT, YES)).to.equal(fxrp("100"));
      expect(await escrow.total(MKT)).to.equal(fxrp("100"));
    });

    it("accumulates repeat bets from the same address", async () => {
      const { escrow, alice, MKT } = await deploy();
      await escrow.connect(alice).bet(MKT, YES, fxrp("50"));
      await escrow.connect(alice).bet(MKT, YES, fxrp("70"));
      expect(await escrow.position(MKT, YES, alice.address)).to.equal(fxrp("120"));
    });

    it("rejects a zero stake", async () => {
      const { escrow, alice, MKT } = await deploy();
      await expect(
        escrow.connect(alice).bet(MKT, YES, 0),
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("rejects a non-binary outcome", async () => {
      const { escrow, alice, MKT } = await deploy();
      await expect(
        escrow.connect(alice).bet(MKT, 2, fxrp("10")),
      ).to.be.revertedWithCustomError(escrow, "BadOutcome");
    });

    it("rejects a bet once the market has resolved", async () => {
      const { escrow, alice, MKT, settle } = await deploy();
      await settle("4");
      await expect(
        escrow.connect(alice).bet(MKT, YES, fxrp("10")),
      ).to.be.revertedWithCustomError(escrow, "MarketClosed");
    });
  });

  describe("pari-mutuel payout", () => {
    it("pays the winner the whole pot pro-rata, minus the 2% fee", async () => {
      const { escrow, token, alice, bob, vault, MKT, settle } = await deploy();

      // 100 YES vs 300 NO → pot 400, YES wins, alice is the only winner.
      await escrow.connect(alice).bet(MKT, YES, fxrp("100"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("300"));
      await settle("3.42"); // >= 3 → YES

      const before = await token.balanceOf(alice.address);
      await escrow.redeem(MKT, alice.address);

      // gross = 100 * 400 / 100 = 400 ; fee = 8 ; net = 392
      expect(await token.balanceOf(alice.address)).to.equal(before + fxrp("392"));
      expect(await token.balanceOf(vault.address)).to.equal(fxrp("8"));
    });

    it("splits the pot between multiple winners in proportion to stake", async () => {
      const { escrow, token, alice, bob, carol, MKT, settle } = await deploy();

      // alice 100 YES, carol 300 YES, bob 400 NO → pot 800, YES pool 400.
      await escrow.connect(alice).bet(MKT, YES, fxrp("100"));
      await escrow.connect(carol).bet(MKT, YES, fxrp("300"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("400"));
      await settle("3.42");

      const aBefore = await token.balanceOf(alice.address);
      const cBefore = await token.balanceOf(carol.address);
      await escrow.redeem(MKT, alice.address);
      await escrow.redeem(MKT, carol.address);

      // alice: 100*800/400 = 200, fee 4 → 196
      // carol: 300*800/400 = 600, fee 12 → 588
      expect(await token.balanceOf(alice.address)).to.equal(aBefore + fxrp("196"));
      expect(await token.balanceOf(carol.address)).to.equal(cBefore + fxrp("588"));
    });

    it("previewPayout matches what redeem actually pays", async () => {
      const { escrow, token, alice, bob, MKT, settle } = await deploy();
      await escrow.connect(alice).bet(MKT, YES, fxrp("100"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("300"));

      const preview = await escrow.previewPayout(MKT, alice.address, YES);
      await settle("3.42");

      const before = await token.balanceOf(alice.address);
      await escrow.redeem(MKT, alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(before + preview.net);
    });

    it("refuses a loser's redemption", async () => {
      const { escrow, alice, bob, MKT, settle } = await deploy();
      await escrow.connect(alice).bet(MKT, YES, fxrp("100"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("300"));
      await settle("3.42"); // YES wins

      await expect(
        escrow.redeem(MKT, bob.address),
      ).to.be.revertedWithCustomError(escrow, "NoWinningPosition");
    });

    it("refuses to redeem twice", async () => {
      const { escrow, alice, bob, MKT, settle } = await deploy();
      await escrow.connect(alice).bet(MKT, YES, fxrp("100"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("300"));
      await settle("3.42");

      await escrow.redeem(MKT, alice.address);
      await expect(
        escrow.redeem(MKT, alice.address),
      ).to.be.revertedWithCustomError(escrow, "AlreadyRedeemed");
    });

    it("refuses to redeem before resolution", async () => {
      const { escrow, alice, MKT } = await deploy();
      await escrow.connect(alice).bet(MKT, YES, fxrp("100"));
      await expect(
        escrow.redeem(MKT, alice.address),
      ).to.be.revertedWithCustomError(escrow, "NotResolved");
    });

    it("lets a third party settle for a bettor, paying the bettor", async () => {
      const { escrow, token, alice, bob, carol, MKT, settle } = await deploy();
      await escrow.connect(alice).bet(MKT, YES, fxrp("100"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("100"));
      await settle("3.42");

      const aBefore = await token.balanceOf(alice.address);
      const cBefore = await token.balanceOf(carol.address);
      // carol pays the gas, alice gets the money.
      await escrow.connect(carol).redeem(MKT, alice.address);

      expect(await token.balanceOf(alice.address)).to.be.gt(aBefore);
      expect(await token.balanceOf(carol.address)).to.equal(cBefore);
    });
  });

  describe("degenerate market (nobody backed the winner)", () => {
    it("refunds every stake at par, charging no fee", async () => {
      const { escrow, token, alice, bob, vault, MKT, settle } = await deploy();

      // Everyone is on NO; YES wins → the YES pool is empty.
      await escrow.connect(alice).bet(MKT, NO, fxrp("100"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("250"));
      await settle("3.42"); // YES wins, YES pool == 0

      const aBefore = await token.balanceOf(alice.address);
      const bBefore = await token.balanceOf(bob.address);
      await escrow.redeem(MKT, alice.address);
      await escrow.redeem(MKT, bob.address);

      expect(await token.balanceOf(alice.address)).to.equal(aBefore + fxrp("100"));
      expect(await token.balanceOf(bob.address)).to.equal(bBefore + fxrp("250"));
      // No fee taken on a refund.
      expect(await token.balanceOf(vault.address)).to.equal(0n);
      // Escrow fully drained — nothing stranded.
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
    });

    it("still rejects someone who never staked", async () => {
      const { escrow, alice, carol, MKT, settle } = await deploy();
      await escrow.connect(alice).bet(MKT, NO, fxrp("100"));
      await settle("3.42");

      await expect(
        escrow.redeem(MKT, carol.address),
      ).to.be.revertedWithCustomError(escrow, "NoWinningPosition");
    });
  });

  describe("ZK-gated betting", () => {
    it("accepts a bet carrying a valid single-use proof", async () => {
      const { escrow, alice, MKT } = await deploy();
      await escrow.connect(alice).betZk(MKT, YES, fxrp("100"), A, B, C, pub(42n));
      expect(await escrow.position(MKT, YES, alice.address)).to.equal(fxrp("100"));
      expect(await escrow.nullifierUsed(42n)).to.equal(true);
    });

    it("rejects a replayed nullifier", async () => {
      const { escrow, alice, MKT } = await deploy();
      await escrow.connect(alice).betZk(MKT, YES, fxrp("10"), A, B, C, pub(7n));
      await expect(
        escrow.connect(alice).betZk(MKT, YES, fxrp("10"), A, B, C, pub(7n)),
      ).to.be.revertedWithCustomError(escrow, "NullifierSpent");
    });

    it("rejects an invalid proof and does not burn the nullifier", async () => {
      const { escrow, verifier, alice, MKT } = await deploy();
      await verifier.setResult(false);

      await expect(
        escrow.connect(alice).betZk(MKT, YES, fxrp("10"), A, B, C, pub(99n)),
      ).to.be.revertedWithCustomError(escrow, "BadProof");

      // The nullifier must remain unspent so a later valid proof still works.
      expect(await escrow.nullifierUsed(99n)).to.equal(false);
      await verifier.setResult(true);
      await escrow.connect(alice).betZk(MKT, YES, fxrp("10"), A, B, C, pub(99n));
      expect(await escrow.nullifierUsed(99n)).to.equal(true);
    });

    it("allows a NO-side ZK bet (outcome signal is not bound)", async () => {
      const { escrow, alice, MKT } = await deploy();
      // Proofs are minted with outcome=0; binding it would break NO bets.
      await escrow.connect(alice).betZk(MKT, NO, fxrp("25"), A, B, C, pub(5n));
      expect(await escrow.position(MKT, NO, alice.address)).to.equal(fxrp("25"));
    });
  });

  describe("accounting invariants", () => {
    it("never pays out more than the pot", async () => {
      const { escrow, token, alice, bob, carol, MKT, settle } = await deploy();
      await escrow.connect(alice).bet(MKT, YES, fxrp("137"));
      await escrow.connect(carol).bet(MKT, YES, fxrp("41"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("289"));
      const pot = await escrow.total(MKT);
      await settle("3.42");

      await escrow.redeem(MKT, alice.address);
      await escrow.redeem(MKT, carol.address);

      const left = await token.balanceOf(await escrow.getAddress());
      // Only dust from integer division may remain; never a deficit.
      expect(left).to.be.gte(0n);
      expect(left).to.be.lt(fxrp("0.001"));
      expect(pot).to.equal(fxrp("467"));
    });

    it("reports pools correctly", async () => {
      const { escrow, alice, bob, MKT } = await deploy();
      await escrow.connect(alice).bet(MKT, YES, fxrp("10"));
      await escrow.connect(bob).bet(MKT, NO, fxrp("30"));
      const p = await escrow.pools(MKT);
      expect(p.yesPool).to.equal(fxrp("10"));
      expect(p.noPool).to.equal(fxrp("30"));
      expect(p.totalPool).to.equal(fxrp("40"));
    });
  });
});

describe("PredictEscrow — security regressions", () => {
  it("REJECTS a bet placed after close but before resolution", async () => {
    // The settling price is public the moment close passes, and resolution is
    // permissionless — so any window between the two lets a late better read
    // the outcome and take the pot risk-free.
    const { escrow, alice, bob, MKT, close } = await deploy();
    await escrow.connect(alice).bet(MKT, YES, fxrp("100"));

    await time.increaseTo(close + 1); // closed, but nobody has resolved yet

    await expect(
      escrow.connect(bob).bet(MKT, YES, fxrp("1000")),
    ).to.be.revertedWithCustomError(escrow, "MarketClosed");
  });

  it("still accepts a bet in the final second before close", async () => {
    const { escrow, alice, MKT, close } = await deploy();
    await time.increaseTo(close - 2);
    await expect(escrow.connect(alice).bet(MKT, YES, fxrp("10"))).to.not.be.reverted;
  });

  it("REJECTS escrowing into a market that does not exist", async () => {
    // Otherwise the FXRP is stranded: no such market can ever resolve, so the
    // stake can never be redeemed.
    const { escrow, alice } = await deploy();
    const ghost = id("no-such-market");
    await expect(escrow.connect(alice).bet(ghost, YES, fxrp("10"))).to.be.reverted;
  });
});
