import type { QueryClient } from "@tanstack/react-query";
import { oraclePriceLatestQueryKey } from "@/hooks/useOracleSpotPriceSeries";
import { indexerKeys, MARKET_CATALOG_REFETCH_MS } from "@/hooks/useIndexer";
import { appConfig } from "@/lib/config";
import {
  CHART_OHLCV_INTERVAL,
  CHART_OHLCV_INTERVAL_MS,
  CHART_OHLCV_LOOKBACK_MS,
  deepbookPairForAsset,
  fetchDeepbookOhlcv,
} from "@/lib/deepbook/ohlcv";
import {
  fetchGlobalMarketTrades,
  fetchMarketCatalog,
  fetchPointsLeaderboard,
  fetchProtocolSettings,
  fetchVaultHistory,
  fetchVaultSummary,
} from "@/lib/leverx/indexer-client";
import { baseFromUnderlying } from "@/lib/markets";
import { fetchOraclePriceLatest, fetchOracleState } from "@/lib/predict/client";
import { getPredictOracleRows, predictOraclesQueryKey } from "@/lib/predict/oracle-cache";
import type { PredictOracleSummary } from "@/lib/predict/types";
import type { ProtocolSettings } from "@/lib/leverx/indexer-client";

const indexerEnabled = Boolean(appConfig.leverxIndexerUrl);

async function safeEnsure<T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(`[LeverX loader] ${label}`, error);
    }
    return fallback;
  }
}

export async function ensurePredictOracles(queryClient: QueryClient) {
  const protocol = await ensureIndexerProtocol(queryClient);
  const predictId = protocol?.predict_id?.trim() || appConfig.predictId;
  return safeEnsure("predict-oracles", [] as PredictOracleSummary[], () =>
    queryClient.ensureQueryData({
      queryKey: predictOraclesQueryKey(predictId),
      queryFn: () => getPredictOracleRows(predictId),
      staleTime: 300_000,
    }),
  );
}

export async function ensureIndexerProtocol(queryClient: QueryClient) {
  if (!indexerEnabled) return null;
  return safeEnsure("indexer-protocol", null as ProtocolSettings | null, () =>
    queryClient.ensureQueryData({
      queryKey: indexerKeys.protocol,
      queryFn: fetchProtocolSettings,
      staleTime: 60_000,
    }),
  );
}

export async function ensureMarketCatalog(
  queryClient: QueryClient,
  args?: { oracleId?: string; limit?: number },
) {
  if (!indexerEnabled) return [];
  return safeEnsure("market-catalog", [], () =>
    queryClient.ensureQueryData({
      queryKey: indexerKeys.catalog(args?.oracleId, undefined),
      queryFn: async () => {
        const { items } = await fetchMarketCatalog({
          oracleId: args?.oracleId,
          limit: args?.limit ?? (args?.oracleId ? 200 : 1000),
          offset: 0,
        });
        return items;
      },
      staleTime: MARKET_CATALOG_REFETCH_MS / 2,
    }),
  );
}

export async function ensureVaultSummary(queryClient: QueryClient, vaultId: string) {
  if (!indexerEnabled || !vaultId) return null;
  return safeEnsure("vault-summary", null, () =>
    queryClient.ensureQueryData({
      queryKey: indexerKeys.vaultSummary(vaultId),
      queryFn: () => fetchVaultSummary(vaultId),
      staleTime: 60_000,
    }),
  );
}

export async function ensureVaultHistory(queryClient: QueryClient, vaultId: string) {
  if (!indexerEnabled || !vaultId) return [];
  return safeEnsure("vault-history", [], () =>
    queryClient.ensureQueryData({
      queryKey: indexerKeys.vaultHistory(vaultId),
      queryFn: async () => {
        const { items } = await fetchVaultHistory(vaultId, 200);
        return items;
      },
      staleTime: 60_000,
    }),
  );
}

export async function ensurePointsLeaderboard(queryClient: QueryClient, limit = 100) {
  if (!indexerEnabled) return [];
  return safeEnsure("points-leaderboard", [], () =>
    queryClient.ensureQueryData({
      queryKey: indexerKeys.leaderboard(limit),
      queryFn: async () => {
        const { items } = await fetchPointsLeaderboard({ limit, offset: 0 });
        return items;
      },
      staleTime: 30_000,
    }),
  );
}

export async function ensureOracleState(queryClient: QueryClient, oracleId: string) {
  if (!oracleId) return null;
  return safeEnsure("oracle-state", null, () =>
    queryClient.ensureQueryData({
      queryKey: ["predict-oracle-state", oracleId],
      queryFn: () => fetchOracleState(oracleId),
      staleTime: 60_000,
    }),
  );
}

export async function ensureOraclePriceLatest(queryClient: QueryClient, oracleId: string) {
  if (!oracleId) return null;
  return safeEnsure("oracle-price-latest", null, () =>
    queryClient.ensureQueryData({
      queryKey: oraclePriceLatestQueryKey(oracleId),
      queryFn: () => fetchOraclePriceLatest(oracleId),
      staleTime: 2_500,
    }),
  );
}

export async function ensureGlobalTrades(queryClient: QueryClient, oracleId: string) {
  if (!indexerEnabled || !oracleId) return [];
  return safeEnsure("global-trades", [], () =>
    queryClient.ensureQueryData({
      queryKey: indexerKeys.globalTrades(oracleId),
      queryFn: async () => {
        const { items } = await fetchGlobalMarketTrades(oracleId, { limit: 200 });
        return items;
      },
      staleTime: 15_000,
    }),
  );
}

export async function ensureChartOhlcv(queryClient: QueryClient, asset: string) {
  const pair = deepbookPairForAsset(asset);
  if (!pair) return null;
  return safeEnsure("chart-ohlcv", null, () =>
    queryClient.ensureQueryData({
      queryKey: ["deepbook-ohlcv", pair, CHART_OHLCV_INTERVAL],
      queryFn: async () => {
        const endTime = Date.now();
        const startTime = endTime - CHART_OHLCV_LOOKBACK_MS;
        return fetchDeepbookOhlcv(pair, CHART_OHLCV_INTERVAL, startTime, endTime);
      },
      staleTime: CHART_OHLCV_INTERVAL_MS / 2,
    }),
  );
}

function chartAssetForOracle(oracles: readonly PredictOracleSummary[], oracleId: string): string {
  const oracle = oracles.find((o) => o.oracle_id === oracleId);
  return baseFromUnderlying(oracle?.underlying_asset ?? "") || oracleId.slice(2, 6).toUpperCase();
}

/**
 * Resolve to null if `p` hasn't settled within `ms`.
 *
 * Used to keep route loaders from waiting on services that may not exist in a
 * given deployment. `Promise.allSettled` is not enough on its own: a request
 * that hangs (or a query that keeps retrying) never settles at all.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Hydrate optional caches for the `_app` shell — and never block on them.
 *
 * Both of these reach upstream infrastructure inherited from the app this UI
 * was forked from (a Sui indexer on :3100 and Sui fullnode oracles). Molfi on
 * Flare reads its markets from the Molfi backend and settles via FTSOv2, so
 * neither service exists here.
 *
 * This previously did `await Promise.all([...])`. When those requests hang or
 * keep retrying, the layout loader never resolves — and because every screen
 * (markets, portfolio, vault, leaderboard, guide) lives under `_app`, the whole
 * app sits on its pending skeletons indefinitely. The data is optional, so the
 * shell must render regardless of whether it arrives.
 */
export async function loadAppShell(_queryClient: QueryClient) {
  // Nothing to prefetch. Time-boxing the two dead Sui requests kept the shell
  // from hanging, but it still cost up to 2s of dead latency on the critical
  // path of every screen — and `predict-server.testnet.mystenlabs.com` does not
  // resolve at all. Neither cache has a reachable consumer: the only one is
  // `useIndexerProtocol()` inside MarketLeverageBadge, which issues its own
  // non-blocking query and renders null anyway (leverageEnabled === false).
  return null;
}

export async function loadMarketsRoute(queryClient: QueryClient) {
  const [, , protocol] = await Promise.all([
    ensurePredictOracles(queryClient),
    ensureMarketCatalog(queryClient),
    ensureIndexerProtocol(queryClient),
    ensureChartOhlcv(queryClient, "BTC"),
  ]);
  const vaultId = protocol?.vault_id;
  if (vaultId) {
    await ensureVaultSummary(queryClient, vaultId);
  }
}

export async function loadVaultRoute(queryClient: QueryClient) {
  const protocol = await ensureIndexerProtocol(queryClient);
  const vaultId = protocol?.vault_id;
  if (!vaultId) return;
  await Promise.all([
    ensureVaultSummary(queryClient, vaultId),
    ensureVaultHistory(queryClient, vaultId),
  ]);
}

export async function loadPointsRoute(queryClient: QueryClient) {
  await ensurePointsLeaderboard(queryClient);
}

export async function loadPredictTradeRoute(queryClient: QueryClient, oracleId: string) {
  const [oracles] = await Promise.all([
    ensurePredictOracles(queryClient),
    ensureOracleState(queryClient, oracleId),
    ensureMarketCatalog(queryClient, { oracleId }),
    ensureGlobalTrades(queryClient, oracleId),
    ensureOraclePriceLatest(queryClient, oracleId),
    ensureIndexerProtocol(queryClient),
  ]);

  const asset = chartAssetForOracle(oracles, oracleId);
  await ensureChartOhlcv(queryClient, asset);
}
