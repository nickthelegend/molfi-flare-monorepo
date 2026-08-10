import { expect } from "chai";
import { ethers } from "hardhat";
import {
  AbiCoder, concat, getBytes, keccak256, toUtf8Bytes, Wallet, Signature,
} from "ethers";

/**
 * The TEE_ACTION_RESULT scheme, pinned against an independently-built signature.
 *
 * The point of this scheme is that Flare's tee-node signs an extension's
 * ActionResult with the node's OWN attested identity key — so a contract that
 * verifies it is trusting the registered machine rather than an address an
 * operator configured. That only holds if our reconstruction of the signed bytes
 * is exactly right; a near-miss produces a valid signature over the wrong
 * preimage and simply recovers a stranger, which looks like "wrong key" and
 * sends you hunting in the wrong place.
 *
 * So the hash is rebuilt here from the wire description — packed inner, encoded
 * outer — signed with a plain ethers wallet, and handed to the contract. If the
 * two constructions ever diverge, the recovered address is not the signer.
 */
const abi = AbiCoder.defaultAbiCoder();
const PREFIX = "0x" + Buffer.from("TEE_ACTION_RESULT", "utf8").toString("hex").padEnd(64, "0");

/** `ActionResult.Hash()` — packed, fixed-width fields. */
function resultHash(data: string, actionId: string, submissionTag: string, status: number): string {
  return keccak256(
    concat([
      keccak256(data),
      getBytes(actionId),
      keccak256(toUtf8Bytes(submissionTag)),
      Uint8Array.of(status),
    ]),
  );
}

/** The payload the node personal-signs: NOT packed, and bound to the chain. */
function payload(hash: string, chainId: bigint): string {
  return keccak256(abi.encode(["bytes32", "uint256", "bytes32"], [PREFIX, chainId, hash]));
}

describe("TeeActionResult", () => {
  async function deploy() {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const harness = await (await ethers.getContractFactory("TeeActionResultHarness")).deploy();
    const node = Wallet.createRandom();
    return { harness, node, chainId };
  }

  const DATA = "0xdeadbeefcafe";
  const ACTION_ID = `0x${"3c".repeat(32)}`;
  const TAG = "threshold";

  async function sign(node: Wallet, chainId: bigint, over = { data: DATA, actionId: ACTION_ID, tag: TAG, status: 1 }) {
    return node.signMessage(getBytes(payload(resultHash(over.data, over.actionId, over.tag, over.status), chainId)));
  }

  it("reconstructs the hash the same way off-chain code does", async () => {
    const { harness } = await deploy();
    expect(await harness.resultHash(DATA, ACTION_ID, TAG, 1)).to.equal(
      resultHash(DATA, ACTION_ID, TAG, 1),
    );
  });

  it("recovers the node that signed the result", async () => {
    const { harness, node, chainId } = await deploy();
    const sig = await sign(node, chainId);
    expect(await harness.recoverSigner(DATA, ACTION_ID, TAG, 1, sig)).to.equal(node.address);
  });

  it("accepts the raw recovery id as well as 27/28", async () => {
    // go-ethereum emits v=0/1 and ethers emits 27/28. tee-node normalises one
    // way, the reference's own extension normalises the other, and both end up
    // in front of this contract.
    const { harness, node, chainId } = await deploy();
    const sig = await sign(node, chainId);
    const raw = getBytes(sig);
    raw[64] = raw[64] - 27; // 27/28 -> 0/1
    expect(await harness.recoverSigner(DATA, ACTION_ID, TAG, 1, raw)).to.equal(node.address);
  });

  describe("what a signature is actually binding", () => {
    it("is bound to the chain — a Coston2 result cannot be replayed elsewhere", async () => {
      const { harness, node, chainId } = await deploy();
      const elsewhere = await node.signMessage(
        getBytes(payload(resultHash(DATA, ACTION_ID, TAG, 1), chainId + 1n)),
      );
      expect(await harness.recoverSigner(DATA, ACTION_ID, TAG, 1, elsewhere)).to.not.equal(
        node.address,
      );
    });

    it("is bound to the data", async () => {
      const { harness, node, chainId } = await deploy();
      const sig = await sign(node, chainId);
      expect(await harness.recoverSigner("0xdeadbeefcaff", ACTION_ID, TAG, 1, sig)).to.not.equal(
        node.address,
      );
    });

    it("is bound to the action id", async () => {
      const { harness, node, chainId } = await deploy();
      const sig = await sign(node, chainId);
      expect(
        await harness.recoverSigner(DATA, `0x${"3d".repeat(32)}`, TAG, 1, sig),
      ).to.not.equal(node.address);
    });

    it("is bound to the submission tag", async () => {
      // The proxy serves a second result for the same actionId under tag "end",
      // carrying an internal consensus payload rather than the extension's. If
      // the tag were not signed over, that one would verify too.
      const { harness, node, chainId } = await deploy();
      const sig = await sign(node, chainId);
      expect(await harness.recoverSigner(DATA, ACTION_ID, "end", 1, sig)).to.not.equal(node.address);
    });

    it("is bound to the status", async () => {
      const { harness, node, chainId } = await deploy();
      const sig = await sign(node, chainId);
      expect(await harness.recoverSigner(DATA, ACTION_ID, TAG, 0, sig)).to.not.equal(node.address);
    });
  });

  describe("signature hygiene", () => {
    it("rejects the mirrored s", async () => {
      // Every ECDSA signature has a second valid encoding. Accepting both means
      // one authorisation has two identities, which quietly breaks anything
      // that dedupes on the signature bytes.
      const { harness, node, chainId } = await deploy();
      const sig = Signature.from(await sign(node, chainId));
      const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      // Assembled byte-by-byte on purpose: ethers refuses to serialize a
      // non-canonical s at all, which is exactly the hygiene being tested —
      // so the malicious encoding has to be built by hand to test for it.
      const flipped = concat([
        sig.r,
        ethers.toBeHex(N - BigInt(sig.s), 32),
        Uint8Array.of(sig.v === 27 ? 28 : 27),
      ]);
      await expect(
        harness.recoverSigner(DATA, ACTION_ID, TAG, 1, flipped),
      ).to.be.revertedWithCustomError(harness, "MalleableSignature");
    });

    it("rejects a wrong-length signature rather than reading past it", async () => {
      const { harness } = await deploy();
      await expect(
        harness.recoverSigner(DATA, ACTION_ID, TAG, 1, "0x1234"),
      ).to.be.revertedWithCustomError(harness, "BadSignatureLength");
    });
  });
});
