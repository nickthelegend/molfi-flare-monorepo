import { describe, expect, it } from "vitest";
import {
  isBackendMarketId,
  onChainMarketToRow,
  backendMarketToRow,
  type BackendMarket,
  type OnChainMarketRef,
} from "@/lib/molfi-backend";

describe("isBackendMarketId", () => {
  it.each([
    "XRP-15m-2.31-1751000000000",
    "FLR-30m-0.0215-1751000000000",
    "BTC-15m-60500-1751000000000",
    "ETH-30m-3200-1751000000000",
  ])("accepts a well-formed backend market id: %s", (id) => {
    expect(isBackendMarketId(id)).toBe(true);
  });

  it.each([
    "0xabc123deadbeef", // on-chain hex id
    "xrp-15m-2.31-1751000000000", // lowercase symbol not recognized
    "FOO-15m-1-1751000000000", // unknown symbol prefix
    "SOL-15m-140-1751000000000", // Stellar-era symbol the backend never mints
    "XLM-15m-0.177-1751000000000", // ditto
    "BTC-60400-1751000000", // no cadence segment — pre-Flare id shape
    "", // empty
    "60400-BTC-1751000000", // wrong order
  ])("rejects a non-backend id: %s", (id) => {
    expect(isBackendMarketId(id)).toBe(false);
  });
});

function baseOnChainMarket(overrides: Partial<OnChainMarketRef> = {}): OnChainMarketRef {
  return {
    marketId: "0xdead",
    symbol: "BTC",
    question: "Will BTC be above its current price at close?",
    closeTs: 1_800_000_000_000,
    resolved: false,
    ...overrides,
  };
}

describe("onChainMarketToRow", () => {
  it("maps an open market to an 'active' row with onchainStatus 0", () => {
    const row = onChainMarketToRow(baseOnChainMarket());
    expect(row.id).toBe("0xdead");
    expect(row.oracleId).toBe("0xdead");
    expect(row.status).toBe("active");
    expect(row.onchainStatus).toBe(0);
    // outcome is unknown pre-resolution regardless of upstream data
    expect(row.onchainOutcome).toBe(2);
  });

  it("maps a resolved market to onchainStatus 2", () => {
    const row = onChainMarketToRow(baseOnChainMarket({ resolved: true }));
    expect(row.status).toBe("resolved");
    expect(row.onchainStatus).toBe(2);
  });

  it("converts yesPrice to a 1e9-scaled probability, and passes through null", () => {
    const withPrice = onChainMarketToRow(baseOnChainMarket({ yesPrice: 0.63 }));
    // Raw 1e9 scale, NOT 0-100 cents — the grid divides by 1e9. Reverting
    // toPremiumRaw to `yesPrice * 100` reintroduces a ~18,689,121x payout bug.
    expect(withPrice.lastAskPremium).toBe(630_000_000);

    const withoutPrice = onChainMarketToRow(baseOnChainMarket({ yesPrice: undefined }));
    expect(withoutPrice.lastAskPremium).toBeNull();
  });

  it("defaults strike and volume when absent", () => {
    const row = onChainMarketToRow(baseOnChainMarket({ strike: undefined, oi: undefined }));
    expect(row.strike).toBe(0);
    expect(row.volume).toBe(0);
  });

  it("carries strike and oi through when present", () => {
    const row = onChainMarketToRow(baseOnChainMarket({ strike: 61234, oi: 42 }));
    expect(row.strike).toBe(61234);
    expect(row.volume).toBe(42);
  });
});

function baseBackendMarket(overrides: Partial<BackendMarket> = {}): BackendMarket {
  return {
    _id: "BTC-60400-1751000000",
    symbol: "BTC",
    category: "crypto",
    question: "Will BTC be above $60,400 at close?",
    strike: 60400,
    side: "up",
    openPrice: 60100,
    createdAt: 1_750_000_000_000,
    closeTs: 1_800_000_000_000,
    status: "open",
    outcome: null,
    settlePrice: null,
    yesPrice: 0.5,
    spot: 60250,
    ...overrides,
  };
}

describe("backendMarketToRow", () => {
  it("maps an open market with a null outcome to onchainOutcome 2 (unknown)", () => {
    const row = backendMarketToRow(baseBackendMarket());
    expect(row.status).toBe("active");
    expect(row.onchainStatus).toBe(0);
    expect(row.onchainOutcome).toBe(2);
  });

  it("maps a resolved YES market", () => {
    const row = backendMarketToRow(baseBackendMarket({ status: "resolved", outcome: "yes" }));
    expect(row.status).toBe("resolved");
    expect(row.onchainStatus).toBe(2);
    expect(row.onchainOutcome).toBe(0);
  });

  it("maps a resolved NO market", () => {
    const row = backendMarketToRow(baseBackendMarket({ status: "resolved", outcome: "no" }));
    expect(row.onchainOutcome).toBe(1);
  });

  it("always zeroes the strike fields (no on-chain premium fetch for backend rows)", () => {
    const row = backendMarketToRow(baseBackendMarket({ strike: 60400 }));
    expect(row.strike).toBe(0);
    expect(row.strikeRaw).toBe(0);
    expect(row.higherStrikeRaw).toBe(0);
  });

  it("converts yesPrice to a 1e9-scaled probability", () => {
    const row = backendMarketToRow(baseBackendMarket({ yesPrice: 0.72 }));
    expect(row.lastAskPremium).toBe(720_000_000);
  });

  it("defaults volume from oi when present, else 0", () => {
    const withOi = backendMarketToRow(baseBackendMarket({ oi: 17 }));
    expect(withOi.volume).toBe(17);

    const withoutOi = backendMarketToRow(baseBackendMarket({ oi: undefined }));
    expect(withoutOi.volume).toBe(0);
  });
});
