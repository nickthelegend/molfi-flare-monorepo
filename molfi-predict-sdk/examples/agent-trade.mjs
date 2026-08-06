/**
 * Autonomous Molfi trading agent — runnable demo.
 *
 *   cd molfi-predict-sdk && npm install && npm run build
 *   node examples/agent-trade.mjs
 *
 * It generates a wallet, reports its FXRP balance (FXRP comes from the Flare
 * faucet — it is bridged XRP and cannot be minted), reads the live markets, and
 * — if an on-chain market is available — places a REAL FXRP bet and reads back
 * its escrowed position. Pass MOLFI_MARKET_ID=<32-byte hex> to bet on a
 * specific on-chain market.
 *
 * NOTE: a fresh wallet has 0 C2FLR. Set MOLFI_FUNDER_KEY=<0x… funded EVM key>
 * to have onboard() send this wallet gas automatically; otherwise fund
 * `agent.address` with C2FLR yourself before the bet tx below, or it reverts.
 */
import { MolfiAgent, OUTCOME_YES, fromBaseUnits } from "../dist/index.js";

const log = (...a) => console.log(...a);

const agent = MolfiAgent.create();
log("🪪  new agent wallet:", agent.address);
log("    (secret — keep safe):", agent.wallet.secret.slice(0, 8) + "…");

log("\n⛽  onboarding (C2FLR gas)…");
const onboarded = await agent.onboard(
  process.env.MOLFI_FUNDER_KEY ? { funderKey: process.env.MOLFI_FUNDER_KEY } : undefined,
);
log("    gas funded:", onboarded.gasFunded, "| FXRP:", onboarded.fxrp);
if (!onboarded.gasFunded) {
  log("    ⚠️  no MOLFI_FUNDER_KEY set — this wallet has 0 C2FLR; the bet below will revert until it's funded.");
}
if (onboarded.note) log("    ⚠️ ", onboarded.note);

log("\n📈  live markets (top 3 by implied YES odds):");
const markets = await agent.markets();
for (const m of markets.slice(0, 3)) {
  log(`    ${m.symbol}  ${(m.yesPrice * 100).toFixed(0)}% YES  —  ${m.question}`);
}

log("\n🏆  leaderboard (top 3 by PnL):");
for (const r of (await agent.leaderboard()).slice(0, 3)) {
  log(`    #${r.rank}  ${r.address.slice(0, 8)}…  PnL ${r.pnl}  win% ${r.winRate}`);
}

const marketId = process.env.MOLFI_MARKET_ID || (await agent.onChainMarkets())[0]?.marketId;
if (!marketId) {
  log("\nℹ️  No on-chain market id available to bet on.");
  log("    Set MOLFI_MARKET_ID=<32-byte hex>, or run molfi-contracts/scripts/agent_onchain_bet.sh.");
  process.exit(0);
}

if ((await agent.fxrp()) < 100) {
  log("\nℹ️  Need ≥100 FXRP to place the demo bet — fund", agent.address);
  log("    at https://faucet.flare.network/coston2 and re-run.");
  process.exit(0);
}

log(`\n🎯  placing a REAL on-chain bet: 100 FXRP on YES of ${marketId.slice(0, 12)}…`);
const tx = await agent.bet(marketId, OUTCOME_YES, 100);
log("    bet tx:", tx);
// fromBaseUnits reads decimals from config, so this can't drift the way a
// hardcoded divisor did (it was /1e7, printing every position 10x too small).
log("    escrowed YES position:", fromBaseUnits(await agent.chain.escrowPosition(marketId, OUTCOME_YES)), "FXRP");
log("    FXRP balance now:", await agent.fxrp());
log("\n✅  Done. When the market resolves, call agent.redeem(marketId) to claim winnings.");
