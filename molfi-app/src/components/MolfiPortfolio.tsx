import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react";
import { AssetBadge } from "@/components/AssetBadge";
import { PnlChart, type PnlPoint } from "@/components/PnlChart";
import { EmptyState } from "@/components/ui/empty-state";
import {
  fetchPositions,
  fetchOnChainPositionsForWallet,
  fetchOnChainMarkets,
  fetchBackendMarkets,
  type BackendPosition,
} from "@/lib/molfi-backend";
import { cn } from "@/lib/utils";

/**
 * Format an FXRP amount.
 *
 * Two decimals is wrong for this asset: FXRP carries 6 (XRP drops), and a real
 * escrowed stake of 0.001 renders as "0.00" — the position looks empty when it
 * is not. Show more precision only when the number actually needs it, so
 * ordinary amounts stay readable.
 */
const fmt = (n: number) => {
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 6 : 2;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
};
const signed = (n: number) => `${n >= 0 ? "+" : ""}${fmt(n)}`;
const pnlClass = (n: number) =>
  n > 0 ? "text-[var(--long-text)]" : n < 0 ? "text-[var(--short-text)]" : "text-muted-foreground";

/** The only market fields the portfolio rows consume. */
interface MarketMeta {
  yesPrice: number | null;
  icon?: string;
}

interface Row extends BackendPosition {
  market?: MarketMeta;
  currentSidePrice: number | null;
  value: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

function SideBadge({ side }: { side: "yes" | "no" }) {
  const yes = side === "yes";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase",
        yes
          ? "bg-[var(--long-bg)] text-[var(--long-text)]"
          : "bg-[var(--short-bg)] text-[var(--short-text)]",
      )}
    >
      {yes ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {side}
    </span>
  );
}

function Stat({
  label,
  value,
  sub,
  valueNum,
}: {
  label: string;
  value: string;
  sub?: string;
  /** When provided, the value is colored as a P&L figure (green/red/neutral). */
  valueNum?: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono text-xl font-semibold",
          valueNum === undefined ? "text-foreground" : pnlClass(valueNum),
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function MolfiPortfolio({ address }: { address: string }) {
  const { data: backendPositions = [], isLoading } = useQuery({
    queryKey: ["molfi-positions", address],
    queryFn: () => fetchPositions(address),
    refetchInterval: 15_000,
  });
  // Bets placed directly on-chain (wallet → PredictEscrow) never touch the
  // backend's log, so the portfolio has to read the escrow too — otherwise a
  // real, escrowed stake shows as "No trades yet".
  const { data: chainPositions = [] } = useQuery({
    queryKey: ["molfi-onchain-positions", address],
    queryFn: () => fetchOnChainPositionsForWallet(address),
    refetchInterval: 15_000,
  });

  const positions = useMemo<BackendPosition[]>(() => {
    const seen = new Set(backendPositions.map((p) => `${p.marketId}:${p.side}`));
    const fromChain = chainPositions
      .filter((p) => !seen.has(`${p.marketId}:${p.side}`))
      .map<BackendPosition>((p) => ({
        _id: `onchain:${p.marketId}:${p.side}`,
        marketId: p.marketId,
        symbol: p.symbol,
        question: p.question,
        address,
        side: p.side,
        amount: p.amount,
        // Entry price is not recorded on-chain. Leaving it 0 makes the P&L
        // math fall back to "value = stake" rather than inventing a basis.
        entryPrice: 0,
        status: p.status,
        won: p.won ?? undefined,
        payout: p.payout,
        createdAt: p.closeTs,
        settledAt: p.resolved ? p.closeTs : undefined,
      }));
    return [...backendPositions, ...fromChain];
  }, [backendPositions, chainPositions, address]);
  const { data: openMarkets = [] } = useQuery({
    queryKey: ["molfi-backend-markets", "open"],
    queryFn: () => fetchBackendMarkets("open"),
    refetchInterval: 15_000,
  });
  // On-chain positions carry bytes32 market ids, which never match the
  // backend's `SYM-15m-strike-ts` _ids. Without this second source the "Now"
  // column was "—" for every position a user can actually open, since the
  // markets grid is fed exclusively by on-chain markets.
  const { data: openChainMarkets = [] } = useQuery({
    queryKey: ["molfi-onchain-markets", "open"],
    queryFn: () => fetchOnChainMarkets("open"),
    refetchInterval: 15_000,
  });

  const marketsById = useMemo(() => {
    const m = new Map<string, MarketMeta>();
    for (const mk of openMarkets) m.set(mk._id.toLowerCase(), { yesPrice: mk.yesPrice, icon: mk.icon });
    for (const mk of openChainMarkets)
      m.set(mk.marketId.toLowerCase(), { yesPrice: mk.yesPrice ?? null, icon: mk.icon });
    return m;
  }, [openMarkets, openChainMarkets]);

  const rows = useMemo<Row[]>(() => {
    return positions.map((p) => {
      // Lowercased on both sides: ids reach this map from two sources whose
      // hex casing is not guaranteed to agree.
      const market = marketsById.get(p.marketId.toLowerCase());
      const currentYes = market?.yesPrice ?? null;
      const currentSidePrice =
        currentYes == null ? null : p.side === "yes" ? currentYes : 1 - currentYes;
      const value =
        currentSidePrice != null && p.entryPrice > 0
          ? p.amount * (currentSidePrice / p.entryPrice)
          : p.amount;
      const unrealizedPnl = p.status === "open" ? value - p.amount : 0;
      const realizedPnl =
        p.status === "settled"
          ? (p.pnl ?? (p.won ? (p.payout ?? 0) - p.amount : -p.amount))
          : 0;
      return { ...p, market, currentSidePrice, value, unrealizedPnl, realizedPnl };
    });
  }, [positions, marketsById]);

  const open = rows.filter((r) => r.status === "open");
  const settled = rows.filter((r) => r.status === "settled");

  const summary = useMemo(() => {
    const realized = settled.reduce((s, r) => s + r.realizedPnl, 0);
    const unrealized = open.reduce((s, r) => s + r.unrealizedPnl, 0);
    const openStake = open.reduce((s, r) => s + r.amount, 0);
    const wins = settled.filter((r) => r.won).length;
    const winRate = settled.length ? Math.round((wins / settled.length) * 100) : 0;
    const volume = rows.reduce((s, r) => s + r.amount, 0);
    return { realized, unrealized, openStake, wins, winRate, volume };
  }, [open, settled, rows]);

  // Cumulative realized-PnL curve from this trader's own settled trades only.
  const pnlPoints = useMemo<PnlPoint[]>(() => {
    const chrono = [...settled].sort(
      (a, b) => (a.settledAt ?? a.createdAt ?? 0) - (b.settledAt ?? b.createdAt ?? 0),
    );
    if (chrono.length === 0) return [];
    let cum = 0;
    const pts: PnlPoint[] = [
      { ts: (chrono[0].createdAt ?? chrono[0].settledAt ?? 0) - 1000, value: 0 },
    ];
    for (const r of chrono) {
      cum += r.realizedPnl;
      pts.push({ ts: r.settledAt ?? r.createdAt ?? 0, value: Math.round(cum * 100) / 100 });
    }
    return pts;
  }, [settled]);

  if (!isLoading && positions.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <EmptyState
          icon={Activity}
          title="No trades yet"
          description="Place your first bet on a market and it will show up here with live indicative P&L."
          action={
            <Link to="/markets" className="btn-connect gap-1.5 text-sm">
              Browse markets
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Realized P&L"
          value={`${signed(summary.realized)} FXRP`}
          sub="settled trades"
          valueNum={summary.realized}
        />
        <Stat
          label="Open exposure"
          value={`${fmt(summary.openStake)} FXRP`}
          sub={`${open.length} open position${open.length === 1 ? "" : "s"}`}
        />
        <Stat
          label="Unrealized P&L"
          value={`${signed(summary.unrealized)} FXRP`}
          sub="indicative · open trades"
          valueNum={summary.unrealized}
        />
        <Stat
          label="Win rate"
          value={`${summary.winRate}%`}
          sub={`${summary.wins}/${settled.length} settled`}
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Indicative P&L</h2>
          <span
            className={cn(
              "font-mono text-lg font-semibold",
              pnlClass(summary.realized + summary.unrealized),
            )}
          >
            {signed(summary.realized + summary.unrealized)} FXRP
          </span>
        </div>
        {pnlPoints.length > 1 ? (
          <PnlChart points={pnlPoints} height={220} />
        ) : (
          <div className="flex h-[220px] flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <Activity className="h-5 w-5 text-muted-foreground/60" />
            Your realized-P&L curve appears once your first market settles.
          </div>
        )}
        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          This curve is built only from your own trades. Other traders&apos; positions are never
          revealed — order books and odds you see elsewhere are aggregate, zero-knowledge interest.
        </p>
      </div>

      {open.length > 0 ? (
        <PositionsTable
          title="Open positions"
          rows={open}
          columns={["Market", "Side", "Stake", "Entry", "Now", "Indicative P&L"]}
          render={(r) => (
            <>
              <td className="px-3 py-2 text-right font-mono">{fmt(r.amount)}</td>
              <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                {/* On-chain positions have no recorded entry price. Rendering
                    the 0 placeholder as "0¢" reads as a real basis. */}
                {r.entryPrice > 0 ? `${(r.entryPrice * 100).toFixed(0)}¢` : "—"}
              </td>
              <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                {r.currentSidePrice != null ? `${(r.currentSidePrice * 100).toFixed(0)}¢` : "—"}
              </td>
              <td className={cn("px-3 py-2 text-right font-mono", pnlClass(r.unrealizedPnl))}>
                {signed(r.unrealizedPnl)}
              </td>
            </>
          )}
        />
      ) : null}

      {settled.length > 0 ? (
        <PositionsTable
          title="Settled positions"
          rows={settled}
          columns={["Market", "Side", "Stake", "Result", "Payout", "Realized P&L"]}
          render={(r) => (
            <>
              <td className="px-3 py-2 text-right font-mono">{fmt(r.amount)}</td>
              <td className="px-3 py-2 text-right">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase",
                    r.won
                      ? "bg-[var(--long-bg)] text-[var(--long-text)]"
                      : "bg-[var(--short-bg)] text-[var(--short-text)]",
                  )}
                >
                  {r.won ? "Won" : "Lost"}
                </span>
              </td>
              <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                {fmt(r.payout ?? 0)}
              </td>
              <td className={cn("px-3 py-2 text-right font-mono", pnlClass(r.realizedPnl))}>
                {signed(r.realizedPnl)}
              </td>
            </>
          )}
        />
      ) : null}
    </div>
  );
}

function PositionsTable({
  title,
  rows,
  columns,
  render,
}: {
  title: string;
  rows: Row[];
  columns: string[];
  render: (r: Row) => React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
              {columns.map((c, i) => (
                <th key={c} className={cn("px-3 py-2 font-medium", i === 0 ? "text-left" : "text-right")}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <Link
                    to="/predictions/$oracleId"
                    params={{ oracleId: r.marketId }}
                    className="flex items-center gap-2 no-underline"
                  >
                    <AssetBadge asset={r.symbol} iconUrl={r.market?.icon} size="sm" />
                    <span className="line-clamp-1 max-w-[260px] text-foreground hover:text-accent">
                      {r.question}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2 text-right">
                  <span className="inline-flex justify-end">
                    <SideBadge side={r.side} />
                  </span>
                </td>
                {render(r)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
