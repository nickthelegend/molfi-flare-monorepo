import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Swiper, SwiperSlide } from "swiper/react";
import type { Swiper as SwiperType } from "swiper";
import { FeaturedMarketCard } from "@/components/leverx/FeaturedMarketCard";
import { LoadingState } from "@/components/ui/loading-state";
import { useMarketsUpDisplay } from "@/hooks/useMarketsUpDisplay";
import type { LeverxMarketRow } from "@/lib/leverx/indexer-markets";
import { MarketTitle } from "@/components/leverx/MarketTitle";
import { ui } from "@/lib/copy";
import { cn } from "@/lib/utils";

import "swiper/css";

interface Props {
  markets: LeverxMarketRow[];
  loading?: boolean;
  className?: string;
}

export function TopMarketsSwiper({ markets, loading, className }: Props) {
  const swiperRef = useRef<SwiperType | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const { sourceById, displayMarkets } = useMarketsUpDisplay(markets);

  const slides = useMemo(() => {
    const byId = new Map(displayMarkets.map((market) => [market.id, market]));
    return markets.map((market) => byId.get(market.id) ?? market);
  }, [displayMarkets, markets]);

  const loop = slides.length > 1;
  const prevMarket = loop
    ? slides[(activeIndex - 1 + slides.length) % slides.length]
    : null;
  const nextMarket = loop
    ? slides[(activeIndex + 1) % slides.length]
    : null;

  if (loading) {
    return (
      <div className={cn("top-markets-swiper top-markets-swiper--loading", className)}>
        <div className="featured-market-card featured-market-card--skeleton" aria-hidden>
          <div className="featured-market-card-skeleton-body" />
        </div>
        <LoadingState label={ui.loadingMarkets} compact className="absolute inset-0 z-10" />
      </div>
    );
  }

  if (slides.length === 0) {
    return null;
  }

  return (
    <div className={cn("top-markets-swiper", className)}>
      <Swiper
        className="top-markets-swiper-inner"
        slidesPerView={1}
        spaceBetween={5}
        loop={loop}
        watchOverflow
        onSwiper={(swiper) => {
          swiperRef.current = swiper;
        }}
        onSlideChange={(swiper) => {
          setActiveIndex(swiper.realIndex);
        }}
      >
        {slides.map((display) => {
          const source = sourceById.get(display.id) ?? display;
          return (
            <SwiperSlide key={display.id} className="top-markets-slide">
              <FeaturedMarketCard market={display} sourceMarket={source} />
            </SwiperSlide>
          );
        })}
      </Swiper>

      {loop ? (
        <div className="top-markets-controls" aria-label="Featured market navigation">
          <div className="featured-market-dots">
            {slides.map((_, index) => (
              <button
                key={index}
                type="button"
                className={cn(
                  "featured-market-dot",
                  index === activeIndex && "featured-market-dot--active",
                )}
                aria-label={`Go to market ${index + 1}`}
                aria-current={index === activeIndex ? "true" : undefined}
                onClick={() => swiperRef.current?.slideToLoop(index)}
              />
            ))}
          </div>

          <div className="markets-hero-nav">
            <button
              type="button"
              className="markets-hero-nav-btn"
              onClick={() => swiperRef.current?.slidePrev()}
              aria-label={prevMarket ? `Previous: ${prevMarket.question ?? prevMarket.asset}` : "Previous market"}
            >
              <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">
                {/* `<MarketTitle />` with no props falls back to the LeverX
                    constant "Bitcoin Up, Down, or Range" — on every market. */}
                {prevMarket ? <MarketTitle title={prevMarket.question ?? prevMarket.asset} /> : "Previous"}
              </span>
            </button>
            <button
              type="button"
              className="markets-hero-nav-btn"
              onClick={() => swiperRef.current?.slideNext()}
              aria-label={nextMarket ? `Next: ${nextMarket.question ?? nextMarket.asset}` : "Next market"}
            >
              <span className="truncate">
                {nextMarket ? <MarketTitle title={nextMarket.question ?? nextMarket.asset} /> : "Next"}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
