/**
 * Live self-test — drives the MCP tool surface against real Coston2 contracts.
 *
 *   MOLFI_AGENT_KEY=0x… node scripts/selftest.mjs
 *
 * Exercises exactly what an agent would call: read the oracle, browse markets,
 * check the bankroll, take a position in FXRP, and read the position back.
 * Without a key it runs the read-only half and says so.
 */
import { TOOLS } from "../src/tools.mjs";

const line = (s = "") => console.log(s);
const head = (s) => line(`\n${"─".repeat(58)}\n${s}\n${"─".repeat(58)}`);

let failures = 0;
async function step(label, fn) {
  try {
    const out = await fn();
    line(`✅ ${label}`);
    return out;
  } catch (e) {
    failures++;
    line(`❌ ${label} — ${e.shortMessage ?? e.message}`);
    return null;
  }
}

head("MOLFI MCP — live self-test (Flare Coston2)");

const price = await step("molfi_get_price XRP", () => TOOLS.molfi_get_price({ symbol: "XRP" }));
if (price) line(`   XRP/USD $${price.priceUsd.toFixed(6)} · ${price.ageSeconds}s old · ${price.source}`);

const list = await step("molfi_list_markets", () => TOOLS.molfi_list_markets({ limit: 5 }));
if (list) {
  line(`   ${list.count} open market(s)`);
  for (const m of list.markets.slice(0, 3)) {
    line(`   · ${m.symbol} strike $${m.strike} — closes in ${m.closesInSeconds}s — pot ${m.pools.total} FXRP`);
  }
}

const wallet = await step("molfi_get_wallet", () => TOOLS.molfi_get_wallet());
if (wallet?.connected) {
  line(`   ${wallet.address} · ${wallet.gasC2FLR.toFixed(3)} C2FLR · ${wallet.fxrp} FXRP`);
} else {
  line(`   read-only (no MOLFI_AGENT_KEY)`);
}

const target = list?.markets?.[0];
if (target) {
  const detail = await step(`molfi_get_market ${target.marketId.slice(0, 12)}…`, () =>
    TOOLS.molfi_get_market({ marketId: target.marketId }));
  if (detail?.preview) {
    line(`   would resolve ${detail.preview.wouldResolveTo} at $${detail.preview.priceUsd.toFixed(6)}`);
  }
}

// Writes only when funded — and only for an amount the wallet actually holds.
const STAKE = process.env.MOLFI_SELFTEST_STAKE ?? "0.0005";
if (wallet?.connected && target && Number(wallet.fxrp) >= Number(STAKE)) {
  head(`Placing a live bet — ${STAKE} FXRP on YES`);
  const bet = await step("molfi_place_bet", () =>
    TOOLS.molfi_place_bet({ marketId: target.marketId, outcome: "YES", amount: STAKE }));
  if (bet) for (const t of bet.transactions) line(`   ${t.step}: ${t.url}`);

  const pos = await step("molfi_get_position", () =>
    TOOLS.molfi_get_position({ marketId: target.marketId }));
  if (pos) line(`   position — YES ${pos.yes} · NO ${pos.no} FXRP`);
} else if (wallet?.connected) {
  line(`\n⚠ skipping the write path — wallet holds ${wallet.fxrp} FXRP, needs ${STAKE}.`);
  line(`  Top up: https://faucet.flare.network/coston2`);
} else {
  line(`\n⚠ skipping the write path — no MOLFI_AGENT_KEY.`);
}

head(failures === 0 ? "✅ SELF-TEST PASSED" : `❌ ${failures} step(s) failed`);
process.exit(failures === 0 ? 0 : 1);
