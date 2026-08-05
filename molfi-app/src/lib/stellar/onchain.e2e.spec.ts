// @vitest-environment node
/**
 * LIVE end-to-end test of Molfi's on-chain layer against the REAL deployed
 * contracts on Flare Coston2. It drives the app's OWN chain functions
 * (soroban.ts) — the exact code the premium UI calls — through a full trade:
 *
 *   read FXRP balance → escrow a bet → resolve from the live FTSOv2 XRP/USD
 *   feed → read pool/position/outcome → redeem the pari-mutuel payout.
 *
 * Runs only when VITE_MOLFI_E2E_KEY (a funded Coston2 key that is the market
 * admin AND holds FXRP) is set, so the default `npm test` stays offline-green:
 *   VITE_MOLFI_E2E_KEY=0x... npx vitest run src/lib/stellar/onchain.e2e.spec.ts
 *
 * NOTE vs the Avalanche version: there is no faucet step. FXRP is real bridged
 * XRP with no open mint, so the key must already hold FXRP (get it from
 * https://faucet.flare.network/coston2).
 *
 * (Read via import.meta.env, not process.env: vite-plugin-node-polyfills shims
 * `process` in the test env, so process.env is empty here.)
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  createWalletClient,
  http,
  keccak256,
  toHex,
  getAddress,
  parseUnits,
  type Abi,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  coston2Chain,
  publicClient,
  setWalletClient,
  fxrpBalance,
  listMarkets,
  escrowBet,
  escrowPool,
  escrowPosition,
  escrowTotal,
  isResolved,
  winningOutcome,
  escrowRedeem,
  TX_GAS,
} from "./soroban";
import { CONTRACTS, MUSDC_UNIT, OUTCOME, XRP_USD_FEED } from "./contracts";

const KEY = import.meta.env.VITE_MOLFI_E2E_KEY as `0x${string}` | undefined;
const unit = (base: bigint) => Number(base) / MUSDC_UNIT;

const MARKET_ADMIN_ABI = [
  {
    type: "function", name: "createPriceMarket", stateMutability: "nonpayable",
    inputs: [
      { type: "bytes32" }, { type: "string" }, { type: "uint64" },
      // Flare: a bytes21 FTSO feed id + an 18-decimal unsigned threshold,
      // replacing Chainlink's per-pair aggregator address + signed int256.
      { type: "bytes21" }, { type: "uint256" }, { type: "uint8" }, { type: "uint64" },
    ],
    outputs: [],
  },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
] as const satisfies Abi;

describe.skipIf(!KEY)("molfi on-chain e2e (live Coston2)", () => {
  const STAKE = 0.5; // FXRP on YES — small, since FXRP is faucet-limited
  let me: `0x${string}`;
  let wallet: WalletClient;
  let marketId: `0x${string}`;

  beforeAll(() => {
    const account = privateKeyToAccount(KEY!);
    me = account.address;
    wallet = createWalletClient({ account, chain: coston2Chain, transport: http() });
    setWalletClient(wallet, me); // the app's write path now signs with this wallet
    // Unique market per run → idempotent, re-runnable.
    marketId = keccak256(toHex(`molfi-e2e:${Date.now()}:${me}`));
  });

  it("reads the wallet's FXRP balance", async () => {
    const bal = await fxrpBalance(me);
    // The test cannot mint FXRP — it must already be funded.
    expect(unit(bal)).toBeGreaterThanOrEqual(STAKE);
  }, 60_000);

  it("enumerates the seeded markets", async () => {
    const markets = await listMarkets();
    expect(markets.length).toBeGreaterThanOrEqual(1);
    expect(
      markets.every((m) => typeof m.question === "string" && m.question.length > 0),
    ).toBe(true);
  }, 60_000);

  it("creates a fresh XRP price market, bets YES, and reflects the stake on-chain", async () => {
    const closeTs = BigInt(Math.floor(Date.now() / 1000) - 30); // already closed → resolvable now
    // Strike well below spot so the outcome is deterministic (XRP ≫ $0.10).
    const strike = parseUnits("0.10", 18);
    const createHash = await wallet.writeContract({
      address: getAddress(CONTRACTS.market),
      abi: MARKET_ADMIN_ABI,
      functionName: "createPriceMarket",
      args: [marketId, "E2E: XRP >= $0.10?", closeTs, XRP_USD_FEED, strike, 0, 86_400n],
      account: wallet.account!,
      chain: coston2Chain,
      gas: TX_GAS,
    });
    await publicClient.waitForTransactionReceipt({ hash: createHash });

    await escrowBet(me, marketId, OUTCOME.YES, STAKE); // the app's own bet path

    expect(unit(await escrowPool(marketId, OUTCOME.YES))).toBe(STAKE);
    expect(unit(await escrowPosition(marketId, OUTCOME.YES, me))).toBe(STAKE);
    expect(unit(await escrowTotal(marketId))).toBe(STAKE);
  }, 180_000);

  it("resolves YES from the live FTSOv2 feed and pays the pari-mutuel winner", async () => {
    const resolveHash = await wallet.writeContract({
      address: getAddress(CONTRACTS.market),
      abi: MARKET_ADMIN_ABI,
      functionName: "resolveFromOracle",
      args: [marketId],
      account: wallet.account!,
      chain: coston2Chain,
      // Explicit: Coston2 under-estimates the FTSO read path and the resulting
      // out-of-gas revert is indistinguishable from a stale-feed rejection.
      gas: TX_GAS,
    });
    await publicClient.waitForTransactionReceipt({ hash: resolveHash });

    expect(await isResolved(marketId)).toBe(true);
    expect(await winningOutcome(marketId)).toBe(OUTCOME.YES); // XRP ≫ $0.10

    const before = await fxrpBalance(me);
    await escrowRedeem(me, marketId); // the app's own redeem path
    const gained = unit((await fxrpBalance(me)) - before);
    // Sole YES bettor recovers the whole pool. The deployer is also the fee
    // vault here, so the 2% fee routes back to the same address → net gain =
    // full stake. (The fee SPLIT itself is asserted in the contracts package,
    // where vault ≠ bettor and the winner nets 98%.)
    expect(gained).toBeCloseTo(STAKE, 5);
  }, 180_000);
});
