import type { ComponentProps, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useTradeNavigation } from "@/context/TradeNavigationContext";
import type { LeverxMarketRow } from "@/lib/leverx/indexer-markets";
import {
  marketTradeIntent,
  positionTradeIntent,
  type MarketTradeIntent,
} from "@/lib/leverx/market-trade-intent";
import type { PredictSide } from "@/lib/predict/instruments";

/**
 * The anchor props these wrappers forward to `<Link>`.
 *
 * `Omit<ComponentProps<typeof Link>, "to" | "params">` collapsed TanStack's
 * generic Link union into a shape that no longer knew about the
 * `/predictions/$oracleId` params, so `params={{ oracleId }}` errored and every
 * spread through these wrappers errored with it. `to` and `params` are written
 * literally inside `TradeIntentLink` — where TanStack infers them correctly —
 * so callers only ever need the plain anchor props.
 */
type LinkProps = Omit<ComponentProps<"a">, "href">;

function TradeIntentLink({
  intent,
  onClick,
  ...props
}: LinkProps & { intent: MarketTradeIntent; children?: ReactNode }) {
  const { setPendingTrade } = useTradeNavigation();

  return (
    <Link
      to="/predictions/$oracleId"
      params={{ oracleId: intent.oracleId }}
      onClick={(event) => {
        setPendingTrade(intent);
        onClick?.(event);
      }}
      {...props}
    />
  );
}

export function MarketTradeLink({
  market,
  side,
  ...props
}: LinkProps & { market: LeverxMarketRow; side?: PredictSide }) {
  return (
    <TradeIntentLink intent={marketTradeIntent(market, side)} {...props} />
  );
}

export function PositionTradeLink({
  position,
  ...props
}: LinkProps & {
  position: {
    position_key: string;
    oracle_id: string;
    strike: number;
    higher_strike: number;
    is_up: boolean;
    is_range: boolean;
  };
}) {
  return (
    <TradeIntentLink intent={positionTradeIntent(position)} {...props} />
  );
}
