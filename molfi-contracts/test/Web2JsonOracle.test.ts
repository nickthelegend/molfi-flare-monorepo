import { expect } from "chai";
import { ethers } from "hardhat";
import { AbiCoder, keccak256 } from "ethers";

/**
 * Web2JsonOracle — everything that does not need Flare's ContractRegistry.
 *
 * `verifyWeb2Json` goes through `ContractRegistry`, a library with a hardcoded
 * address that has no code on a bare Hardhat network, so the proof-verification
 * branch is exercised live against Coston2 instead
 * (scripts/web2json-live.ts). That split matches how this repo already treats
 * FtsoOracle: market logic in memory, the Flare adapter against the real thing.
 *
 * What IS testable here is the part that makes the proof mean something — the
 * request binding, the scaling, and the refusal to serve a value nobody has
 * posted yet.
 */
const abi = AbiCoder.defaultAbiCoder();

/** Same tuple shape as IWeb2Json.RequestBody. */
const REQUEST_BODY_TYPE =
  "tuple(string url,string httpMethod,string headers,string queryParams,string body,string postProcessJq,string abiSignature)";

const REQUEST = {
  url: "https://api.frankfurter.app/latest",
  httpMethod: "GET",
  headers: "{}",
  queryParams: '{"base":"USD","symbols":"EUR"}',
  body: "{}",
  postProcessJq: "{value: (.rates.EUR*1000000 | round)}",
  abiSignature:
    '{"components":[{"internalType":"int256","name":"value","type":"int256"}],"name":"dto","type":"tuple"}',
};

const asTuple = (r: typeof REQUEST) => [
  r.url, r.httpMethod, r.headers, r.queryParams, r.body, r.postProcessJq, r.abiSignature,
];

// bytes21: category byte 0x02 (Web2) + UTF-8 name + zero padding, mirroring
// FTSO's 0x01 crypto ids so the two can never collide.
const FEED = "0x02455552555344" + "00".repeat(14);
const FTSO_FEED = "0x015852502f55534400000000000000000000000000"; // XRP/USD, an FTSO id

describe("Web2JsonOracle", () => {
  async function deploy() {
    const [admin, stranger] = await ethers.getSigners();
    const fallback = await (await ethers.getContractFactory("MockOracle")).deploy();
    const oracle = await (
      await ethers.getContractFactory("Web2JsonOracle")
    ).deploy(await fallback.getAddress());
    return { admin, stranger, fallback, oracle };
  }

  describe("the request binding", () => {
    it("hashes a request body the same way off-chain code can", async () => {
      const { oracle } = await deploy();
      // The pipeline has to derive this binding itself before the feed exists.
      // If the two encodings ever disagreed, registration would silently pin a
      // hash no real proof could ever match, and the feed would be dead on
      // arrival with no error until settlement.
      const mine = keccak256(abi.encode([REQUEST_BODY_TYPE], [asTuple(REQUEST)]));
      expect(await oracle.requestHashOf(asTuple(REQUEST))).to.equal(mine);
    });

    it("gives a different hash for a different jq filter", async () => {
      const { oracle } = await deploy();
      // The jq transform decides what number comes out. Two requests that hit
      // the same URL but shape the answer differently must not be
      // interchangeable — otherwise a feed could be settled with an attestation
      // of, say, the inverse rate.
      const tampered = { ...REQUEST, postProcessJq: "{value: (.rates.EUR*1000 | round)}" };
      expect(await oracle.requestHashOf(asTuple(tampered))).to.not.equal(
        await oracle.requestHashOf(asTuple(REQUEST)),
      );
    });

    it("gives a different hash for a different URL", async () => {
      const { oracle } = await deploy();
      const elsewhere = { ...REQUEST, url: "https://evil.example/latest" };
      expect(await oracle.requestHashOf(asTuple(elsewhere))).to.not.equal(
        await oracle.requestHashOf(asTuple(REQUEST)),
      );
    });
  });

  describe("registration", () => {
    it("registers a feed and lists it", async () => {
      const { oracle } = await deploy();
      const hash = await oracle.requestHashOf(asTuple(REQUEST));
      await expect(oracle.registerFeed(FEED, hash, "EUR/USD (ECB via FDC)", 6))
        .to.emit(oracle, "FeedRegistered")
        .withArgs(FEED, hash, "EUR/USD (ECB via FDC)", 6);

      const f = await oracle.feedOf(FEED);
      expect(f.requestHash).to.equal(hash);
      expect(f.valueDecimals).to.equal(6);
      expect(await oracle.feedCount()).to.equal(1);
    });

    it("is admin-only", async () => {
      const { oracle, stranger } = await deploy();
      const hash = await oracle.requestHashOf(asTuple(REQUEST));
      await expect(
        oracle.connect(stranger).registerFeed(FEED, hash, "x", 6),
      ).to.be.revertedWithCustomError(oracle, "NotAdmin");
    });

    it("REFUSES to rebind a live feed", async () => {
      // The whole point is that a market's settlement question is fixed once
      // people can stake on it. Allowing a rebind would hand the admin key the
      // discretion this contract exists to remove.
      const { oracle } = await deploy();
      const hash = await oracle.requestHashOf(asTuple(REQUEST));
      await oracle.registerFeed(FEED, hash, "EUR/USD", 6);
      const other = await oracle.requestHashOf(asTuple({ ...REQUEST, url: "https://x/" }));
      await expect(oracle.registerFeed(FEED, other, "EUR/USD", 6)).to.be.revertedWithCustomError(
        oracle,
        "FeedExists",
      );
    });

    it("rejects decimals it cannot scale up to 18", async () => {
      const { oracle } = await deploy();
      const hash = await oracle.requestHashOf(asTuple(REQUEST));
      await expect(oracle.registerFeed(FEED, hash, "x", 19)).to.be.revertedWithCustomError(
        oracle,
        "BadDecimals",
      );
    });

    it("rejects a zero feed id or an empty binding", async () => {
      const { oracle } = await deploy();
      const hash = await oracle.requestHashOf(asTuple(REQUEST));
      await expect(
        oracle.registerFeed("0x" + "00".repeat(21), hash, "x", 6),
      ).to.be.revertedWithCustomError(oracle, "UnknownFeed");
      await expect(
        oracle.registerFeed(FEED, "0x" + "00".repeat(32), "x", 6),
      ).to.be.revertedWithCustomError(oracle, "InvalidProof");
    });
  });

  describe("serving values", () => {
    it("a registered but never-attested feed reverts instead of reading zero", async () => {
      // Returning 0 here would resolve every market on this feed to the same
      // side, silently.
      const { oracle } = await deploy();
      await oracle.registerFeed(FEED, await oracle.requestHashOf(asTuple(REQUEST)), "x", 6);
      await expect(oracle.getPrice(FEED)).to.be.revertedWithCustomError(oracle, "NoObservation");
      await expect(oracle.getFreshPrice(FEED, 3600)).to.be.revertedWithCustomError(
        oracle,
        "NoObservation",
      );
    });

    it("delegates an unknown feed to the FTSO adapter, so it is a superset not a replacement", async () => {
      // A venue pointed at this oracle must settle every FTSO market exactly as
      // it did before — otherwise adopting it is a regression, not an upgrade.
      const { oracle, fallback } = await deploy();
      await fallback.setPrice(FTSO_FEED, ethers.parseUnits("2.5", 18));

      const [price] = await oracle.getPrice(FTSO_FEED);
      expect(price).to.equal(ethers.parseUnits("2.5", 18));

      const [fresh] = await oracle.getFreshPrice(FTSO_FEED, 3600);
      expect(fresh).to.equal(ethers.parseUnits("2.5", 18));
    });

    it("propagates the fallback's staleness revert rather than masking it", async () => {
      const { oracle, fallback } = await deploy();
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await fallback.setPriceAt(FTSO_FEED, ethers.parseUnits("2.5", 18), now - 10_000);
      await expect(oracle.getFreshPrice(FTSO_FEED, 60)).to.be.reverted;
    });

    it("reverts on an unknown feed when there is no fallback configured", async () => {
      const [admin] = await ethers.getSigners();
      const solo = await (
        await ethers.getContractFactory("Web2JsonOracle")
      ).deploy(ethers.ZeroAddress);
      expect(await solo.admin()).to.equal(admin.address);
      await expect(solo.getPrice(FTSO_FEED)).to.be.revertedWithCustomError(solo, "UnknownFeed");
    });
  });

  describe("admin", () => {
    it("transfers", async () => {
      const { oracle, admin, stranger } = await deploy();
      await expect(oracle.transferAdmin(stranger.address))
        .to.emit(oracle, "AdminTransferred")
        .withArgs(admin.address, stranger.address);
      expect(await oracle.admin()).to.equal(stranger.address);
    });

    it("cannot be transferred to zero", async () => {
      const { oracle } = await deploy();
      await expect(oracle.transferAdmin(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        oracle,
        "ZeroAddress",
      );
    });
  });
});
