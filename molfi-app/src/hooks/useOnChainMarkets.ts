import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOnChainMarkets, onChainMarketToRow } from "@/lib/molfi-backend";
import type { LeverxMarketRow } from "@/lib/leverx/indexer-markets";

/**
 * The real on-chain crypto markets — created + settled by the backend keeper on
 * the predict-escrow contract via the live FTSOv2 oracle. These are the
 * markets the Crypto tab shows; betting on them escrows real FXRP.
 */
export function useOnChainMarkets(status: "open" | "closed" = "open") {
  const query = useQuery({
    queryKey: ["onchain-markets-grid", status],
    queryFn: () => fetchOnChainMarkets(status),
    refetchInterval: 15_000,
    // Keep polling even when the tab is not focused. Without this a query that
    // errored during an outage stayed errored: the interval is suspended in the
    // background, so the page sat on "Can't reach Coston2" indefinitely after
    // the backend came back, and only a manual reload recovered it.
    refetchIntervalInBackground: true,
    // Retry forever, with a capped backoff.
    //
    // A finite retry count latches the query into a terminal error state, and
    // `refetchInterval` did not reliably pull it back out — so once the backend
    // blipped the page sat on "Can't reach Coston2" until a manual reload. This
    // is a live venue: it should keep trying and heal by itself. `failureCount`
    // still drives the offline banner, and resets to 0 on the first success.
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    // A failed refetch should not blank a grid that is already populated.
    placeholderData: (previous) => previous,
  });

  const markets = useMemo<LeverxMarketRow[]>(
    () => (query.data ?? []).map(onChainMarketToRow),
    [query.data],
  );

  return {
    markets,
    loading: query.isLoading,
    error: query.isError,
    /**
     * True when we have nothing to show AND the backend is not answering.
     *
     * `isError` alone was not enough: with `placeholderData` and a retry in
     * flight the query can sit in a non-error state for seconds, during which
     * the grid rendered "No markets right now" — telling the user the venue is
     * empty when in fact the server is down. `failureCount` increments on the
     * first failed attempt, so this flips as soon as one request has actually
     * failed.
     */
    offline: (query.isError || query.failureCount > 0) && markets.length === 0,
    errorMessage: query.error instanceof Error ? query.error.message : null,
  };
}
