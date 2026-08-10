import { expect } from "chai";
import { ethers } from "hardhat";
// The extension's own identifiers. Imported, not restated — the whole failure
// mode being guarded against here is two copies of a string drifting apart.
// @ts-expect-error — compiled image module, no types
import {
  OP_TYPE_MOLFI, OP_COMMAND_OPEN_BOOK, OP_COMMAND_SEAL_KEY,
} from "../../molfi-fcc/extension/dist/app/config.js";

/**
 * MolfiInstructionSender — the only address allowed to route a MOLFI
 * instruction.
 *
 * The registry enforces that at the protocol level, so the interesting failures
 * are not access control (there is none to get wrong) but the two places where
 * this contract has to agree with something outside itself: the op identifiers
 * the extension dispatches on, and the extension id the registry assigned.
 */
const b32 = (s: string) => ethers.zeroPadBytes(ethers.toUtf8Bytes(s), 32);

describe("MolfiInstructionSender", () => {
  async function deploy() {
    const [owner, stranger, machine] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("MockTeeRegistry")).deploy();
    await registry.addMachine(machine.address);
    const sender = await (
      await ethers.getContractFactory("MolfiInstructionSender")
    ).deploy(await registry.getAddress(), await registry.getAddress());
    return { owner, stranger, machine, registry, sender };
  }

  describe("the identifiers the extension dispatches on", () => {
    it("matches the extension's op type and commands EXACTLY", async () => {
      // A mismatch here does not fail loudly anywhere: the instruction lands,
      // the extension shrugs at an op type it does not recognise, and the
      // action just never produces a result.
      const { sender } = await deploy();
      expect(await sender.OP_TYPE_MOLFI()).to.equal(b32(OP_TYPE_MOLFI));
      expect(await sender.OP_COMMAND_OPEN_BOOK()).to.equal(b32(OP_COMMAND_OPEN_BOOK));
      expect(await sender.OP_COMMAND_SEAL_KEY()).to.equal(b32(OP_COMMAND_SEAL_KEY));
    });

    it("uses right-padded UTF-8, not a hash", async () => {
      // go-flare-common's op.Type.Hash() right-pads ASCII to 32 bytes. Reaching
      // for keccak256 here is the intuitive wrong move.
      const { sender } = await deploy();
      expect(await sender.OP_TYPE_MOLFI()).to.equal(
        "0x4d4f4c4649" + "00".repeat(27),
      );
      expect(await sender.OP_TYPE_MOLFI()).to.not.equal(ethers.id("MOLFI"));
    });
  });

  describe("extension id", () => {
    it("refuses to send before the id is known", async () => {
      const { sender } = await deploy();
      await expect(sender.sendOpenBook(ethers.id("m"))).to.be.revertedWithCustomError(
        sender,
        "ExtensionIdNotSet",
      );
    });

    it("finds its own id by scanning the registry", async () => {
      const { sender, registry } = await deploy();
      // Put two other extensions in front of ours so the scan actually walks.
      await registry.register(ethers.Wallet.createRandom().address);
      await registry.register(ethers.Wallet.createRandom().address);
      const tx = await registry.register(await sender.getAddress());
      await tx.wait();

      await sender.setExtensionId();
      expect(await sender.extensionId()).to.equal(0x10002);
    });

    it("reverts when no extension is registered against it", async () => {
      const { sender, registry } = await deploy();
      await registry.register(ethers.Wallet.createRandom().address);
      await expect(sender.setExtensionId()).to.be.revertedWithCustomError(
        sender,
        "ExtensionIdNotFound",
      );
    });

    it("is single-shot", async () => {
      const { sender, registry } = await deploy();
      await registry.register(await sender.getAddress());
      await sender.setExtensionId();
      await expect(sender.setExtensionId()).to.be.revertedWithCustomError(
        sender,
        "ExtensionIdAlreadySet",
      );
    });
  });

  describe("routing an instruction", () => {
    async function ready() {
      const f = await deploy();
      await f.registry.register(await f.sender.getAddress());
      await f.sender.setExtensionId();
      return f;
    }

    it("sends OPEN_BOOK with the market id as a raw bytes32 word", async () => {
      // abi.encode(bytes32) IS the 32-byte word; the extension's decoder keys
      // off exactly that length to tell the on-chain payload from JSON.
      const { sender, registry } = await ready();
      const marketId = ethers.id("xrp-market");
      await sender.sendOpenBook(marketId, { value: 1_000 });

      expect(await registry.lastOpType()).to.equal(b32(OP_TYPE_MOLFI));
      expect(await registry.lastOpCommand()).to.equal(b32(OP_COMMAND_OPEN_BOOK));
      expect(await registry.lastMessage()).to.equal(marketId);
      expect(await registry.lastTeeCount()).to.equal(1);
    });

    it("forwards the whole fee — the registry reverts FeeTooLow on zero", async () => {
      const { sender, registry } = await ready();
      await sender.sendOpenBook(ethers.id("m"), { value: 12_345 });
      expect(await registry.lastValue()).to.equal(12_345);
    });

    it("refunds unspent fee to the CALLER, not to itself", async () => {
      // claimBackAddress = address(this) would silently accumulate dust in a
      // contract with no way to get it out.
      const { sender, registry, stranger } = await ready();
      await sender.connect(stranger).sendOpenBook(ethers.id("m"), { value: 1_000 });
      expect(await registry.lastClaimBack()).to.equal(stranger.address);
    });

    it("is permissionless — anyone may ask for a market to be opened", async () => {
      // Deliberate: the enclave refuses an open market and the book refuses an
      // opening that does not reconcile, so the worst a stranger achieves is
      // paying for an answer that says no. Gating it would make settlement
      // depend on one operator still being around.
      const { sender, registry, stranger } = await ready();
      await expect(sender.connect(stranger).sendOpenBook(ethers.id("m"), { value: 1 })).to.not.be
        .reverted;
      expect(await registry.callCount()).to.equal(1);
    });

    it("sends SEAL_KEY with an empty payload", async () => {
      const { sender, registry } = await ready();
      await sender.sendSealKey({ value: 1_000 });
      expect(await registry.lastOpCommand()).to.equal(b32(OP_COMMAND_SEAL_KEY));
      expect(await registry.lastMessage()).to.equal("0x");
    });

    it("emits the instruction id, which is how a caller finds the result", async () => {
      const { sender } = await ready();
      const marketId = ethers.id("xrp-market");
      await expect(sender.sendOpenBook(marketId, { value: 1_000 })).to.emit(
        sender,
        "OpenBookRequested",
      );
    });
  });

  describe("construction", () => {
    it("rejects a zero registry", async () => {
      const factory = await ethers.getContractFactory("MolfiInstructionSender");
      await expect(
        factory.deploy(ethers.ZeroAddress, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects an address with no code", async () => {
      // A typo'd registry address would otherwise deploy fine and fail later,
      // after an extension had been registered against it.
      const [a] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("MolfiInstructionSender");
      await expect(factory.deploy(a.address, a.address)).to.be.revertedWithCustomError(
        factory,
        "NoCode",
      );
    });
  });
});
