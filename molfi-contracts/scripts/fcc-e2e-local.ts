/**
 * End-to-end proof that the code inside the TEE image opens a real book.
 *
 *   npx hardhat node                                         # terminal 1
 *   npx hardhat run scripts/fcc-e2e-local.ts --network localhost
 *
 * The existing Hardhat tests exercise the enclave MODULES. This exercises the
 * FCC HANDLER — the compiled `handleOpenBook` that the registered Confidential
 * Compute container actually serves — against a live chain it has to read over
 * JSON-RPC, exactly as it does on Coston2. Nothing here is stubbed: real
 * contracts, real ciphertexts, real chain reads, the handler's own signature,
 * and a real `openMarket` + `claim` that must accept it.
 *
 * A local node rather than Coston2 only because minting FXRP requires paying
 * real XRP on the XRP Ledger. Every line of the path is identical.
 */
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { id, Wallet } from "ethers";
// The compiled artifacts from the TEE image — the exact JavaScript the
// registered container runs, not its TypeScript source and not a copy of it.
// @ts-expect-error — compiled image modules, no types emitted alongside
import { enclaveKeypair, sealSide } from "../../molfi-fcc/extension/dist/app/seal.js";
// @ts-expect-error
import { handleOpenBook, resetState } from "../../molfi-fcc/extension/dist/app/handlers.js";

const DAY = 86_400;
const XRP_USD = "0x015852502f55534400000000000000000000000000";
const fxrp = (n: string) => ethers.parseUnits(n, 6);
const usd = (n: string) => ethers.parseUnits(n, 18);

const ENCLAVE_KEY = `0x${"a1".repeat(32)}`;
const SIGNER_KEY = `0x${"b2".repeat(32)}`;

const ok = (label: string) => console.log(`  \x1b[32m✓\x1b[0m ${label}`);
const fail = (label: string, detail: string) => {
  console.error(`  \x1b[31m✗\x1b[0m ${label}\n    ${detail}`);
  process.exitCode = 1;
};

/** Decode the handler's `[dataHex, status, error]` result. */
function unwrap(result: [string | null, number, string | null]): Record<string, any> {
  const [data, status, err] = result;
  if (status !== 1 || !data) throw new Error(`handler failed: ${err ?? "unknown"}`);
  return JSON.parse(Buffer.from(data.slice(2), "hex").toString("utf-8"));
}

async function main() {
  const [admin, alice, bob, carol] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const rpc = "http://127.0.0.1:8545";

  const enclave = enclaveKeypair(ENCLAVE_KEY);
  const teeSigner = new Wallet(SIGNER_KEY).address;
  console.log(`\n  chain ${chainId} · enclave ${enclave.publicKey.slice(0, 14)}… · signer ${teeSigner}\n`);

  // --- Deploy ---------------------------------------------------------------
  const token = await (await ethers.getContractFactory("MockFXRP")).deploy();
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
  const market = await (
    await ethers.getContractFactory("MolfiMarket")
  ).deploy(await oracle.getAddress());
  const book = await (
    await ethers.getContractFactory("SealedBidBook")
  ).deploy(await token.getAddress(), await market.getAddress(), teeSigner, admin.address);
  const bookAddr = await book.getAddress();
  ok(`deployed SealedBidBook ${bookAddr}`);

  for (const s of [alice, bob, carol]) {
    await token.mintUnits(s.address, 10_000n);
    await token.connect(s).approve(bookAddr, ethers.MaxUint256);
  }

  const close = (await time.latest()) + DAY;
  const MKT = id("fcc-e2e");
  await market.createPriceMarket(MKT, "XRP >= $3?", close, XRP_USD, usd("3"), 0, DAY * 2);

  // --- Seal, with the image's sealer ---------------------------------------
  const plan = [
    { signer: alice, amount: fxrp("100"), side: 0 },
    { signer: bob, amount: fxrp("400"), side: 1 },
    { signer: carol, amount: fxrp("250"), side: 0 },
  ];
  for (const p of plan) {
    const ct = sealSide(enclave.publicKey, MKT, p.signer.address, p.side);
    await book.connect(p.signer).sealBid(MKT, p.amount, ct);
  }
  const [total, count, opened] = await book.bookStatus(MKT);
  if (total === fxrp("750") && count === 3n && !opened) {
    ok(`3 bids sealed · ${ethers.formatUnits(total, 6)} FXRP escrowed · split not on chain`);
  } else {
    fail("book state after sealing", `${total} ${count} ${opened}`);
  }

  await time.increaseTo(close + 1);
  await oracle.setPrice(XRP_USD, usd("3.50"));
  await market.resolveFromOracle(MKT); // YES wins

  // --- The handler the container serves ------------------------------------
  const env = {
    CHAIN_ID: String(chainId),
    CHAIN_URL: rpc,
    SEALED_BID_BOOK: bookAddr,
    ENCLAVE_PRIVATE_KEY: ENCLAVE_KEY,
    TEE_SIGNER_KEY: SIGNER_KEY,
    SIMULATED_TEE: "true",
  };
  resetState(env);

  // The on-chain route passes abi.encode(bytes32); prove that path, not a
  // convenience JSON one.
  const result = unwrap(await handleOpenBook(MKT));
  const yesPool = BigInt(result.yesPool);
  const noPool = BigInt(result.noPool);

  if (yesPool === fxrp("350") && noPool === fxrp("400")) {
    ok(`handler opened the book: YES ${ethers.formatUnits(yesPool, 6)} · NO ${ethers.formatUnits(noPool, 6)}`);
  } else {
    fail("pools", `got YES ${yesPool} NO ${noPool}`);
  }
  if (yesPool + noPool === total) ok("conservation holds against on-chain escrow");
  else fail("conservation", `${yesPool + noPool} vs ${total}`);

  // The contract's own digest, and the handler's signature over it.
  // `openDigest` already carries the EIP-191 prefix, so this recovers against
  // the raw digest — prefixing a second time here would "verify" a different
  // message and quietly pass.
  const digest = await book.openDigest(MKT, yesPool, noPool, result.bidCount, result.openingsRoot);
  const recovered = ethers.recoverAddress(digest, result.signature);
  if (recovered === teeSigner) ok(`signature recovers to the enclave signer ${recovered}`);
  else fail("signature recovery", `got ${recovered}, expected ${teeSigner}`);

  // --- The contract must accept it -----------------------------------------
  const openTx = await book.openMarket(
    MKT, yesPool, noPool, result.bidCount, result.openingsRoot, result.signature,
  );
  const openRc = await openTx.wait();
  if (openRc?.status === 1) ok(`openMarket accepted the handler's opening · gas ${openRc.gasUsed}`);
  else fail("openMarket", `reverted ${openTx.hash}`);

  // --- Winners claim with the handler's proofs ------------------------------
  const pot = total;
  for (const o of result.openings.filter((x: any) => x.side === 0)) {
    const before = await token.balanceOf(o.bidder);
    await book.claim(MKT, o.index, o.side, o.proof);
    const gross = (BigInt(o.amount) * pot) / yesPool;
    const paid = (await token.balanceOf(o.bidder)) - before;
    if (paid === gross - (gross * 200n) / 10_000n) {
      ok(`bid ${o.index} claimed ${ethers.formatUnits(paid, 6)} FXRP with the handler's Merkle proof`);
    } else {
      fail(`claim ${o.index}`, `paid ${paid}, expected ${gross - (gross * 200n) / 10_000n}`);
    }
  }

  // --- The guard that stops a silent BadSignature ---------------------------
  const stale = await (
    await ethers.getContractFactory("SealedBidBook")
  ).deploy(await token.getAddress(), await market.getAddress(), Wallet.createRandom().address, admin.address);
  const MKT2 = id("fcc-e2e-stale");
  await market.createPriceMarket(MKT2, "XRP >= $3?", (await time.latest()) + DAY, XRP_USD, usd("3"), 0, DAY * 2);
  await token.connect(alice).approve(await stale.getAddress(), ethers.MaxUint256);
  await stale.connect(alice).sealBid(
    MKT2, fxrp("10"), sealSide(enclave.publicKey, MKT2, alice.address, 0),
  );
  resetState({ ...env, SEALED_BID_BOOK: await stale.getAddress() });
  const [, status, err] = await handleOpenBook(MKT2);
  if (status === 0 && /tee signer mismatch/.test(String(err))) {
    ok("refuses to sign for a book that trusts a different key");
  } else {
    fail("tee-signer guard", `status ${status}, err ${err}`);
  }

  console.log(
    process.exitCode
      ? "\n  \x1b[31mFAILED\x1b[0m\n"
      : "\n  \x1b[32mThe TEE image's handler opened a real book and the contract paid out.\x1b[0m\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
