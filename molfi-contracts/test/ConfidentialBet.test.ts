import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const XRP_USD = "0x015852502f55534400000000000000000000000000";
const id = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const fxrp = (n: string) => ethers.parseUnits(n, 6);
const usd = (n: string) => ethers.parseUnits(n, 18);

const DAY = 86_400;
/** 1 FXRP per note — uniform by design so stake size leaks nothing. */
// Ascending tiers. DENOM stays as the tier-0 alias so the existing
// expectations keep reading naturally.
const DENOMS = [fxrp("1"), fxrp("10"), fxrp("100")];
const DENOM = DENOMS[0];
const TIER0 = 0;

const A: [bigint, bigint] = [1n, 2n];
const B: [[bigint, bigint], [bigint, bigint]] = [
  [3n, 4n],
  [5n, 6n],
];
const C: [bigint, bigint] = [7n, 8n];

const ROOT = 987654321n;

async function deploy() {
  const [admin, alice, bob] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
  const verifier = await (await ethers.getContractFactory("MockVerifier")).deploy();
  const market = await (
    await ethers.getContractFactory("MolfiMarket")
  ).deploy(await oracle.getAddress());
  const cbet = await (
    await ethers.getContractFactory("ConfidentialBet")
  ).deploy(
    await token.getAddress(),
    await verifier.getAddress(),
    await market.getAddress(),
    DENOMS,
  );

  for (const s of [alice, bob]) {
    await token.mintUnits(s.address, 1_000n);
    await token.connect(s).approve(await cbet.getAddress(), ethers.MaxUint256);
  }
  // Seed the pool so 2x claims can be paid.
  await token.mintUnits(await cbet.getAddress(), 1_000n);

  const close = (await time.latest()) + DAY;
  const MKT = id("xrp-conf");
  await market.createPriceMarket(
    MKT, "XRP >= $3?", close, XRP_USD, usd("3"), 0, DAY * 2,
  );

  const settle = async (price: string) => {
    await time.increaseTo(close + 1);
    await oracle.setPrice(XRP_USD, usd(price));
    await market.resolveFromOracle(MKT);
  };

  return { admin, alice, bob, token, oracle, verifier, market, cbet, MKT, close, settle };
}

describe("ConfidentialBet — hidden-side notes in FXRP", () => {
  describe("commit", () => {
    it("escrows exactly the fixed denomination and records the leaf", async () => {
      const { cbet, token, alice, MKT } = await deploy();
      const before = await token.balanceOf(alice.address);

      await cbet.connect(alice).commit(MKT, TIER0, 1111n);

      expect(await token.balanceOf(alice.address)).to.equal(before - DENOM);
      expect(await cbet.commitmentCount()).to.equal(1);
      expect(await cbet.commitments(0)).to.equal(1111n);
    });

    it("assigns increasing leaf indices", async () => {
      const { cbet, alice, bob, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.connect(bob).commit(MKT, TIER0, 2n);
      await cbet.connect(alice).commit(MKT, TIER0, 3n);

      expect(await cbet.commitmentCount()).to.equal(3);
      expect(await cbet.allCommitments()).to.deep.equal([1n, 2n, 3n]);
    });

    it("rejects a duplicate commitment (it would be unclaimable)", async () => {
      const { cbet, alice, bob, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 555n);
      // bob's funds would be taken for a note whose nullifier alice can spend.
      await expect(
        cbet.connect(bob).commit(MKT, TIER0, 555n),
      ).to.be.revertedWithCustomError(cbet, "DuplicateCommitment");
    });

    it("takes the same amount regardless of caller — size leaks nothing", async () => {
      const { cbet, token, alice, bob, MKT } = await deploy();
      const a0 = await token.balanceOf(alice.address);
      const b0 = await token.balanceOf(bob.address);
      await cbet.connect(alice).commit(MKT, TIER0, 10n);
      await cbet.connect(bob).commit(MKT, TIER0, 20n);
      expect(a0 - (await token.balanceOf(alice.address))).to.equal(DENOM);
      expect(b0 - (await token.balanceOf(bob.address))).to.equal(DENOM);
    });
  });

  describe("root registration", () => {
    it("only admin may checkpoint a root", async () => {
      const { cbet, alice, MKT } = await deploy();
      await expect(
        cbet.connect(alice).registerRoot(MKT, TIER0, ROOT),
      ).to.be.revertedWithCustomError(cbet, "NotAdmin");

      await cbet.registerRoot(MKT, TIER0, ROOT);
      expect(await cbet.knownRoot(MKT, TIER0, ROOT)).to.equal(true);
    });
  });

  describe("claim", () => {
    it("pays 2x the denomination on a valid winning proof", async () => {
      const { cbet, token, alice, settle, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.registerRoot(MKT, TIER0, ROOT);
      await settle("3.42");

      const before = await token.balanceOf(alice.address);
      await cbet.connect(alice).claim(
        id("xrp-conf"), TIER0, A, B, C, ROOT, 4242n, alice.address,
      );

      expect(await token.balanceOf(alice.address)).to.equal(before + DENOM * 2n);
      expect(await cbet.nullifierUsed(4242n)).to.equal(true);
    });

    it("injects the RESOLVED winner as the outcome signal, not the caller's claim", async () => {
      const { cbet, verifier, alice, oracle, market, settle, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.registerRoot(MKT, TIER0, ROOT);
      await settle("2.10"); // price < 3 → NO wins (outcome 1)

      expect(await market.winningOutcome(id("xrp-conf"))).to.equal(1n);

      // Arm the verifier to accept ONLY the signal for (market, tier, NO). The
      // contract no longer passes a bare 0/1 — it passes the bound signal, so
      // this simultaneously proves the winner is injected AND that the market
      // and tier are folded into it.
      await verifier.expectOutcome(await cbet.sideSignal(MKT, TIER0, 1n));
      await expect(
        cbet.connect(alice).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 1n, alice.address),
      ).to.not.be.reverted;

      // And a note proving the LOSING side cannot pass.
      await verifier.expectOutcome(await cbet.sideSignal(MKT, TIER0, 0n));
      await expect(
        cbet.connect(alice).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 2n, alice.address),
      ).to.be.revertedWithCustomError(cbet, "BadProof");
    });

    it("binds the recipient into the proof so a claim can't be re-pointed", async () => {
      const { cbet, verifier, alice, bob, settle, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.registerRoot(MKT, TIER0, ROOT);
      await settle("3.42");

      // Proof was minted for alice.
      await verifier.expectRecipient(alice.address);
      // A front-runner replaying it toward bob fails.
      await expect(
        cbet.connect(bob).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 9n, bob.address),
      ).to.be.revertedWithCustomError(cbet, "BadProof");
      // alice's own claim succeeds.
      await expect(
        cbet.connect(bob).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 9n, alice.address),
      ).to.not.be.reverted;
    });

    it("rejects a replayed nullifier", async () => {
      const { cbet, alice, settle, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.registerRoot(MKT, TIER0, ROOT);
      await settle("3.42");

      await cbet.connect(alice).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 77n, alice.address);
      await expect(
        cbet.connect(alice).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 77n, alice.address),
      ).to.be.revertedWithCustomError(cbet, "NullifierSpent");
    });

    it("rejects an unregistered root", async () => {
      const { cbet, alice, settle, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await settle("3.42");
      await expect(
        cbet.connect(alice).claim(id("xrp-conf"), TIER0, A, B, C, 123n, 1n, alice.address),
      ).to.be.revertedWithCustomError(cbet, "UnknownRoot");
    });

    it("rejects a claim before the market resolves", async () => {
      const { cbet, alice, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.registerRoot(MKT, TIER0, ROOT);
      await expect(
        cbet.connect(alice).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 1n, alice.address),
      ).to.be.revertedWithCustomError(cbet, "NotResolved");
    });

    it("rejects an invalid proof without burning the nullifier", async () => {
      const { cbet, verifier, alice, settle, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.registerRoot(MKT, TIER0, ROOT);
      await settle("3.42");
      await verifier.setResult(false);

      await expect(
        cbet.connect(alice).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 55n, alice.address),
      ).to.be.revertedWithCustomError(cbet, "BadProof");
      expect(await cbet.nullifierUsed(55n)).to.equal(false);
    });

    it("rejects a zero recipient", async () => {
      const { cbet, alice, settle, MKT } = await deploy();
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.registerRoot(MKT, TIER0, ROOT);
      await settle("3.42");
      await expect(
        cbet.connect(alice).claim(id("xrp-conf"), TIER0, A, B, C, ROOT, 1n, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(cbet, "ZeroAddress");
    });

    it("fails loudly when the pool cannot cover the payout", async () => {
      const [, alice] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
      const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
      const verifier = await (await ethers.getContractFactory("MockVerifier")).deploy();
      const market = await (
        await ethers.getContractFactory("MolfiMarket")
      ).deploy(await oracle.getAddress());
      const cbet = await (
        await ethers.getContractFactory("ConfidentialBet")
      ).deploy(
        await token.getAddress(),
        await verifier.getAddress(),
        await market.getAddress(),
        DENOMS,
      );

      await token.mintUnits(alice.address, 10n);
      await token.connect(alice).approve(await cbet.getAddress(), ethers.MaxUint256);

      const close = (await time.latest()) + DAY;
      const MKT = id("poor");
      await market.createPriceMarket(MKT, "q", close, XRP_USD, usd("3"), 0, DAY * 2);

      // Only one denom in the pool, but a claim needs 2x.
      await cbet.connect(alice).commit(MKT, TIER0, 1n);
      await cbet.registerRoot(MKT, TIER0, ROOT);
      await time.increaseTo(close + 1);
      await oracle.setPrice(XRP_USD, usd("4"));
      await market.resolveFromOracle(MKT);

      await expect(
        cbet.connect(alice).claim(MKT, TIER0, A, B, C, ROOT, 1n, alice.address),
      ).to.be.revertedWithCustomError(cbet, "InsufficientPool");
    });
  });

  describe("poolStatus", () => {
    it("reports how many claims the pool can cover", async () => {
      const { cbet, MKT } = await deploy();
      const s = await cbet.poolStatus(TIER0);
      // Seeded with 1000 FXRP; each claim costs 2 → 500 claims.
      expect(s.balance).to.equal(fxrp("1000"));
      expect(s.claimsCovered).to.equal(500n);
    });
  });

  describe("constructor guards", () => {
    it("rejects a zero denomination", async () => {
      const [, ] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
      const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
      const verifier = await (await ethers.getContractFactory("MockVerifier")).deploy();
      const market = await (
        await ethers.getContractFactory("MolfiMarket")
      ).deploy(await oracle.getAddress());
      const F = await ethers.getContractFactory("ConfidentialBet");

      await expect(
        F.deploy(
          await token.getAddress(),
          await verifier.getAddress(),
          await market.getAddress(),
          [0n],
        ),
      ).to.be.revertedWithCustomError(F, "ZeroDenom");
    });
  });
});

describe("ConfidentialBet — cross-market claim regression", () => {
  it("REJECTS a note claimed against a market it was not registered for", async () => {
    // The circuit's public signals carry no market id. With one global root
    // set, a note backing the LOSING side of market A verifies against market B
    // whose winner happens to match. Roots are scoped per market to stop that.
    const { cbet, market, oracle, alice, MKT } = await deploy();
    await cbet.connect(alice).commit(MKT, TIER0, 1n);

    // Root is checkpointed for MKT only.
    await cbet.registerRoot(MKT, TIER0, ROOT);

    // A second market that resolves the other way.
    const OTHER = id("other-market");
    const close2 = (await time.latest()) + DAY;
    await market.createPriceMarket(
      OTHER, "other", close2, XRP_USD, usd("3"), 0, DAY * 2,
    );
    await time.increaseTo(close2 + 1);
    await oracle.setPrice(XRP_USD, usd("4"));
    await market.resolveFromOracle(OTHER);

    await expect(
      cbet.connect(alice).claim(OTHER, TIER0, A, B, C, ROOT, 1n, alice.address),
    ).to.be.revertedWithCustomError(cbet, "UnknownRoot");
  });

  it("accepts the same root for the market it WAS registered for", async () => {
    const { cbet, alice, MKT, settle } = await deploy();
    await cbet.connect(alice).commit(MKT, TIER0, 1n);
    await cbet.registerRoot(MKT, TIER0, ROOT);
    await settle("3.42");
    await expect(
      cbet.connect(alice).claim(MKT, TIER0, A, B, C, ROOT, 1n, alice.address),
    ).to.not.be.reverted;
  });
});

describe("ConfidentialBet — denomination tiers", () => {
  it("charges the tier's stake and pays 2x THAT tier", async () => {
    const { cbet, token, alice, settle, MKT } = await deploy();
    const before = await token.balanceOf(alice.address);

    // Tier 1 = 10 FXRP.
    await cbet.connect(alice).commit(MKT, 1, 4711n);
    expect(before - (await token.balanceOf(alice.address))).to.equal(DENOMS[1]);
    expect(await cbet.committedByTier(1)).to.equal(DENOMS[1]);

    await cbet.registerRoot(MKT, 1, ROOT);
    await settle("3.50"); // YES wins
    await cbet.connect(alice).claim(MKT, 1, A, B, C, ROOT, 8181n, alice.address);

    // staked 10, paid 20 → net +10 against the opening balance.
    expect(await token.balanceOf(alice.address)).to.equal(before + DENOMS[1]);
  });

  it("REJECTS claiming a cheap note at an expensive tier", async () => {
    // The theft this binding exists to stop: commit 1 FXRP, claim 200.
    const { cbet, verifier, alice, settle, MKT } = await deploy();
    await cbet.connect(alice).commit(MKT, TIER0, 1n); // 1 FXRP
    await settle("3.50");

    // Operator checkpoints the root for the tier it was actually committed to.
    await cbet.registerRoot(MKT, TIER0, ROOT);

    // Claiming at tier 2 fails on the root registry first…
    await expect(
      cbet.connect(alice).claim(MKT, 2, A, B, C, ROOT, 1n, alice.address),
    ).to.be.revertedWithCustomError(cbet, "UnknownRoot");

    // …and even if an operator mistakenly registered the same root for tier 2,
    // the proof still cannot verify, because the note's leaf commits to tier 0's
    // signal and the contract injects tier 2's.
    await cbet.registerRoot(MKT, 2, ROOT);
    await verifier.expectOutcome(await cbet.sideSignal(MKT, TIER0, 0n));
    await expect(
      cbet.connect(alice).claim(MKT, 2, A, B, C, ROOT, 1n, alice.address),
    ).to.be.revertedWithCustomError(cbet, "BadProof");
  });

  it("rejects an out-of-range tier", async () => {
    const { cbet, alice, MKT } = await deploy();
    await expect(
      cbet.connect(alice).commit(MKT, 99, 1n),
    ).to.be.revertedWithCustomError(cbet, "BadTier");
  });

  it("requires denominations to ascend, so tiers are distinct pools", async () => {
    const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
    const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
    const verifier = await (await ethers.getContractFactory("MockVerifier")).deploy();
    const market = await (
      await ethers.getContractFactory("MolfiMarket")
    ).deploy(await oracle.getAddress());
    const F = await ethers.getContractFactory("ConfidentialBet");
    for (const bad of [[fxrp("10"), fxrp("1")], [fxrp("5"), fxrp("5")]]) {
      await expect(
        F.deploy(
          await token.getAddress(),
          await verifier.getAddress(),
          await market.getAddress(),
          bad,
        ),
      ).to.be.revertedWithCustomError(F, "DenomsNotAscending");
    }
  });

  it("REJECTS a commit after the market has closed", async () => {
    // Otherwise the settled price is readable and a confidential bet becomes a
    // way to buy a certain win — the same hole that was closed in the escrow.
    const { cbet, alice, MKT, close } = await deploy();
    await time.increaseTo(close + 1);
    await expect(
      cbet.connect(alice).commit(MKT, TIER0, 1n),
    ).to.be.revertedWithCustomError(cbet, "MarketClosed");
  });
});
