import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BarChart3, CloudOff } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { MarketGridSkeleton } from "@/components/ui/market-skeleton";
import { AssetBadge } from "@/components/AssetBadge";
import { MarketFavoriteButton } from "@/components/leverx/MarketFavoriteButton";
import { MarketPremiumQuote } from "@/components/leverx/MarketPremiumQuote";
import { MarketSideActions } from "@/components/leverx/MarketSideActions";
import { SentimentBar } from "@/components/leverx/SentimentBar";
import { useMarketsUpDisplay } from "@/hooks/useMarketsUpDisplay";
import {
  MARKETS_GRID_PAGE_SIZE,
  MarketCatalogPagination,
  paginateSlice,
} from "@/components/leverx/MarketCatalogPagination";
import type { ReactNode } from "react";
import { AnimatedCompactUsd, AnimatedMarketPremium } from "@/components/ui/animated-numbers";
import { MarketTradeLink } from "@/components/leverx/MarketTradeLink";
import { premiumToCents, type LeverxMarketRow } from "@/lib/leverx/indexer-markets";
import { MarketTitle } from "@/components/leverx/MarketTitle";
import { ui } from "@/lib/copy";
import {
  landingCtaSecondary,
  marketCard,
  marketCardActions,
  marketCardBody,
  marketCardHeader,
  marketCardInteractive,
  marketCardMeta,
  marketCardOverlay,
  marketCardPrice,
  marketCardPriceValue,
  marketsGrid,
  pageState,
} from "@/lib/leverx/tw";
import { formatAutoClose } from "@/lib/leverx/placeholders";
import { MarketLeverageBadges } from "@/components/leverx/MarketLeverageBadges";
import { useNow } from "@/hooks/useNow";
import { cn } from "@/lib/utils";

interface Props {
  markets: LeverxMarketRow[];
  offline?: boolean;
  /** Why the chain is unreachable, when it is. */
  offlineMessage?: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function PredictMarketsGrid({
  markets,
  offline,
  offlineMessage,
  emptyTitle = ui.emptyMarkets,
  emptyDescription = ui.emptyMarketsHint,
}: Props) {
  const [page, setPage] = useState(1);

  const marketIdsKey = useMemo(
    () => markets.map((market) => market.id).join(","),
    [markets],
  );

  useEffect(() => {
    setPage(1);
  }, [marketIdsKey]);

  const { items: pageMarkets, page: currentPage, totalPages, totalItems } = useMemo(
    () => paginateSlice(markets, page, MARKETS_GRID_PAGE_SIZE),
    [markets, page],
  );

  const { sourceById, displayMarkets, premiumLoading, seriesByMarketId } =
    useMarketsUpDisplay(pageMarkets);
  const now = useNow(1000);

  if (markets.length === 0 && !offline) {
    return (
      <div className={pageState}>
        <EmptyState
          icon={BarChart3}
          title={emptyTitle}
          description={emptyDescription}
          action={
            <Link to="/guide" className={cn(landingCtaSecondary, "text-sm")}>
              Learn how markets work
            </Link>
          }
        />
      </div>
    );
  }

  if (markets.length === 0 && offline) {
    // Was an endless <MarketGridSkeleton />, which reads as a hung page — the
    // shimmer never resolves because the chain, not the render, is the problem.
    // Say so, and let the 15s poll recover on its own.
    return (
      <div className={pageState}>
        <EmptyState
          icon={CloudOff}
          title="Can't reach Coston2"
          description={
            offlineMessage ??
            "Flare's RPC isn't responding. Markets will reappear on their own — this page keeps retrying."
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className={marketsGrid}>
        {displayMarkets.map((display) => {
          const source = sourceById.get(display.id) ?? display;

          return (
            <article key={display.id} className={marketCard}>
              <MarketTradeLink
                market={display}
                side="up"
                className={marketCardOverlay}
                aria-hidden
                tabIndex={-1}
              />
              <div className={marketCardBody}>
                <div className={marketCardHeader}>
                  <AssetBadge asset={display.asset} iconUrl={display.iconUrl} size="sm" />
                  <MarketTradeLink
                    market={display}
                    side="up"
                    className={cn(marketCardInteractive, "min-w-0 flex-1 no-underline")}
                  >
                    <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground transition-colors hover:text-accent">
                      <MarketTitle title={display.question} />
                    </p>
                    <MarketLeverageBadges
                      expiryMs={display.expiry}
                      now={now}
                      quotePaused={display.quotePaused}
                    />
                  </MarketTradeLink>
                  <MarketTradeLink
                    market={display}
                    side="up"
                    className={cn(marketCardInteractive, marketCardPrice, "no-underline")}
                  >
                    <div className={marketCardPriceValue}>
                      <AnimatedMarketPremium
                        premium={display.lastAskPremium}
                        quotePaused={display.quotePaused}
                        loading={
                          premiumLoading &&
                          !display.quotePaused &&
                          (display.lastAskPremium == null || display.lastAskPremium <= 0)
                        }
                      />
                    </div>
                  </MarketTradeLink>
                </div>

                {/* SentimentBar takes 0-100. `lastAskPremium` is the RAW 1e9
                    probability, so passing it straight through clamped every
                    card to "YES 100% / NO 0%".
                    `>= 0`, not `> 0`: a market that resolved NO prices YES at
                    exactly 0, which is a known outcome, not a missing quote. */}
                <SentimentBar
                  yesPct={
                    display.lastAskPremium != null && display.lastAskPremium >= 0
                      ? premiumToCents(display.lastAskPremium)
                      : null
                  }
                  compact
                />

                <div className={marketCardActions}>
                  {/*
                    A settled market must not offer UP/DOWN. The contract already
                    refuses a bet after close, but the card was still rendering
                    two tradeable buttons on a decided market — and showed no
                    outcome or settle price at all. Say what happened instead.
                  */}
                  {source.onchainStatus === 2 ? (
                    <div className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
                      <span
                        className={cn(
                          "font-semibold",
                          source.onchainOutcome === 0
                            ? "text-[var(--long-text)]"
                            : source.onchainOutcome === 1
                              ? "text-[var(--short-text)]"
                              : "text-muted-foreground",
                        )}
                      >
                        {source.onchainOutcome === 0
                          ? "Settled YES"
                          : source.onchainOutcome === 1
                            ? "Settled NO"
                            : "Settled"}
                      </span>
                      {source.settlePrice != null ? (
                        <span className="font-mono text-muted-foreground">
                          at{" "}
                          {source.settlePrice >= 100
                            ? `$${source.settlePrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                            : `$${source.settlePrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}`}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">awaiting settlement</span>
                      )}
                    </div>
                  ) : (
                    <MarketSideActions market={source} stretch className="w-full" />
                  )}
                </div>

                <div className={marketCardMeta}>
                  <span>
                    {source.volume > 0 ? (
                      <>
                        <AnimatedCompactUsd value={source.volume} /> Vol
                      </>
                    ) : (
                      <span className="text-muted-foreground/70">No bets yet</span>
                    )}
                  </span>
                  <div className={cn(marketCardInteractive, "flex items-center gap-2")}>
                    <span>{display.expiry ? formatAutoClose(display.expiry) : "—"}</span>
                    <MarketFavoriteButton
                      marketId={source.id}
                      size="sm"
                      className="h-7 w-7 min-w-7 p-0"
                      iconClassName="h-3 w-3"
                    />
                  </div>
                </div>
              </div>

              <MarketPremiumQuote
                variant="band"
                footer
                series={seriesByMarketId.get(display.id) ?? []}
                lastAskPremium={display.lastAskPremium}
                premiumLoading={premiumLoading}
                quotePaused={display.quotePaused}
              />
            </article>
          );
        })}
      </div>
      <MarketCatalogPagination
        page={currentPage}
        totalPages={totalPages}
        totalItems={totalItems}
        pageSize={MARKETS_GRID_PAGE_SIZE}
        onPageChange={setPage}
      />
    </div>
  );
}
