/**
 * Unit tests for the MCP tool surface.
 *
 * These are offline-green: they assert the argument validation and shaping that
 * runs BEFORE any network call, plus the chain constants an agent depends on.
 * The live path is covered by `npm run selftest` against Coston2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACTS, FEEDS, FXRP_DECIMALS, GAS, asHex, feedSymbol, fmtFxrp, toFxrp, txUrl,
} from "../src/chain.mjs";
import { TOOLS, getPrice, placeBet } from "../src/tools.mjs";

test("exposes the full agent tool surface", () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), [
    "molfi_get_market",
    "molfi_get_position",
    "molfi_get_price",
    "molfi_get_wallet",
    "molfi_list_markets",
    "molfi_place_bet",
    "molfi_redeem",
    "molfi_resolve_market",
  ]);
});

test("FXRP uses 6 decimals — XRP drops, not the 18 an EVM dev assumes", () => {
  assert.equal(FXRP_DECIMALS, 6);
  assert.equal(toFxrp("1"), 1_000_000n);
  assert.equal(toFxrp("0.001"), 1_000n);
  assert.equal(fmtFxrp(1_500_000n), "1.5");
});

test("feed ids are bytes21 FTSO ids, not contract addresses", () => {
  assert.equal(FEEDS.XRP, "0x015852502f55534400000000000000000000000000");
  // 0x + 42 hex chars = 21 bytes
  for (const [sym, id] of Object.entries(FEEDS)) {
    assert.equal(id.length, 44, `${sym} feed id should be bytes21`);
    assert.ok(id.startsWith("0x01"), `${sym} should be crypto category 0x01`);
  }
});

test("feedSymbol maps a feed id back to its symbol", () => {
  assert.equal(feedSymbol(FEEDS.XRP), "XRP");
  assert.equal(feedSymbol(FEEDS.XRP.toUpperCase()), "XRP");
  assert.equal(feedSymbol("0xdeadbeef"), null);
});

test("gas limits exceed the measured FXRP transfer cost", () => {
  // A transfer burns 151,388 while estimateGas can return 130,981; the
  // resulting out-of-gas has empty revert data and looks like a rejection.
  assert.ok(GAS.fxrp > 151_388n);
  assert.ok(GAS.tx >= GAS.fxrp);
});

test("asHex tolerates prefixed and bare ids", () => {
  assert.equal(asHex("abc"), "0xabc");
  assert.equal(asHex("0xabc"), "0xabc");
});

test("txUrl points at the Coston2 explorer", () => {
  assert.match(txUrl("0xdead"), /^https:\/\/coston2-explorer\.flare\.network\/tx\/0xdead$/);
});

test("contract addresses default to the live Coston2 deployment", () => {
  assert.equal(CONTRACTS.market, "0xD709773A1128c1160b292F505FAA8E3e8d0786fF");
  assert.equal(CONTRACTS.escrow, "0x75dd1eA3e80E3B32f639bDA0894Dd2c15A58a865");
  assert.equal(CONTRACTS.fxrp, "0x0b6A3645c240605887a5532109323A3E12273dc7");
});

test("get_price rejects an unsupported symbol before hitting the network", async () => {
  await assert.rejects(() => getPrice({ symbol: "DOGE" }), /unknown symbol/i);
});

test("place_bet rejects a bad outcome before spending gas", async () => {
  await assert.rejects(
    () => placeBet({ marketId: "0x" + "11".repeat(32), outcome: "MAYBE", amount: 1 }),
    /outcome must be YES or NO/i,
  );
});

test("place_bet rejects a non-positive amount", async () => {
  await assert.rejects(
    () => placeBet({ marketId: "0x" + "11".repeat(32), outcome: "YES", amount: 0 }),
    /amount must be > 0/i,
  );
});
