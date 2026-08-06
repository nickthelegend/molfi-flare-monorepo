import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { downsampleSeries } from "@/lib/charts/sparkline-path";
import { fetchBackendPrices } from "@/lib/molfi-backend";
import type { LeverxMarketRow } from "@/lib/leverx/indexer-markets";

const REFETCH_MS = 60_000;
const MAX_POINTS = 32;

/**
 * Per-asset FTSO-fed close-price sparkline for market grid/list cards.
 *
 * This used to fetch ONE `XBTC_USDC` series from the Sui mainnet DeepBook
 * indexer and map it onto every market, so an XRP/USD market on Flare drew a
 * Bitcoin-on-Sui line and quoted Bitcoin's percentage change as its own. Prices
 * now come from the same FTSOv2-fed backend series the detail chart uses, keyed
 * by the market's own asset.
 *
 * Queries are deduped by symbol — several markets share one asset, so one query
 * per market would fan out duplicate requests for the same series.
 */
export function useMarketPremiumSparklines(markets: readonly LeverxMarketRow[]) {
  const symbols = useMemo(
    () => [...new Set(markets.map((m) => (m.asset || "").toUpperCase()).filter(Boolean))],
    [markets],
  );

  const results = useQueries({
    queries: symbols.map((sym) => ({
      // Same key + fetch as the detail page, so cache shapes stay aligned.
      queryKey: ["molfi-prices", sym],
      queryFn: () => fetchBackendPrices(sym, 120),
      staleTime: REFETCH_MS / 2,
      refetchInterval: REFETCH_MS,
      refetchIntervalInBackground: false,
      retry: 1,
    })),
  });

  const dataKey = results.map((r) => r.dataUpdatedAt).join(",");

  const seriesByMarketId = useMemo(() => {
    const bySymbol = new Map<string, number[]>();
    symbols.forEach((sym, i) => {
      const closes = (results[i]?.data ?? [])
        .map((p) => p.price)
        .filter((v) => Number.isFinite(v) && v > 0);
      // Cap at MAX_POINTS so the sparkline geometry matches what the DeepBook
      // path produced; the consumers size themselves off the point count.
      bySymbol.set(sym, downsampleSeries(closes, MAX_POINTS));
    });

    const map = new Map<string, number[]>();
    for (const market of markets) {
      // An asset with no backend history yields [] — consumers already gate on
      // `series.length >= 2`, so it degrades to no sparkline rather than a wrong one.
      map.set(market.id, bySymbol.get((market.asset || "").toUpperCase()) ?? []);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, symbols, dataKey]);

  return {
    seriesByMarketId,
    isLoading: results.some((r) => r.isLoading),
  };
}
