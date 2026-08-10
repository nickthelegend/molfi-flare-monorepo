import { expect } from "chai";
import { ethers } from "hardhat";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * The vault the app always claimed to have.
 *
 * The behaviours worth pinning are the ones whose absence destroyed funds:
 * a deposit must be recoverable, and fees must lift a share's value without
 * minting anything.
 */
describe("MolfiLpVault", () => {
  const U = 1_000_000n; // FXRP, 6 dp

  let vault: any;
  let fxrp: any;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let house: SignerWithAddress;

  beforeEach(async () => {
    [, alice, bob, house] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockFXRP");
    fxrp = await Token.deploy();
    await fxrp.waitForDeployment();

    const Vault = await ethers.getContractFactory("MolfiLpVault");
    vault = await Vault.deploy(await fxrp.getAddress());
    await vault.waitForDeployment();

    for (const who of [alice, bob, house]) {
      await fxrp.mint(who.address, 1000n * U);
      await fxrp.connect(who).approve(await vault.getAddress(), ethers.MaxUint256);
    }
  });

  it("mints shares 1:1 on the first deposit and prices at parity", async () => {
    await vault.connect(alice).deposit(100n * U);
    expect(await vault.totalShares()).to.equal(100n * U);
    expect(await vault.sharesOf(alice.address)).to.equal(100n * U);
    expect(await vault.sharePrice()).to.equal(10n ** 18n);
    expect(await vault.assetsOf(alice.address)).to.equal(100n * U);
  });

  it("returns the deposit in full — the path that did not exist before", async () => {
    const before = await fxrp.balanceOf(alice.address);
    await vault.connect(alice).deposit(100n * U);
    await vault.connect(alice).withdrawAll();
    expect(await fxrp.balanceOf(alice.address)).to.equal(before);
    expect(await vault.totalShares()).to.equal(0n);
  });

  it("lifts every share's value when fees are collected, minting nothing", async () => {
    await vault.connect(alice).deposit(100n * U);
    await vault.connect(house).collectFees(10n * U);

    expect(await vault.totalShares()).to.equal(100n * U); // no dilution
    expect(await vault.sharePrice()).to.equal((11n * 10n ** 18n) / 10n); // 1.1
    expect(await vault.assetsOf(alice.address)).to.equal(110n * U);
    expect(await vault.lifetimeFees()).to.equal(10n * U);
  });

  it("splits fees pro-rata between depositors", async () => {
    await vault.connect(alice).deposit(100n * U);
    await vault.connect(bob).deposit(300n * U);
    await vault.connect(house).collectFees(40n * U);

    // 100/400 and 300/400 of a 440 pot.
    expect(await vault.assetsOf(alice.address)).to.equal(110n * U);
    expect(await vault.assetsOf(bob.address)).to.equal(330n * U);
  });

  it("does not let a later depositor buy into fees they did not earn", async () => {
    await vault.connect(alice).deposit(100n * U);
    await vault.connect(house).collectFees(100n * U); // price now 2.0

    await vault.connect(bob).deposit(100n * U);
    // Bob paid 100 at 2.0 → 50 shares, and is worth exactly what he put in.
    expect(await vault.sharesOf(bob.address)).to.equal(50n * U);
    expect(await vault.assetsOf(bob.address)).to.equal(100n * U);
    expect(await vault.assetsOf(alice.address)).to.equal(200n * U);
  });

  it("rejects a withdrawal larger than the holding", async () => {
    await vault.connect(alice).deposit(10n * U);
    await expect(vault.connect(alice).withdraw(11n * U)).to.be.revertedWithCustomError(
      vault,
      "InsufficientShares",
    );
  });

  it("rejects zero deposits and zero withdrawals", async () => {
    await expect(vault.connect(alice).deposit(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(alice).withdraw(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
  });

  it("refuses a dust first deposit, so the pot cannot be inflation-attacked", async () => {
    await expect(vault.connect(alice).deposit(999n)).to.be.revertedWithCustomError(
      vault,
      "DepositTooSmall",
    );
  });

  it("survives everyone leaving and someone arriving again", async () => {
    await vault.connect(alice).deposit(100n * U);
    await vault.connect(house).collectFees(50n * U);
    await vault.connect(alice).withdrawAll();

    expect(await vault.totalShares()).to.equal(0n);
    expect(await vault.totalAssets()).to.equal(0n);
    expect(await vault.sharePrice()).to.equal(10n ** 18n); // back to parity

    await vault.connect(bob).deposit(10n * U);
    expect(await vault.assetsOf(bob.address)).to.equal(10n * U);
  });
});
