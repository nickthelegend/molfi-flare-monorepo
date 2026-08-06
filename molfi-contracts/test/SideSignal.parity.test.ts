import { expect } from "chai";
import { ethers } from "hardhat";
import { id } from "ethers";
// @ts-expect-error — plain-JS backend module, no types
import { sideSignal } from "../../molfi-backend/zk.js";

/**
 * The note builder (JS) and the verifier's input (Solidity) must derive the
 * `outcome` public signal identically.
 *
 * If they ever disagree, every claim fails with BadProof and no obvious cause —
 * the proof is valid, it just commits to a different leaf. Two copies of an
 * encoding drift, so pin them against each other rather than trusting both.
 */
describe("sideSignal — JS/Solidity parity", () => {
  it("agrees across markets, tiers and sides", async () => {
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
      [1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n],
    );

    for (const mid of [id("m-a"), id("m-b")]) {
      for (const tier of [0, 1, 2, 3]) {
        for (const side of [0, 1]) {
          expect(sideSignal(mid, tier, side)).to.equal(
            (await cbet.sideSignal(mid, tier, side)).toString(),
            `mismatch at market=${mid} tier=${tier} side=${side}`,
          );
        }
      }
    }
  });

  it("gives a different signal per tier — that is what binds the stake size", async () => {
    const mid = id("m-a");
    const signals = [0, 1, 2, 3].map((t) => sideSignal(mid, t, 0));
    expect(new Set(signals).size).to.equal(4);
  });
});
