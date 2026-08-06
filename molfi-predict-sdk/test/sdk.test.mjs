// Unit tests for the SDK's PURE helpers — no network, no chain.
// Runs against the built ESM in ../dist (build first: `npm test` does this).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TESTNET,
  toBaseUnits,
  fromBaseUnits,
  OUTCOME_YES,
  OUTCOME_NO,
  generateWallet,
  walletFromSecret,
  buildOrder,
  canonicalize,
  canonicalOrderBytes,
  signClobOrder,
  PrivateKeyOrderSigner,
  MolfiChain,
} from "../dist/index.js";

/**
 * A MolfiChain whose viem clients are stubs, so the write path can be asserted
 * without a network. `wallet`/`pub` are TS-private, which is compile-time only —
 * at runtime they are ordinary properties.
 */
function stubbedChain({ closeTs = BigInt(Math.floor(Date.now() / 1000) + 3600) } = {}) {
  const chain = new MolfiChain({ privateKey: generateWallet().privateKey });
  const sent = [];
  chain.wallet = {
    writeContract: async (req) => {
      sent.push(req);
      return "0x" + "ab".repeat(32);
    },
  };
  chain.pub = {
    waitForTransactionReceipt: async () => ({ status: "success" }),
    readContract: async ({ functionName }) => {
      if (functionName === "allowance") return 2n ** 256n - 1n; // already approved
      if (functionName === "getMarket") return ["q", closeTs, 0, 0];
      throw new Error(`unexpected read: ${functionName}`);
    },
  };
  return { chain, sent };
}

test("config: TESTNET points at Coston2 with 6-decimal FXRP", () => {
  assert.equal(TESTNET.chainId, 114);
  // FXRP follows XRP drops (1 XRP = 1e6), not the 7 decimals the mock used.
  assert.equal(TESTNET.decimals, 6);
  assert.match(TESTNET.rpcUrl, /coston2-api\.flare\.network/);
  assert.equal(TESTNET.contracts.fxrp, "0x0b6A3645c240605887a5532109323A3E12273dc7");
  // Feeds are bytes21 FTSO ids, not addresses — XRP/USD is the flagship market.
  assert.equal(
    TESTNET.feeds["XRP/USD"],
    "0x015852502f55534400000000000000000000000000",
  );
  assert.ok(TESTNET.feeds["FLR/USD"]);
});

test("config: explicit gas limits are set for the calls Coston2 under-estimates", () => {
  // An FXRP transfer measured 151,388 gas against a 130,981 estimate; the
  // resulting out-of-gas revert has empty data and looks like a rejection.
  assert.ok(TESTNET.gas.fxrp > 151_388n);
  assert.ok(TESTNET.gas.tx >= TESTNET.gas.fxrp);
});

test("chain: the configured gas limit actually reaches the write request", async () => {
  // Asserting the constant exists is not enough — it was exported, documented
  // and asserted for the whole port while `send()` never passed it, so every
  // write still went through Coston2's under-reporting estimateGas.
  const { chain, sent } = stubbedChain();
  await chain.bet("0x" + "11".repeat(32), OUTCOME_YES, 10);
  assert.equal(sent.at(-1).functionName, "bet");
  assert.equal(sent.at(-1).gas, TESTNET.gas.fxrp);

  await chain.resolveFromOracle("0x" + "11".repeat(32));
  assert.equal(sent.at(-1).functionName, "resolveFromOracle");
  assert.equal(sent.at(-1).gas, TESTNET.gas.tx);
});

test("chain: a reverted receipt is reported as failure, not a success hash", async () => {
  const { chain } = stubbedChain();
  chain.pub.waitForTransactionReceipt = async () => ({ status: "reverted" });
  await assert.rejects(
    () => chain.bet("0x" + "11".repeat(32), OUTCOME_YES, 10),
    /reverted on-chain \(bet\)/,
  );
});

test("chain: refuses a stake on a market that has already closed", async () => {
  // The settlement price is public from close onward and resolution is
  // permissionless, so a late stake is a risk-free claim on the pot.
  const { chain } = stubbedChain({ closeTs: BigInt(Math.floor(Date.now() / 1000) - 60) });
  await assert.rejects(
    () => chain.bet("0x" + "11".repeat(32), OUTCOME_YES, 10),
    /closed 6[01]s ago/,
  );
});

test("outcome constants", () => {
  assert.equal(OUTCOME_YES, 0);
  assert.equal(OUTCOME_NO, 1);
});

test("toBaseUnits: 6-decimal conversion + truncation", () => {
  assert.equal(toBaseUnits(1), 1_000_000n);
  assert.equal(toBaseUnits(1.5), 1_500_000n);
  assert.equal(toBaseUnits("100"), 100_000_000n);
  assert.equal(toBaseUnits(0), 0n);
  // more precision than 6 decimals is truncated, not rounded
  assert.equal(toBaseUnits("0.12345678"), 123_456n);
});

test("toBaseUnits: rejects garbage", () => {
  assert.throws(() => toBaseUnits("abc"));
  assert.throws(() => toBaseUnits(""));
});

test("fromBaseUnits: inverse of toBaseUnits", () => {
  assert.equal(fromBaseUnits(1_000_000n), 1);
  assert.equal(fromBaseUnits(1_500_000n), 1.5);
  assert.equal(fromBaseUnits(123_456n), 0.123456);
  for (const v of [0, 1, 2.5, 100, 999.99]) {
    assert.equal(fromBaseUnits(toBaseUnits(v)), v);
  }
});

test("wallet: generateWallet mints a valid 0x EVM keypair", () => {
  const w = generateWallet();
  assert.match(w.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(w.publicKey, w.address);
  assert.match(w.privateKey, /^0x[0-9a-fA-F]{64}$/);
  // round-trips through walletFromSecret
  const w2 = walletFromSecret(w.secret);
  assert.equal(w2.address, w.address);
});

test("order: buildOrder fills defaults + validates bounds", () => {
  const o = buildOrder({ market: "0xabc", side: "BUY", outcome: "YES", price: 0.5, size: 10, maker: "0xmaker" });
  assert.ok(o.expiry > Date.now());
  assert.ok(o.nonce && o.nonce.length > 0);
  assert.throws(() => buildOrder({ market: "0xabc", side: "BUY", outcome: "YES", price: 1.5, size: 10 }));
  assert.throws(() => buildOrder({ market: "0xabc", side: "BUY", outcome: "YES", price: 0.5, size: 0 }));
});

test("order: canonicalize is deterministic", () => {
  const full = {
    market: "0xabc", maker: "0xmaker", side: "BUY", outcome: "YES",
    price: 0.5, size: 10, expiry: 1_800_000_000_000, nonce: "deadbeef",
  };
  const a = canonicalize(full);
  const b = canonicalize({ ...full });
  assert.equal(a, b);
  assert.match(a, /0\.500000/);
});

test("clob: canonicalOrderBytes packs to 104 bytes big-endian", () => {
  const market = new Uint8Array(32).fill(1);
  const maker = new Uint8Array(32).fill(2);
  const bytes = canonicalOrderBytes(
    { market, outcome: "NO", price: 0.5, size: 1000n, nonce: 7n, expiry: 1234n },
    maker,
  );
  assert.equal(bytes.length, 104);
  // outcome NO => u32 BE = 1 at offset 64
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getUint32(64, false), 1);
  // price 0.5 => 500000 micro-units at offset 68
  assert.equal(dv.getUint32(68, false), 500000);
});

test("clob: canonicalOrderBytes rejects bad inputs", () => {
  const ok = new Uint8Array(32);
  assert.throws(() => canonicalOrderBytes({ market: new Uint8Array(31), outcome: "YES", price: 0.5, size: 1n, nonce: 0n, expiry: 0n }, ok));
  assert.throws(() => canonicalOrderBytes({ market: ok, outcome: "YES", price: 2, size: 1n, nonce: 0n, expiry: 0n }, ok));
});

test("clob: PrivateKeyOrderSigner signs canonical bytes (EVM secp256k1)", async () => {
  const w = generateWallet();
  const signer = new PrivateKeyOrderSigner(w.privateKey);
  const maker = await signer.publicKey();
  assert.equal(maker.length, 32);
  const signed = await signClobOrder(
    { market: new Uint8Array(32).fill(9), outcome: "YES", price: 0.42, size: 5n, nonce: 1n, expiry: 2n },
    signer,
  );
  // 65-byte ECDSA signature (r,s,v)
  assert.equal(signed.signature.length, 65);
  assert.equal(signed.makerPubkey.length, 32);
});
