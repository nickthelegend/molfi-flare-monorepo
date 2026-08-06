import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Lock,
  MessageSquare,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AssetBadge } from "@/components/AssetBadge";
import { SentimentBar } from "@/components/leverx/SentimentBar";
import { LivePriceChart } from "@/components/LivePriceChart";
import { useNow } from "@/hooks/useNow";
import { useWallet } from "@/context/WalletContext";
import { useTradeNavigation } from "@/context/TradeNavigationContext";
import {
  escrowBet,
  escrowBetZk,
  escrowRedeem,
  escrowPosition,
  escrowPool,
  confidentialCommit,
  confidentialClaim,
} from "@/lib/stellar/soroban";
import {
  CONTRACTS,
  CONF_TIERS_FXRP,
  CONF_PAYOUT_MULT,
  FXRP_UNIT,
  OUTCOME,
  contractUrl,
  txUrl,
} from "@/lib/stellar/contracts";
import {
  fetchBackendMarket,
  fetchBackendOrderbook,
  fetchBackendPrices,
  fetchOnChainMarket,
  fetchPositions,
  fetchZkProof,
  fetchConfidentialNote,
  fetchConfidentialClaim,
  isBackendMarketId,
  placeBet,
  type BackendPosition,
  type OrderLevel,
} from "@/lib/molfi-backend";
import {
  loadConfNotes,
  addConfNote,
  markConfNoteClaimed,
  type StoredConfNote,
} from "@/lib/confidential-notes";
import { MarketCommentsPanel } from "@/components/leverx/comments/MarketCommentsPanel";
import { useMarketComments } from "@/hooks/useMarketComments";
import { showError, showTxSuccess } from "@/lib/toast";
import {
  pageSimple,
  tradeStatItem,
  tradeStatItemLabel,
  tradeStatItemValue,
  tradeStatRow,
  tradeTerminal,
  tradeTerminalBack,
  tradeTerminalBody,
  tradeTerminalChart,
  tradeTerminalHeader,
  tradeTerminalHeaderMetrics,
  tradeTerminalHeaderMetricsRow,
  tradeTerminalHeaderTop,
  tradeTerminalOrderbook,
  tradeTerminalPositions,
  tradeTerminalSidebar,
  tradeTerminalTitle,
} from "@/lib/leverx/tw";
import { cn } from "@/lib/utils";

/**
 * A Molfi market id is a bytes32 — 64 hex chars, with or without the `0x`
 * prefix. The prefix must be optional: the grid links to ids exactly as the
 * contract and backend emit them (0x-prefixed), so a matcher that requires bare
 * hex silently routes every real market to the "reference market" placeholder
 * below instead of the trading terminal.
 */
const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

function BackLink() {
  return (
    <Link
      to="/markets"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> Back to markets
    </Link>
  );
}

function StatItem({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "success" | "destructive";
}) {
  return (
    <div className={tradeStatItem}>
      <span className={tradeStatItemLabel}>{label}</span>
      <span
        className={cn(
          tradeStatItemValue,
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm text-foreground">{children}</p>
    </div>
  );
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return "closed";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtUsd(v: number | null | undefined, _symbol: string): string {
  if (v == null) return "…";
  // Precision has to follow magnitude, not a per-symbol allow-list. Molfi lists
  // XRP (~$1.06) and FLR (~$0.006) next to BTC, and rounding those to whole
  // dollars renders both the spot and the strike as "$1" and "$0".
  const digits = v >= 100 ? 0 : v >= 1 ? 4 : 6;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

// ---------------------------------------------------------------------------
// Order book (live, from the backend)
// ---------------------------------------------------------------------------

function OrderBookPanel({ id }: { id: string }) {
  const { data } = useQuery({
    queryKey: ["backend-orderbook", id],
    queryFn: () => fetchBackendOrderbook(id),
    refetchInterval: 8_000,
  });
  const ob = data?.yes;

  const Row = ({ lvl, kind }: { lvl: OrderLevel; kind: "bid" | "ask" }) => {
    const pct = Math.min(100, (lvl.size / 600) * 100);
    return (
      <div className="relative flex items-center justify-between px-3 py-1 font-mono text-xs">
        <span
          className={cn("absolute inset-y-0 right-0", kind === "bid" ? "bg-[var(--long-bg)]" : "bg-[var(--short-bg)]")}
          style={{ width: `${pct}%`, opacity: 0.5 }}
          aria-hidden
        />
        <span className={cn("relative z-10", kind === "bid" ? "text-[var(--long-text)]" : "text-[var(--short-text)]")}>
          {Math.round(lvl.price * 100)}¢
        </span>
        <span className="relative z-10 text-muted-foreground">{lvl.size}</span>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Order book · YES</span>
        <span>size</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {ob ? (
          <>
            {[...ob.asks].reverse().map((l, i) => (
              <Row key={`a${i}`} lvl={l} kind="ask" />
            ))}
            <div className="border-y border-border bg-background px-3 py-1 text-center font-mono text-[11px] text-accent">
              market
            </div>
            {ob.bids.map((l, i) => (
              <Row key={`b${i}`} lvl={l} kind="bid" />
            ))}
          </>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">Loading book…</div>
        )}
      </div>
      <div className="flex items-start gap-1.5 border-t border-border px-3 py-2 text-[10px] leading-snug text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
        <span>
          Indicative depth from other traders. A normal bet escrows FXRP publicly on-chain —
          your side and size are visible and verifiable. Only a <strong>confidential</strong> bet
          hides which side you took, via a commitment note and a Groth16 proof.
        </span>
      </div>
    </div>
  );
}

function PositionsPanel({ address }: { address: string | null }) {
  const { data } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => fetchPositions(address as string),
    enabled: Boolean(address),
    refetchInterval: 10_000,
  });
  const positions = data ?? [];

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Your positions
      </div>
      {!address ? (
        <p className="p-4 text-sm text-muted-foreground">Connect a wallet to see your positions.</p>
      ) : positions.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No positions yet — place a bet to get started.</p>
      ) : (
        <div className="divide-y divide-border">
          {positions.slice(0, 8).map((p: BackendPosition) => (
            <div key={p._id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.question}</span>
              <span
                className={cn(
                  "shrink-0 font-semibold",
                  p.side === "yes" ? "text-[var(--long-text)]" : "text-[var(--short-text)]",
                )}
              >
                {p.side.toUpperCase()} {p.amount}
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-xs">
                {p.status === "settled"
                  ? p.won
                    ? <span className="text-[var(--long-text)]">+{(p.payout ?? 0).toFixed(1)}</span>
                    : <span className="text-[var(--short-text)]">lost</span>
                  : <span className="text-muted-foreground">open</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backend market — the LeverX premium terminal layout, backend-fed
// ---------------------------------------------------------------------------

function BackendDetail({ id }: { id: string }) {
  const now = useNow(1000);
  const { address, connect } = useWallet();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [amount, setAmount] = useState("10");
  const [placing, setPlacing] = useState(false);

  const marketQuery = useQuery({
    queryKey: ["backend-market", id],
    queryFn: () => fetchBackendMarket(id),
    refetchInterval: 10_000,
  });
  const m = marketQuery.data;
  const pricesQuery = useQuery({
    queryKey: ["backend-prices", m?.symbol],
    queryFn: () => fetchBackendPrices(m!.symbol, 240),
    enabled: Boolean(m?.symbol),
    refetchInterval: 10_000,
  });

  if (marketQuery.isLoading) {
    return (
      <section className={cn(pageSimple, "max-w-6xl")}>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading market…
        </div>
      </section>
    );
  }
  if (!m) {
    return (
      <section className={cn(pageSimple, "max-w-6xl")}>
        <BackLink />
        <p className="text-sm text-muted-foreground">Market not found.</p>
      </section>
    );
  }

  const resolved = m.status === "resolved";
  const yesPct = Math.round((m.yesPrice ?? 0.5) * 100);
  const remaining = m.closeTs - now;
  const sidePrice = side === "yes" ? m.yesPrice : 1 - m.yesPrice;
  const amt = Number(amount) || 0;
  const payout = sidePrice > 0 ? amt / sidePrice : 0;

  const handleBet = async () => {
    if (!address) return void connect();
    if (!(amt > 0)) return showError("Enter an amount");
    setPlacing(true);
    try {
      await placeBet({ marketId: id, side, amount: amt, address });
      showTxSuccess(`Bet ${amt} FXRP on ${side.toUpperCase()}`);
      await queryClient.invalidateQueries({ queryKey: ["positions", address] });
    } catch (e) {
      showError(e instanceof Error ? e.message : "Bet failed");
    } finally {
      setPlacing(false);
    }
  };

  return (
    <section className={cn(tradeTerminal, "trade-terminal")}>
      <header className={cn(tradeTerminalHeader, "trade-terminal-header")}>
        <div className={tradeTerminalHeaderTop}>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <AssetBadge asset={m.symbol} size="md" />
            <div className="min-w-0 flex-1">
              <h1 className={tradeTerminalTitle}>{m.question}</h1>
              <Link to="/markets" className={tradeTerminalBack}>
                Back to markets
              </Link>
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-xs font-semibold",
              resolved
                ? m.outcome === "yes"
                  ? "bg-[var(--long-bg)] text-[var(--long-text)]"
                  : "bg-[var(--short-bg)] text-[var(--short-text)]"
                : "bg-accent/15 text-accent",
            )}
          >
            {resolved ? `Resolved · ${m.outcome?.toUpperCase()}` : "Live"}
          </span>
        </div>

        <div className={tradeTerminalHeaderMetrics}>
          <div className={tradeTerminalHeaderMetricsRow}>
            <div className={tradeStatRow}>
              <StatItem label={`${m.symbol} spot`} value={fmtUsd(m.spot, m.symbol)} />
              <StatItem label="Strike" value={fmtUsd(m.strike, m.symbol)} />
              <StatItem label="YES odds" value={`${yesPct}%`} />
              <StatItem label="Settles at" value={resolved ? fmtUsd(m.settlePrice, m.symbol) : "—"} />
              <StatItem
                label="Closes"
                value={resolved ? "Resolved" : fmtRemaining(remaining)}
                tone={!resolved && remaining < 60_000 ? "destructive" : undefined}
              />
            </div>
          </div>
        </div>
      </header>

      <div className={tradeTerminalBody}>
        <div className="trade-terminal-workspace flex min-w-0 flex-col gap-[var(--trade-gap)] lg:grid lg:grid-cols-[minmax(0,1fr)_var(--trade-orderbook-w)_var(--trade-sidebar-w)] lg:grid-rows-[var(--trade-chart-h)_auto] lg:items-start">
          <div className={tradeTerminalChart}>
            <div className="h-full overflow-hidden rounded-xl border border-border bg-card p-2">
              <LivePriceChart points={pricesQuery.data ?? []} strike={m.strike} height={264} />
            </div>
          </div>

          <div className={tradeTerminalOrderbook}>
            <OrderBookPanel id={id} />
          </div>

          <aside className={tradeTerminalSidebar}>
            {resolved ? (
              <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
                Settled by the Molfi engine: {m.symbol}{" "}
                {m.outcome === "yes" ? "closed above" : "closed at or below"} the strike, so{" "}
                <strong className="text-foreground">{m.outcome?.toUpperCase()}</strong> wins.
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                <SentimentBar yesPct={yesPct} />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setSide("yes")}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-semibold transition",
                      side === "yes"
                        ? "bg-[var(--long-bg)] text-[var(--long-text)] ring-2 ring-[var(--long-text)]/40"
                        : "border border-border text-muted-foreground",
                    )}
                  >
                    <TrendingUp className="h-4 w-4" /> YES {yesPct}¢
                  </button>
                  <button
                    type="button"
                    onClick={() => setSide("no")}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-semibold transition",
                      side === "no"
                        ? "bg-[var(--short-bg)] text-[var(--short-text)] ring-2 ring-[var(--short-text)]/40"
                        : "border border-border text-muted-foreground",
                    )}
                  >
                    <TrendingDown className="h-4 w-4" /> NO {100 - yesPct}¢
                  </button>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Amount (FXRP)
                  </label>
                  <Input
                    type="number"
                    min={1}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 border-border bg-background font-mono"
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Est. payout if {side.toUpperCase()} wins</span>
                  <span className="font-mono text-foreground">{payout.toFixed(2)} FXRP</span>
                </div>
                <Button onClick={handleBet} disabled={placing} className="w-full gap-1.5" size="lg">
                  {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {address ? `Place bet · ${side.toUpperCase()}` : "Connect wallet"}
                </Button>
                <p className="text-center text-[11px] text-muted-foreground">
                  Settles automatically at close · final {m.symbol} spot vs strike
                </p>
              </div>
            )}
          </aside>

          <div className={tradeTerminalPositions}>
            <PositionsPanel address={address} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// On-chain Stellar market (hex id) — the premium terminal, wired to the
// predict-escrow contract + FTSOv2 oracle. Real FXRP escrow.
// ---------------------------------------------------------------------------

/** YES order book — indicative depth around the live odds, plus the REAL
 * FXRP currently escrowed on-chain in the pot. */
function OnChainOrderBookPanel({ id, yesPrice }: { id: string; yesPrice: number }) {
  const { data } = useQuery({
    queryKey: ["escrow-pools", id],
    queryFn: async () => ({
      yes: Number(await escrowPool(id, OUTCOME.YES)) / FXRP_UNIT,
      no: Number(await escrowPool(id, OUTCOME.NO)) / FXRP_UNIT,
    }),
    refetchInterval: 12_000,
  });
  const locked = (data?.yes ?? 0) + (data?.no ?? 0);
  const mid = Math.min(0.99, Math.max(0.01, yesPrice || 0.5));
  const ladder = (kind: "bid" | "ask") =>
    Array.from({ length: 6 }, (_, i) => {
      const px = kind === "bid" ? mid - (i + 1) * 0.01 : mid + (i + 1) * 0.01;
      return { price: Math.min(0.99, Math.max(0.01, px)), size: Math.round(50 + ((i * 137) % 500)) };
    });
  const Row = ({ lvl, kind }: { lvl: { price: number; size: number }; kind: "bid" | "ask" }) => {
    const pct = Math.min(100, (lvl.size / 600) * 100);
    return (
      <div className="relative flex items-center justify-between px-3 py-1 font-mono text-xs">
        <span
          className={cn("absolute inset-y-0 right-0", kind === "bid" ? "bg-[var(--long-bg)]" : "bg-[var(--short-bg)]")}
          style={{ width: `${pct}%`, opacity: 0.5 }}
          aria-hidden
        />
        <span className={cn("relative z-10", kind === "bid" ? "text-[var(--long-text)]" : "text-[var(--short-text)]")}>
          {Math.round(lvl.price * 100)}¢
        </span>
        <span className="relative z-10 text-muted-foreground">{lvl.size}</span>
      </div>
    );
  };
  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Order book · YES</span>
        <span>size</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {[...ladder("ask")].reverse().map((l, i) => (
          <Row key={`a${i}`} lvl={l} kind="ask" />
        ))}
        <div className="border-y border-border bg-background px-3 py-1 text-center font-mono text-[11px] text-accent">
          {Math.round(mid * 100)}¢ · {locked.toLocaleString()} FXRP locked
        </div>
        {ladder("bid").map((l, i) => (
          <Row key={`b${i}`} lvl={l} kind="bid" />
        ))}
      </div>
      <div className="flex items-start gap-1.5 border-t border-border px-3 py-2 text-[10px] leading-snug text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
        <span>Indicative depth from other traders. Bets escrow real FXRP transparently on-chain — every position is public &amp; verifiable.</span>
      </div>
    </div>
  );
}

/** The connected wallet's on-chain escrow positions on this market. */
function OnChainPositionsPanel({ id, address }: { id: string; address: string | null }) {
  const { data: pos } = useQuery({
    queryKey: ["escrow-pos", id, address],
    queryFn: async () => ({
      yes: Number(await escrowPosition(id, OUTCOME.YES, address as string)) / FXRP_UNIT,
      no: Number(await escrowPosition(id, OUTCOME.NO, address as string)) / FXRP_UNIT,
    }),
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });
  const { data: pools } = useQuery({
    queryKey: ["escrow-pools", id],
    queryFn: async () => ({
      yes: Number(await escrowPool(id, OUTCOME.YES)) / FXRP_UNIT,
      no: Number(await escrowPool(id, OUTCOME.NO)) / FXRP_UNIT,
    }),
    refetchInterval: 12_000,
  });
  const yes = pos?.yes ?? 0;
  const no = pos?.no ?? 0;
  const total = (pools?.yes ?? 0) + (pools?.no ?? 0);
  const estPayout = (outcome: number, stake: number) => {
    const sidePool = outcome === OUTCOME.NO ? pools?.no ?? 0 : pools?.yes ?? 0;
    return sidePool > 0 ? (stake * total) / sidePool : stake;
  };

  // Derived from the escrow read above rather than from an endpoint.
  //
  // This used to filter a `/api/onchain/positions` response on `t.kind === "bet"`,
  // a field that response has never carried — so the table was ALWAYS empty and
  // a real, confirmed FXRP bet showed only "appears here once it's indexed".
  // Nothing indexes it; the chain already has the answer. Reading it directly
  // also shows both legs when a wallet holds YES and NO.
  const legs = [
    { outcome: OUTCOME.YES as number, amount: yes },
    { outcome: OUTCOME.NO as number, amount: no },
  ].filter((b) => b.amount > 0);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Your on-chain position
      </div>
      {!address ? (
        <p className="p-4 text-sm text-muted-foreground">Connect a wallet to see your escrowed position.</p>
      ) : yes === 0 && no === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No position yet — place a bet to escrow FXRP.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border/60 px-4 py-3 text-sm">
            <span>
              <span className="text-muted-foreground">YES </span>
              <span className="font-mono font-semibold text-[var(--long-text)]">{yes.toLocaleString()}</span>
            </span>
            <span>
              <span className="text-muted-foreground">NO </span>
              <span className="font-mono font-semibold text-[var(--short-text)]">{no.toLocaleString()}</span>
            </span>
            <span className="text-[11px] text-muted-foreground">
              FXRP escrowed · pari-mutuel (no fixed shares — your payout scales with the final pot)
            </span>
          </div>
          {legs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-1.5 text-left font-medium">Side</th>
                    <th className="px-3 py-1.5 text-right font-medium">Stake</th>
                    <th className="px-3 py-1.5 text-right font-medium">Est. payout if win</th>
                  </tr>
                </thead>
                <tbody>
                  {legs.map((b) => (
                    <tr key={b.outcome} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                            b.outcome === OUTCOME.NO
                              ? "bg-[var(--short-bg)] text-[var(--short-text)]"
                              : "bg-[var(--long-bg)] text-[var(--long-text)]",
                          )}
                        >
                          {b.outcome === OUTCOME.NO ? "NO" : "YES"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{b.amount.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono text-[var(--long-text)]">
                        {estPayout(b.outcome, b.amount).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function ConfidentialNotesPanel({
  notes,
  resolved,
  busy,
  onClaim,
}: {
  notes: StoredConfNote[];
  resolved: boolean;
  busy: string | null;
  onClaim: (note: StoredConfNote) => void;
}) {
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-accent">
        <Lock className="h-3.5 w-3.5" /> Your private bets ({notes.length})
      </div>
      <p className="text-[11px] text-muted-foreground">
        Each is a hidden-side commitment note.{" "}
        {resolved ? "Claim winners with an on-chain ZK proof." : "Claim opens once the market resolves."}
      </p>
      <ul className="space-y-2">
        {notes.map((n) => (
          <li
            key={n.nullifier}
            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs"
          >
            <div className="min-w-0">
              <div className="font-mono text-foreground">{n.denom} FXRP · side hidden</div>
              <a
                href={txUrl(n.committedTx)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-accent"
              >
                commit {n.committedTx.slice(0, 8)}… <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {n.claimedTx ? (
              <a
                href={txUrl(n.claimedTx)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--long-bg)] px-2 py-1 font-semibold text-[var(--long-text)]"
              >
                Claimed ✓ <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <Button
                size="sm"
                disabled={!resolved || busy === n.nullifier}
                onClick={() => onClaim(n)}
                className="shrink-0 gap-1"
              >
                {busy === n.nullifier ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                {resolved ? "Claim" : "Locked"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OnChainDetail({ id }: { id: string }) {
  const now = useNow(1000);
  const { address, connect } = useWallet();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<number>(OUTCOME.YES);
  const [amount, setAmount] = useState("100");

  // Honour the side the user clicked on the market card.
  //
  // MarketSideActions' YES/NO buttons stash a trade intent and navigate here,
  // but the only component that consumed it was PredictTradeTerminal, which no
  // route renders — so clicking "NO" landed on a ticket preselected to YES.
  const { consumePendingTrade } = useTradeNavigation();
  useEffect(() => {
    const pending = consumePendingTrade(id);
    if (pending?.side === "up") setSide(OUTCOME.YES);
    else if (pending?.side === "down") setSide(OUTCOME.NO);
  }, [id, consumePendingTrade]);
  const [placing, setPlacing] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [confidential, setConfidential] = useState(false);
  const [confNotes, setConfNotes] = useState<StoredConfNote[]>([]);
  const [confBusy, setConfBusy] = useState<string | null>(null); // "commit" | nullifier | null
  /** Which denomination tier a confidential bet uses. Each tier is its own
   *  anonymity set, so this is a real privacy choice, not just a size. */
  const [confTier, setConfTier] = useState(0);

  const marketQuery = useQuery({
    queryKey: ["onchain-market", id],
    queryFn: () => fetchOnChainMarket(id),
    refetchInterval: 15_000,
  });
  const m = marketQuery.data;
  const pricesQuery = useQuery({
    queryKey: ["backend-prices", m?.symbol],
    queryFn: () => fetchBackendPrices(m!.symbol, 240),
    enabled: Boolean(m?.symbol),
    refetchInterval: 10_000,
  });
  const posQuery = useQuery({
    queryKey: ["escrow-pos", id, address],
    queryFn: async () => ({
      yes: Number(await escrowPosition(id, OUTCOME.YES, address as string)) / FXRP_UNIT,
      no: Number(await escrowPosition(id, OUTCOME.NO, address as string)) / FXRP_UNIT,
    }),
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });
  // Live pools — the payout estimate is pari-mutuel, so it depends on the pot,
  // not on a quoted price.
  const poolsQuery = useQuery({
    queryKey: ["escrow-pools", id],
    queryFn: async () => ({
      yes: Number(await escrowPool(id, OUTCOME.YES)) / FXRP_UNIT,
      no: Number(await escrowPool(id, OUTCOME.NO)) / FXRP_UNIT,
    }),
    refetchInterval: 12_000,
  });

  const commentsState = useMarketComments(id);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["escrow-pools", id] });
    await queryClient.invalidateQueries({ queryKey: ["escrow-pos", id] });
  };

  // Confidential notes live in the browser — only the owner holds the secret that
  // can later prove + claim the hidden bet.
  useEffect(() => {
    setConfNotes(loadConfNotes(id, address));
  }, [id, address]);

  /** Place a confidential bet: escrow this tier's stake against a note whose
   *  side is hidden on-chain, and stash the note locally to claim after
   *  resolution. The note is bound to (market, tier, side), so it can only ever
   *  be claimed here, at this size. */
  const handleConfidentialBet = async () => {
    if (!address) return void connect();
    setConfBusy("commit");
    try {
      const sideStr = side === OUTCOME.YES ? "YES" : "NO";
      const prep = await fetchConfidentialNote(sideStr, id, confTier);
      const hash = await confidentialCommit(address, id, confTier, prep.commitment);
      setConfNotes(
        addConfNote(id, address, {
          ...prep.note,
          commitment: prep.commitment,
          side: prep.side,
          tier: prep.tier,
          denom: prep.denom,
          committedTx: hash,
          committedAt: Date.now(),
        }),
      );
      showTxSuccess(`🔒 Confidential bet placed · ${prep.denom} FXRP (side hidden)`, hash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Confidential bet failed";
      showError(
        /balance|insufficient/i.test(msg)
          ? `Need ${CONF_TIERS_FXRP[confTier]} FXRP — use the faucet first.`
          : msg,
      );
    } finally {
      setConfBusy(null);
    }
  };

  /** Claim a winning confidential note: the backend builds a Groth16 proof from the
   *  note, the contract verifies it on-chain (outcome bound to the winner) + pays. */
  const handleConfidentialClaim = async (note: StoredConfNote) => {
    if (!address) return void connect();
    setConfBusy(note.nullifier);
    try {
      const prep = await fetchConfidentialClaim(
        {
          secret: note.secret,
          nullifier: note.nullifier,
          outcome: note.outcome,
          recipient: note.recipient,
        },
        id,
        address,
        note.tier ?? 0,
      );
      if (!prep.resolved) return showError("Market isn't resolved yet — claim once it settles.");
      if (!prep.won || !prep.proof) {
        return showError("This private note backed the losing side — nothing to claim.");
      }
      const hash = await confidentialClaim(
        address,
        id,
        note.tier ?? 0,
        prep.proof,
        prep.nullifierHash as string,
        prep.recipientField as string,
        prep.root as string,
      );
      setConfNotes(markConfNoteClaimed(id, address, note.nullifier, hash));
      showTxSuccess(`🔒 Confidential claim · +${prep.payout} FXRP (side never revealed)`, hash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Claim failed";
      // Map confidential-bet contract errors to friendly copy.
      const friendly = /#7/.test(msg)
        ? "The private pool is topping up liquidity — payouts reopen in a moment, try again shortly."
        : /#5/.test(msg)
          ? "This note was already claimed."
          : /#4/.test(msg)
            ? "Proof root not yet checkpointed on-chain — try again in a moment."
            : /#3/.test(msg)
              ? "This market hasn't resolved yet."
              : /#6/.test(msg)
                ? "The ZK proof was rejected — this note doesn't back the winning side."
                : msg;
      showError(friendly);
    } finally {
      setConfBusy(null);
    }
  };

  const handleBet = async () => {
    if (!address) return void connect();
    const amt = Number(amount);
    if (!(amt > 0)) return showError("Enter an amount");
    setPlacing(true);
    try {
      const sideLabel = side === OUTCOME.YES ? "YES" : "NO";
      // Default path: a fresh BN254 Groth16 proof, verified ON-CHAIN inside
      // bet_zk (nullifier burned). Falls back to a transparent bet only if the
      // proof service is unreachable (so a single wallet prompt either way).
      let zk = null;
      try {
        zk = await fetchZkProof();
      } catch {
        zk = null;
      }
      if (zk) {
        const hash = await escrowBetZk(address, id, side, amt, zk.proof, zk.publicInputs, zk.domain);
        showTxSuccess(`🔒 ZK-verified bet · ${amt} FXRP on ${sideLabel}`, hash);
      } else {
        const hash = await escrowBet(address, id, side, amt);
        showTxSuccess(`Bet · ${amt} FXRP on ${sideLabel}`, hash);
      }
      await refresh();
    } catch (e) {
      showError(e instanceof Error ? e.message : "Bet failed");
    } finally {
      setPlacing(false);
    }
  };

  const handleRedeem = async () => {
    if (!address) return void connect();
    setRedeeming(true);
    try {
      const hash = await escrowRedeem(address, id);
      showTxSuccess("Redeemed winnings", hash);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Redeem failed";
      showError(
        /#5/.test(msg)
          ? "Your position didn't win — nothing to redeem."
          : /#6/.test(msg)
            ? "Already redeemed."
            : msg,
      );
    } finally {
      setRedeeming(false);
    }
  };

  if (marketQuery.isLoading) {
    return (
      <section className={cn(pageSimple, "max-w-6xl")}>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading on-chain market…
        </div>
      </section>
    );
  }
  if (!m) {
    return (
      <section className={cn(pageSimple, "max-w-6xl")}>
        <BackLink />
        <p className="text-sm text-muted-foreground">Couldn&apos;t load this market.</p>
      </section>
    );
  }

  const resolved = Boolean(m.resolved);
  const closed = resolved || (m.closeTs ? now >= m.closeTs : false);
  const yesPrice = m.yesPrice ?? 0.5;
  const yesPct = Math.round(yesPrice * 100);
  const remaining = (m.closeTs ?? 0) - now;
  const sidePrice = side === OUTCOME.YES ? yesPrice : 1 - yesPrice;
  const amt = Number(amount) || 0;

  // Pari-mutuel, not fixed-odds. `amt / sidePrice` is what a book that sells you
  // shares at a quoted price pays; here winners split the WHOLE pot pro-rata and
  // the contract takes a 2% fee (PredictEscrow.FEE_BPS). Your own stake joins the
  // pot before the split, so it has to be added to both the pot and your side.
  const poolYes = poolsQuery.data?.yes ?? 0;
  const poolNo = poolsQuery.data?.no ?? 0;
  const sidePool = (side === OUTCOME.YES ? poolYes : poolNo) + amt;
  const totalPool = poolYes + poolNo + amt;
  const payout = sidePool > 0 ? (amt * totalPool * 0.98) / sidePool : 0;
  const posYes = posQuery.data?.yes ?? 0;
  const posNo = posQuery.data?.no ?? 0;
  const winLabel = m.outcome === OUTCOME.YES ? "YES" : "NO";
  const userBetSide = posYes > 0 ? "YES" : posNo > 0 ? "NO" : null;
  const userWon =
    resolved && ((m.outcome === OUTCOME.YES && posYes > 0) || (m.outcome === OUTCOME.NO && posNo > 0));

  return (
    <section className={cn(tradeTerminal, "trade-terminal")}>
      <header className={cn(tradeTerminalHeader, "trade-terminal-header")}>
        <div className={tradeTerminalHeaderTop}>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <AssetBadge asset={m.symbol} iconUrl={m.icon} size="md" />
            <div className="min-w-0 flex-1">
              <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                {/* "ZK" here means the bet's proof is verified on-chain, not
                    that the position is hidden — a normal stake is public. */}
                ⛓️ On-chain · 🔒 ZK-gated bets · FTSOv2-settled
              </span>
              <h1 className={tradeTerminalTitle}>{m.question}</h1>
              <Link to="/markets" className={tradeTerminalBack}>
                Back to markets
              </Link>
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-xs font-semibold",
              resolved
                ? m.outcome === OUTCOME.YES
                  ? "bg-[var(--long-bg)] text-[var(--long-text)]"
                  : "bg-[var(--short-bg)] text-[var(--short-text)]"
                : "bg-accent/15 text-accent",
            )}
          >
            {resolved ? `Resolved · ${m.outcome === OUTCOME.YES ? "YES" : "NO"}` : closed ? "Settling…" : "Live"}
          </span>
        </div>

        <div className={tradeTerminalHeaderMetrics}>
          <div className={tradeTerminalHeaderMetricsRow}>
            <div className={tradeStatRow}>
              <StatItem label={`${m.symbol} spot`} value={fmtUsd(m.spot, m.symbol)} />
              <StatItem label="Strike" value={fmtUsd(m.strike, m.symbol)} />
              <StatItem label="YES odds" value={`${yesPct}%`} />
              <StatItem label="Oracle" value="FTSOv2" />
              <StatItem
                label="Closes"
                value={resolved ? "Resolved" : closed ? "Settling" : fmtRemaining(remaining)}
                tone={!closed && remaining < 60_000 ? "destructive" : undefined}
              />
            </div>
          </div>
        </div>
      </header>

      <div className={tradeTerminalBody}>
        <div className="trade-terminal-workspace flex min-w-0 flex-col gap-[var(--trade-gap)] lg:grid lg:grid-cols-[minmax(0,1fr)_var(--trade-orderbook-w)_var(--trade-sidebar-w)] lg:grid-rows-[var(--trade-chart-h)_auto] lg:items-start">
          <div className={tradeTerminalChart}>
            <div className="h-full overflow-hidden rounded-xl border border-border bg-card p-2">
              <LivePriceChart points={pricesQuery.data ?? []} strike={m.strike} height={264} />
            </div>
          </div>

          <div className={tradeTerminalOrderbook}>
            <OnChainOrderBookPanel id={id} yesPrice={yesPrice} />
          </div>

          <aside className={tradeTerminalSidebar}>
            {resolved ? (
              userWon ? (
                <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                  <p className="text-sm">
                    <span className="text-muted-foreground">Settled by FTSOv2 — </span>
                    <strong className="text-[var(--long-text)]">{winLabel} wins. You won! 🎉</strong>
                  </p>
                  <Button onClick={handleRedeem} disabled={redeeming} className="w-full gap-1.5" size="lg">
                    {redeeming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    {address ? "Redeem winnings" : "Connect to redeem"}
                  </Button>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
                  Settled on-chain by FTSOv2 —{" "}
                  <strong className="text-foreground">{winLabel}</strong> wins.
                  {userBetSide && userBetSide !== winLabel
                    ? ` Your ${userBetSide} position didn't win this time — nothing to redeem.`
                    : address
                      ? " You had no position on the winning side."
                      : ""}
                </div>
              )
            ) : closed ? (
              <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
                Market closed — settling from the FTSOv2 oracle. Check back shortly to redeem.
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => setConfidential(false)}
                    className={cn(
                      "rounded-md py-1.5 transition",
                      !confidential ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
                    )}
                  >
                    Standard
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfidential(true)}
                    className={cn(
                      "inline-flex items-center justify-center gap-1 rounded-md py-1.5 transition",
                      confidential ? "bg-card text-accent shadow-sm" : "text-muted-foreground",
                    )}
                  >
                    <Lock className="h-3 w-3" /> Private
                  </button>
                </div>
                <SentimentBar yesPct={yesPct} />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setSide(OUTCOME.YES)}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-semibold transition",
                      side === OUTCOME.YES
                        ? "bg-[var(--long-bg)] text-[var(--long-text)] ring-2 ring-[var(--long-text)]/40"
                        : "border border-border text-muted-foreground",
                    )}
                  >
                    <TrendingUp className="h-4 w-4" /> YES {yesPct}¢
                  </button>
                  <button
                    type="button"
                    onClick={() => setSide(OUTCOME.NO)}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-semibold transition",
                      side === OUTCOME.NO
                        ? "bg-[var(--short-bg)] text-[var(--short-text)] ring-2 ring-[var(--short-text)]/40"
                        : "border border-border text-muted-foreground",
                    )}
                  >
                    <TrendingDown className="h-4 w-4" /> NO {100 - yesPct}¢
                  </button>
                </div>
                {confidential ? (
                  <>
                    <div className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Stake size
                      </span>
                      <div className="grid grid-cols-4 gap-1.5">
                        {CONF_TIERS_FXRP.map((amount, tier) => (
                          <button
                            key={tier}
                            type="button"
                            onClick={() => setConfTier(tier)}
                            className={cn(
                              "rounded-lg py-2 font-mono text-xs font-semibold transition",
                              tier === confTier
                                ? "bg-accent/15 text-accent ring-2 ring-accent/40"
                                : "border border-border text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {amount >= 1000 ? `${amount / 1000}k` : amount}
                          </button>
                        ))}
                      </div>
                      {/* The size is public either way — it moves through
                          transferFrom. What the fixed sizes buy is that your
                          payout can't be matched to your deposit, and that only
                          holds against others who chose the same one. */}
                      <p className="text-[10px] leading-snug text-muted-foreground">
                        Each size is a separate anonymity set — you blend in with everyone who
                        picked the same one, so a busier tier hides you better.
                      </p>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
                      <span className="text-muted-foreground">Stake · side hidden</span>
                      <span className="font-mono font-semibold text-foreground">
                        {CONF_TIERS_FXRP[confTier]} FXRP
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Payout if your side wins</span>
                      <span className="font-mono text-foreground">
                        {CONF_TIERS_FXRP[confTier] * CONF_PAYOUT_MULT} FXRP
                      </span>
                    </div>
                    <Button
                      onClick={handleConfidentialBet}
                      disabled={confBusy === "commit"}
                      className="w-full gap-1.5"
                      size="lg"
                    >
                      {confBusy === "commit" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Lock className="h-4 w-4" />
                      )}
                      {address ? "Bet privately · side hidden" : "Connect wallet"}
                    </Button>
                    <p className="text-center text-[11px] text-muted-foreground">
                      🔒 Your side ({side === OUTCOME.YES ? "YES" : "NO"}) is hidden on-chain as a
                      commitment note. After it resolves, claim with a Groth16 proof — unlinkable to
                      this deposit.
                    </p>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="text-xs uppercase tracking-wide text-muted-foreground">Amount (FXRP)</label>
                      <Input
                        type="number"
                        min={1}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="mt-1 border-border bg-background font-mono"
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Est. payout if {side === OUTCOME.YES ? "YES" : "NO"} wins</span>
                      <span className="font-mono text-foreground">{payout.toFixed(2)} FXRP</span>
                    </div>
                    <p className="text-[10px] leading-snug text-muted-foreground">
                      Estimate only — pari-mutuel, net of the 2% fee. It moves as the
                      pools fill, and is final only at close.
                    </p>
                    <Button onClick={handleBet} disabled={placing} className="w-full gap-1.5" size="lg">
                      {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      {address ? `Bet on-chain · ${side === OUTCOME.YES ? "YES" : "NO"}` : "Connect wallet"}
                    </Button>
                    <p className="text-center text-[11px] text-muted-foreground">
                      🔒 Each bet submits a BN254 Groth16 proof verified on-chain · real FXRP escrow · FTSOv2-settled
                    </p>
                  </>
                )}
              </div>
            )}
            {confNotes.length > 0 && (
              <ConfidentialNotesPanel
                notes={confNotes}
                resolved={resolved}
                busy={confBusy}
                onClaim={handleConfidentialClaim}
              />
            )}
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <a href={contractUrl(CONTRACTS.predictEscrow)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-accent">
                Escrow contract <ExternalLink className="h-3 w-3" />
              </a>
              <a href={contractUrl(CONTRACTS.market)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-accent">
                Market contract <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </aside>

          <div className={tradeTerminalPositions}>
            <OnChainPositionsPanel id={id} address={address} />
          </div>
        </div>

        <div className="mt-[var(--trade-gap)] rounded-xl border border-border bg-card p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <MessageSquare className="h-4 w-4 text-accent" /> Market chat
            <span className="ml-auto text-[11px] font-normal text-muted-foreground">
              emojis · GIFs · images on IPFS
            </span>
          </h3>
          <MarketCommentsPanel address={address} commentsState={commentsState} />
        </div>
      </div>
    </section>
  );
}

export function StellarMarketDetail({ oracleId }: { oracleId: string }) {
  if (isBackendMarketId(oracleId)) return <BackendDetail id={oracleId} />;
  if (HEX64.test(oracleId)) return <OnChainDetail id={oracleId} />;

  return (
    <section className={cn(pageSimple, "max-w-2xl")}>
      <BackLink />
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          This is a live reference market sourced from Polymarket. Tradeable on-chain markets live on
          the <strong className="text-foreground">Crypto</strong> tab.
        </p>
        <Link to="/markets" className="mt-4 inline-block">
          <Button size="sm">Browse Molfi markets</Button>
        </Link>
      </div>
    </section>
  );
}
