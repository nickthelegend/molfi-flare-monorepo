/**
 * Testnet integration — see:
 * - docs/DEEPBOOK_PREDICT.md (workshop FAQ)
 * - https://docs.sui.io/onchain-finance/deepbook-predict/contract-information
 * Predict testnet expirations: 1, 2, 7, 14, 21 days.
 *
 * Defaults mirror `contracts/deploy-testnet.env` (publish tx G848YC…).
 * Shared object IDs (registry, vault, fee collector) come from the indexer
 * `/v1/protocol` after `deploy_and_share`, or optional `VITE_LEVERX_*` env vars.
 */

/**
 * DeepBook Predict testnet (predict-testnet-4-16).
 *
 * Only the two fields that survive on Flare are kept. The object ids that used
 * to live here — and the whole TESTNET_LEVERX block — were deleted because
 * nothing may default to another chain's live deployment; see the note on
 * `predictId` below.
 */
const TESTNET_PREDICT = {
  quoteType:
    "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
} as const;

function viteEnv(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The upstream Sui indexer / keeper hosts are NOT defaulted.
 *
 * Molfi settles on Flare and has no leverx-server behind it, but these
 * resolvers used to fall back to hardcoded hosts — so a production build opened
 * a persistent WebSocket to `wss://indexer.suileverx.xyz` and issued REST calls
 * to `keeper.suileverx.xyz`, a live third party serving a different Sui
 * deployment's ids. Locally it retry-looped forever, painting red WebSocket
 * errors in the console a judge opens.
 *
 * Returning "" makes every downstream `indexerEnabled` / `indexerStreamEnabled`
 * gate false, so nothing connects. Setting VITE_LEVERX_* still turns it back on
 * for anyone who actually runs an indexer.
 */

/** True when REST `/v1/*` is served by the keeper proxy (not leverx-server directly). */
export function isKeeperApiUrl(url: string): boolean {
  try {
    const { hostname, port } = new URL(url);
    if (port === "3001") return true;
    return hostname.startsWith("keeper.");
  } catch {
    return false;
  }
}

function resolveLeverxApiUrl(): string {
  const keeper = viteEnv("VITE_LEVERX_KEEPER_URL");
  if (keeper) return keeper;
  const indexer = viteEnv("VITE_LEVERX_INDEXER_URL");
  if (indexer) return indexer;
  return "";
}

function resolveLeverxWsUrl(apiUrl: string): string | null {
  const explicit = viteEnv("VITE_LEVERX_INDEXER_WS_URL");
  if (explicit) {
    const trimmed = explicit.replace(/\/$/, "");
    return trimmed.endsWith("/v1/ws") ? trimmed : `${trimmed}/v1/ws`;
  }
  if (!apiUrl) return null;

  const explicitIndexer = viteEnv("VITE_LEVERX_INDEXER_URL");
  const wsBase =
    isKeeperApiUrl(apiUrl) && explicitIndexer && !isKeeperApiUrl(explicitIndexer)
      ? explicitIndexer
      : apiUrl;
  if (!wsBase) return null;

  return `${wsBase.replace(/^http/i, "ws").replace(/\/$/, "")}/v1/ws`;
}

const leverxApiUrl = resolveLeverxApiUrl();
const leverxIndexerWsUrl = resolveLeverxWsUrl(leverxApiUrl);

function resolveKeeperApiUrl(leverxApiUrl: string): string {
  const explicit = viteEnv("VITE_LEVERX_KEEPER_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  if (isKeeperApiUrl(leverxApiUrl)) return leverxApiUrl.replace(/\/$/, "");
  return "";
}

const keeperApiUrl = resolveKeeperApiUrl(leverxApiUrl);

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = viteEnv(name).toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return defaultValue;
}

function resolveFirebaseConfig():
  | {
      apiKey: string;
      authDomain: string;
      projectId: string;
      storageBucket: string;
      messagingSenderId: string;
      appId: string;
      measurementId?: string;
    }
  | null {
  const apiKey = viteEnv("VITE_FIREBASE_API_KEY");
  const projectId = viteEnv("VITE_FIREBASE_PROJECT_ID");
  if (!apiKey || !projectId) return null;

  return {
    apiKey,
    authDomain: viteEnv("VITE_FIREBASE_AUTH_DOMAIN"),
    projectId,
    storageBucket: viteEnv("VITE_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: viteEnv("VITE_FIREBASE_MESSAGING_SENDER_ID"),
    appId: viteEnv("VITE_FIREBASE_APP_ID"),
    measurementId: viteEnv("VITE_FIREBASE_MEASUREMENT_ID") || undefined,
  };
}

export const appConfig = {
  suiNetwork: "testnet" as const,

  /** Env-only, for the same reason as the object ids below. */
  predictServerUrl: viteEnv("VITE_PREDICT_SERVER_URL"),

  /**
   * The Sui object ids are NOT defaulted, for the same reason the indexer hosts
   * above are not.
   *
   * Defaulting `leverxRegistryId` to a live testnet object made
   * `useLeverxProtocolConfig`'s `enabled: Boolean(registryId)` gate true on
   * every page load, so the header and the markets grid issued `sui_getObject`
   * calls to fullnode.testnet.sui.io — a different chain, from an app that
   * settles on Flare. They always failed, and `useVisibleMarketAsks` already
   * documents that having no order-book config is the NORMAL state here
   * (Molfi's markets are pari-mutuel, priced from FTSOv2).
   *
   * Empty means every downstream `enabled` gate is false and no request is
   * made. Anyone actually running the Sui deployment sets VITE_PREDICT_ID /
   * VITE_LEVERX_* and gets the old behaviour back.
   */
  predictId: viteEnv("VITE_PREDICT_ID"),
  predictPackageId: viteEnv("VITE_PREDICT_PACKAGE_ID"),
  predictRegistryId: viteEnv("VITE_PREDICT_REGISTRY_ID"),
  quoteType: TESTNET_PREDICT.quoteType,

  leverxPackageId: viteEnv("VITE_LEVERX_PACKAGE_ID"),
  leverxRegistryId: viteEnv("VITE_LEVERX_REGISTRY_ID"),
  leverxVaultId: viteEnv("VITE_LEVERX_VAULT_ID"),
  feeCollectorId: viteEnv("VITE_LEVERX_FEE_COLLECTOR_ID"),

  /** Optional fallback when indexer has not indexed keeper_address yet. */
  keeperAddress: viteEnv("VITE_KEEPER_ADDRESS"),

  /** Optional shared secret for keeper ops routes (not required for user-signed relay). */
  keeperApiKey: viteEnv("VITE_KEEPER_API_KEY"),

  /** Telegram bot username for portfolio alert subscriptions (without @). */
  telegramBotUsername: viteEnv("VITE_TELEGRAM_BOT_USERNAME"),

  /** Enoki public API key — when set, zkLogin wallets are registered at startup. */
  enokiApiKey: viteEnv("VITE_ENOKI_API_KEY"),
  enokiGoogleClientId: viteEnv("VITE_ENOKI_GOOGLE_CLIENT_ID"),

  /** Vault/manager legacy paths; oracle catalog always uses predictServerUrl. */
  usePredictServer: false,

  /**
   * LeverX REST API base — keeper proxies `/v1/*` to leverx-server in production/docker.
   * WebSocket live streams still use `leverxIndexerWsUrl` (keeper does not proxy WS).
   */
  leverxIndexerUrl: leverxApiUrl,

  /** Keeper HTTP base (trade relay, manager create, health). */
  keeperApiUrl,

  /** Direct leverx-server WebSocket endpoint (`/v1/ws`). */
  leverxIndexerWsUrl,

  /** Keeper Jarvis activity WebSocket (Socket.IO namespace `/jarvis`). */
  // Guarded: an empty base would otherwise yield the relative URL "/jarvis",
  // which reads as "configured" downstream.
  jarvisWsUrl: keeperApiUrl ? `${keeperApiUrl.replace(/\/$/, "")}/jarvis` : "",

  /** True when `leverxIndexerWsUrl` is configured (streams require direct indexer host). */
  indexerStreamEnabled: Boolean(leverxIndexerWsUrl),

  /**
   * DeepBook spot OHLCV (chart visualization only) — env-only, no default.
   *
   * This defaulted to `deepbook-indexer.mainnet.mystenlabs.com`, a Sui mainnet
   * host, and shipped in the bundle. Molfi charts price from FTSOv2 via its own
   * backend; nothing here should ever reach a Sui service. Empty disables the
   * fetch outright (see `fetchDeepbookOhlcv`).
   */
  deepbookIndexerUrl: viteEnv("VITE_DEEPBOOK_INDEXER_URL"),

  /** Vertical RANGE instruments in trade UI and market actions. */
  rangeEnabled: false,

  /** Leverage controls (slider, badges, leveraged-mint window). Off = 1x spot only. */
  leverageEnabled: false,

  /** Firebase web app config for market comments (Firestore). */
  firebase: resolveFirebaseConfig(),
} as const;

/** True when Google zkLogin can be registered via Enoki at startup. */
export function isEnokiGoogleLoginEnabled(): boolean {
  return Boolean(appConfig.enokiApiKey && appConfig.enokiGoogleClientId);
}
