import { useMemo } from "react";
import { useMarketPremiumSparklines } from "@/hooks/useMarketPremiumSparklines";
import { useVisibleOracleSpots } from "@/hooks/useVisibleOracleSpots";
import type { LeverxMarketRow } from "@/lib/leverx/indexer-markets";
import { gridUpDisplayRow } from "@/lib/leverx/predict-oracle-markets";

/** UP "above …" catalog rows with live spot and on-chain asks (grid + list). */
export function useMarketsUpDisplay(sourceMarkets: readonly LeverxMarketRow[]) {
  const sourceById = useMemo(
    () => new Map(sourceMarkets.map((market) => [market.id, market])),
    [sourceMarkets],
  );

  const { markets: withSpots } = useVisibleOracleSpots(sourceMarkets);
  const displayRows = useMemo(() => withSpots.map(gridUpDisplayRow), [withSpots]);
  // Was useVisibleMarketAsks(displayRows) — a DeepBook Predict order-book quote
  // over a Sui devInspect. Molfi is pari-mutuel and has no such book, so with
  // no Sui config the hook was disabled and returned its input untouched. The
  // rows pass through directly now, and the @mysten SDK leaves the bundle.
  const displayMarkets = displayRows;
  const premiumLoading = false;
  const { seriesByMarketId } = useMarketPremiumSparklines(displayMarkets);

  return {
    sourceById,
    displayMarkets,
    premiumLoading,
    seriesByMarketId,
  };
}
