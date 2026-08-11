import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Lock,
  EyeOff,
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
import { SealedBidPanel } from "@/components/SealedBidPanel";
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
  fxrpBalance,
  confidentialPoolStatus,
  confidentialCommitBatch,
  confidentialClaim,
} from "@/lib/stellar/soroban";
import { planStake, describePlan } from "@/lib/confidential/stake-plan";
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
  fetchBackendPrices,
  fetchOnChainMarket,
  fetchPositions,
  fetchZkProof,
  fetchConfidentialStake,
  fetchConfidentialClaim,
  isBackendMarketId,
  placeBet,
  type BackendPosition,
} from "@/lib/molfi-backend";
import {
  loadConfNotes,
  addConfNote,
  markConfNoteClaimed,
  type StoredConfNote,
} from "@/lib/confidential-notes";
import { MarketCommentsPanel } from "@/components/leverx/comments/MarketCommentsPanel";
import { useMarketComments } from "@/hooks/useMarketComments";
import { showError, showTxSuccess, showTxError } from "@/lib/toast";
import { formatTxError } from "@/lib/leverx/tx-errors";
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

/** `PredictEscrow.FEE_BPS` = 200. Every payout estimate on this page nets it
 *  off, so the ticket, the position table and the contract agree. */
const FEE_RATE = 0.02;

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
// Pool depth
// ---------------------------------------------------------------------------

/**
 * The real pari-mutuel pools, replacing what used to be a fake order book.
 *
 * Both detail views previously rendered a symmetric ladder built from
 * `size: 50 + ((i * 137) % 500)` — six invented bids and six invented asks
 * around the mid — under the caption "Indicative depth from other traders".
 * Nobody had placed those orders, and Molfi has no order book to place them
 * on: it is pari-mutuel, so price is just each side's share of the pot.
 *
 * This shows the pot instead. Every number here is read from the escrow
 * contract, so an empty market honestly looks empty.
 */
function PoolDepthPanel({
  yes,
  no,
  loading,
  note,
}: {
  yes: number | null;
  no: number | null;
  loading?: boolean;
  note: ReactNode;
}) {
  const total = (yes ?? 0) + (no ?? 0);
  // With nothing staked there is no market-implied price. Show the even split
  // the contract would pay rather than dividing by zero.
  const yesShare = total > 0 ? (yes ?? 0) / total : 0.5;
  const fmt = (v: number | null) =>
    v == null ? "—" : `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} FXRP`;

  const Side = ({
    label,
    amount,
    share,
    kind,
  }: {
    label: string;
    amount: number | null;
    share: number;
    kind: "yes" | "no";
  }) => (
    <div className="px-3 py-2.5">
      <div className="relative mb-1.5 flex items-center justify-between font-mono text-xs">
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-sm",
            kind === "yes" ? "bg-[var(--long-bg)]" : "bg-[var(--short-bg)]",
          )}
          style={{ width: `${Math.round(share * 100)}%`, opacity: 0.45 }}
          aria-hidden
        />
        <span
          className={cn(
            "relative z-10 font-semibold",
            kind === "yes" ? "text-[var(--long-text)]" : "text-[var(--short-text)]",
          )}
        >
          {label} {Math.round(share * 100)}%
        </span>
        <span className="relative z-10 text-muted-foreground">{fmt(amount)}</span>
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Pool depth</span>
        <span>staked</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="p-4 text-xs text-muted-foreground">Reading pools…</div>
        ) : (
          <>
            <Side label="YES" amount={yes} share={yesShare} kind="yes" />
            <div className="border-y border-border bg-background px-3 py-1 text-center font-mono text-[11px] text-accent">
              {Math.round(yesShare * 100)}¢ · {fmt(total)} in the pot
            </div>
            <Side label="NO" amount={no} share={1 - yesShare} kind="no" />
            {total === 0 ? (
              <p className="px-3 py-3 text-[11px] leading-snug text-muted-foreground">
                Nothing staked yet. The first bet sets the pools.
              </p>
            ) : null}
          </>
        )}
      </div>
      <div className="flex items-start gap-1.5 border-t border-border px-3 py-2 text-[10px] leading-snug text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
        <span>{note}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order book (live, from the backend)
// ---------------------------------------------------------------------------

/**
 * Mongo-mirror markets carry no escrow, so the only truthful depth is the
 * open interest the backend recorded. The fabricated ladder that used to live
 * here is gone along with its `/orderbook` endpoint.
 */
function OrderBookPanel({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["backend-market-depth", id],
    queryFn: () => fetchBackendMarket(id),
    refetchInterval: 8_000,
  });
  const oi = data?.oi ?? null;
  const yesShare = data?.yesPrice ?? 0.5;

  return (
    <PoolDepthPanel
      yes={oi == null ? null : oi * yesShare}
      no={oi == null ? null : oi * (1 - yesShare)}
      loading={isLoading}
      note={
        <>
          Open interest recorded by the Molfi engine for this mirrored market.
          Tradeable markets on the <strong>Crypto</strong> tab escrow real FXRP
          on-chain.
        </>
      }
    />
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
      // showTxError, not showError: this is a raw chain error and must go
      // through formatTxError before a human sees it.
      showTxError(e);
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
/** YES/NO depth straight from the escrow contract's pools. */
function OnChainOrderBookPanel({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["escrow-pools", id],
    queryFn: async () => ({
      yes: Number(await escrowPool(id, OUTCOME.YES)) / FXRP_UNIT,
      no: Number(await escrowPool(id, OUTCOME.NO)) / FXRP_UNIT,
    }),
    refetchInterval: 12_000,
  });

  return (
    <PoolDepthPanel
      yes={data?.yes ?? null}
      no={data?.no ?? null}
      loading={isLoading}
      note={
        <>
          Read live from the predict-escrow contract on Coston2 — this is the
          real staked FXRP, not indicative depth. A normal bet is public and
          verifiable; only a <strong>confidential</strong> bet hides which side
          you took, via a commitment note and a Groth16 proof.
        </>
      }
    />
  );
}

/**
 * @param resolved      market has settled
 * @param winner        winning outcome once resolved (0 = YES, 1 = NO)
 * @param onRedeem      claim the payout; only rendered on a winning leg
 * @param redeeming     a redeem is in flight
 */
function OnChainPositionsPanel({
  id,
  address,
  resolved,
  winner,
  onRedeem,
  redeeming,
}: {
  id: string;
  address: string | null;
  resolved: boolean;
  winner: number | null;
  onRedeem: () => void;
  redeeming: boolean;
}) {
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
  /**
   * Est. payout for an existing position — NET of the 2% fee, like the contract.
   *
   * This returned the gross pro-rata share, so the position table promised 0.08
   * FXRP where `PredictEscrow.redeem` pays 0.0735 and the ticket's own estimate
   * two panels up already said "net of the 2% fee". Same trade, two numbers.
   */
  const estPayout = (outcome: number, stake: number) => {
    const sidePool = outcome === OUTCOME.NO ? pools?.no ?? 0 : pools?.yes ?? 0;
    return sidePool > 0 ? (stake * total * (1 - FEE_RATE)) / sidePool : stake;
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
                    {/* Once settled, "if win" is answered — say what happened. */}
                    <th className="px-3 py-1.5 text-right font-medium">
                      {resolved ? "Result" : "Est. payout if win"}
                    </th>
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
                      <td className="px-3 py-2 text-right font-mono">
                        {!resolved ? (
                          <span className="text-[var(--long-text)]">
                            {estPayout(b.outcome, b.amount).toFixed(2)}
                          </span>
                        ) : winner == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : b.outcome === winner ? (
                          <span className="text-[var(--long-text)]">
                            Won · {estPayout(b.outcome, b.amount).toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Lost</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {/*
            A settled market used to render this table unchanged — "Est. payout
            if win" against a market that had already been decided, with no
            redeem control and no way to tell you had lost.
          */}
          {resolved && winner != null ? (
            legs.some((b) => b.outcome === winner) ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
                <span className="text-xs text-muted-foreground">
                  {winner === OUTCOME.NO ? "NO" : "YES"} won — your stake and share of the pot are
                  claimable.
                </span>
                <Button size="sm" onClick={onRedeem} disabled={redeeming} className="gap-1.5">
                  {redeeming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Redeem winnings
                </Button>
              </div>
            ) : (
              <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                This market settled {winner === OUTCOME.NO ? "NO" : "YES"}, so this position did not
                win. Nothing to claim.
              </p>
            )
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
  // 1 FXRP, not 100. The Coston2 faucet dispenses 10 FXRP, so a default of 100
  // meant the first click every new user made was a validation error.
  const [amount, setAmount] = useState("1");

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
  /** Sealed-bid mode — the Flare Confidential Compute book. */
  const [sealed, setSealed] = useState(false);
  const [confNotes, setConfNotes] = useState<StoredConfNote[]>([]);
  const [confBusy, setConfBusy] = useState<string | null>(null); // "commit" | nullifier | null
  /** Free-form confidential stake. Decomposed into standard notes below, so
   *  the user picks any number while each note stays in a uniform pool. */
  // Tier 0 (1 FXRP). The default was 10, which is tier 1 — and the pool is
  // seeded per tier, so the out-of-the-box stake was the one size the pool
  // could not cover. Start at the smallest note so the flow works on a
  // freshly seeded pool.
  const [confAmount, setConfAmount] = useState("1");

  const marketQuery = useQuery({
    queryKey: ["onchain-market", id],
    queryFn: () => fetchOnChainMarket(id),
    refetchInterval: 15_000,
  });
  const m = marketQuery.data;

  /**
   * Spendable FXRP, so the ticket can say "you don't have this" before it
   * costs a signature.
   *
   * Without it, betting more than you hold reached the contract and came back
   * as a raw viem revert — ABI signature, every Groth16 limb, a docs link —
   * shown verbatim to the user.
   */
  // Same key and same RAW-atoms return as FaucetButton, deliberately: React
  // Query dedupes by key, so a scaled queryFn here would have handed whichever
  // component mounted second the other one's units. Scale at the consumer.
  const balanceQuery = useQuery({
    queryKey: ["fxrp-balance", address],
    queryFn: () => fxrpBalance(address as string),
    enabled: Boolean(address),
    refetchInterval: 20_000,
  });
  const balance = balanceQuery.data == null ? null : Number(balanceQuery.data) / FXRP_UNIT;
  const betInFlight = useRef(false);

  /** Why this ticket cannot be submitted, in the user's terms — or null. */
  const betError = (() => {
    const amt = Number(amount);
    if (!amount.trim()) return "Enter an amount.";
    if (!Number.isFinite(amt) || amt <= 0) return "Enter an amount greater than zero.";
    // FXRP carries 6 decimals. Anything finer truncates to zero atoms on the
    // way to the contract, so the bet would cost gas and escrow nothing.
    if (amt < 1 / FXRP_UNIT) return "The smallest bet is 0.000001 FXRP.";
    if ((amount.split(".")[1]?.length ?? 0) > 6) {
      return "FXRP has 6 decimal places — trim the extra digits.";
    }
    if (balance != null && amt > balance) {
      return balance === 0
        ? "You have no FXRP yet — get some from the faucet in the header."
        : `You have ${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} FXRP.`;
    }
    return null;
  })();
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

  // Decompose the typed amount locally so the ticket can show what will
  // actually be committed before anything is signed.
  const confPlan = (() => {
    try {
      const notes = planStake(confAmount, CONF_TIERS_FXRP);
      return { notes, label: describePlan(notes, CONF_TIERS_FXRP), error: null as string | null };
    } catch (e) {
      return { notes: [], label: "", error: e instanceof Error ? e.message : "invalid amount" };
    }
  })();

  /**
   * Whether the confidential pool can actually pay this stake if it wins.
   *
   * `confidentialPoolStatus` existed but nothing called it, so the Private tab
   * would happily take a commitment against a pool holding 0 FXRP — the stake
   * goes in, and the later claim reverts with "pool is topping up liquidity"
   * forever. Never accept a bet that cannot be paid.
   */
  const confPoolQuery = useQuery({
    // `planStake` returns TIER INDICES, not note objects.
    queryKey: ["conf-pool-status", confPlan.notes.join(",")],
    queryFn: async () => {
      const tiers = [...new Set(confPlan.notes)];
      const rows = await Promise.all(
        tiers.map(async (tier) => ({ tier, ...(await confidentialPoolStatus(tier)) })),
      );
      // Enough claims covered for every note we are about to commit at that tier.
      return rows.map((r) => ({
        ...r,
        needed: confPlan.notes.filter((t) => t === r.tier).length,
      }));
    },
    enabled: confidential && confPlan.notes.length > 0,
    refetchInterval: 30_000,
  });

  /**
   * The Private ticket needs the same balance guard the Standard one has.
   *
   * Without it the tab happily committed a 1 FXRP note from a 0.83 FXRP wallet:
   * `commitBatch` reached the contract, the inner `transferFrom` reverted with
   * no reason string, and the user got viem's raw dump — ABI signature, every
   * Groth16 limb, a docs link — for what is simply "you don't have the funds".
   * The lowest tier is 1 FXRP, so this is the common case, not an edge one.
   */
  const confBalanceError = (() => {
    if (confPlan.error || balance == null) return null;
    const amt = Number(confAmount);
    if (!Number.isFinite(amt) || amt <= 0 || amt <= balance) return null;
    return balance === 0
      ? "You have no FXRP yet — get some from the faucet in the header."
      : `You have ${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} FXRP — the smallest private note is ${CONF_TIERS_FXRP[0]} FXRP.`;
  })();

  const confPoolError = (() => {
    const rows = confPoolQuery.data;
    if (!rows?.length) return null;
    const short = rows.find((r) => Number(r.claimsCovered) < r.needed);
    if (!short) return null;
    return Number(short.claimsCovered) === 0
      ? "The private pool has no liquidity right now, so a winning note could not be paid. Use a standard bet, or try again once the pool is topped up."
      : `The private pool can only cover ${Number(short.claimsCovered)} claim(s) at this note size right now — lower the stake or use a standard bet.`;
  })();

  const commentsState = useMarketComments(id);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["escrow-pools", id] });
    await queryClient.invalidateQueries({ queryKey: ["escrow-pos", id] });
    // The wallet balance moved too. Without this the ticket and the header
    // faucet pill both kept showing the pre-bet number for up to 20 seconds,
    // which reads as "the bet didn't take".
    await queryClient.invalidateQueries({ queryKey: ["fxrp-balance", address] });
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
    if (confBalanceError) return showError(confBalanceError);
    if (confPoolError) return showError(confPoolError);
    setConfBusy("commit");
    try {
      const sideStr = side === OUTCOME.YES ? "YES" : "NO";
      const plan = await fetchConfidentialStake(sideStr, id, Number(confAmount));
      const hash = await confidentialCommitBatch(
        address,
        id,
        plan.notes.map((n) => n.tier),
        plan.notes.map((n) => n.commitment),
      );
      // Every note is stored — each one is independently claimable, and losing
      // any of them loses that slice of the stake.
      let stored = confNotes;
      for (const n of plan.notes) {
        stored = addConfNote(id, address, {
          ...n.note,
          commitment: n.commitment,
          side: n.side,
          tier: n.tier,
          denom: n.denom,
          committedTx: hash,
          committedAt: Date.now(),
        });
      }
      setConfNotes(stored);
      showTxSuccess(
        `🔒 Confidential bet · ${plan.amount} FXRP as ${plan.noteCount} note${plan.noteCount === 1 ? "" : "s"} (${plan.planLabel}) — side hidden`,
        hash,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Confidential bet failed";
      // Anything not matched here still has to go through formatTxError — the
      // bare `msg` fallback was rendering viem's whole dump in the toast.
      showError(
        /balance|insufficient/i.test(msg)
          ? `Need ${confAmount} FXRP — use the faucet first.`
          : formatTxError(e),
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
                : formatTxError(e);
      showError(friendly);
    } finally {
      setConfBusy(null);
    }
  };

  const handleBet = async () => {
    if (!address) return void connect();
    // Checked here as well as on the button: the button can be bypassed by
    // Enter, and a stale balance read should not turn into a raw revert.
    if (betError) return showError(betError);
    // Synchronous latch — `placing` is state, so two clicks in the same tick
    // both get through and the node rejects the second as "already known".
    if (betInFlight.current) return;
    betInFlight.current = true;
    const amt = Number(amount);
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
      // showTxError, not showError: this is a raw chain error and must go
      // through formatTxError before a human sees it.
      showTxError(e);
    } finally {
      betInFlight.current = false;
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
  const payout = sidePool > 0 ? (amt * totalPool * (1 - FEE_RATE)) / sidePool : 0;
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
                {/* The padlock belonged to the Private tab, not to every market —
                    a public bet's side is on-chain in the clear. */}
                ⛓️ On-chain · 🔒 Optional private bets · FTSOv2-settled
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
              {/* Once settled, what it settled against matters more than the
                  oracle's name — and an em dash on a resolved market reads as
                  missing data. */}
              {resolved ? (
                <StatItem label="Settled at" value={fmtUsd(m.settlePrice, m.symbol)} />
              ) : (
                <StatItem label="Oracle" value="FTSOv2" />
              )}
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
            <OnChainOrderBookPanel id={id} />
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
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/40 p-1 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => { setConfidential(false); setSealed(false); }}
                    className={cn(
                      "rounded-md py-1.5 transition",
                      !confidential && !sealed ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
                    )}
                  >
                    Standard
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfidential(true); setSealed(false); }}
                    className={cn(
                      "inline-flex items-center justify-center gap-1 rounded-md py-1.5 transition",
                      confidential && !sealed ? "bg-card text-accent shadow-sm" : "text-muted-foreground",
                    )}
                  >
                    <Lock className="h-3 w-3" /> Private
                  </button>
                  {/* The FCC surface. Distinct from "Private": that hides YOUR
                      side from everyone, this hides EVERYONE's side from the
                      market until close, so the odds cannot be read at all. */}
                  <button
                    type="button"
                    onClick={() => { setSealed(true); setConfidential(false); }}
                    className={cn(
                      "inline-flex items-center justify-center gap-1 rounded-md py-1.5 transition",
                      sealed ? "bg-card text-accent shadow-sm" : "text-muted-foreground",
                    )}
                  >
                    <EyeOff className="h-3 w-3" /> Sealed
                  </button>
                </div>
                {sealed ? (
                  <SealedBidPanel
                    marketId={id}
                    address={address}
                    closed={closed}
                    onConnect={connect}
                  />
                ) : (
                <>
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
                      <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Stake (FXRP)
                      </label>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={confAmount}
                        onChange={(e) => setConfAmount(e.target.value)}
                        className="border-border bg-background font-mono"
                      />
                      <div className="flex gap-1.5">
                        {[1, 10, 50, 137].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setConfAmount(String(preset))}
                            className="flex-1 rounded-md border border-border py-1 font-mono text-[10px] text-muted-foreground transition hover:text-foreground"
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                      {/* Show the decomposition BEFORE signing. The amount is
                          free-form, but what gets committed is standard notes —
                          the user should see exactly which. */}
                      {confPlan.error ? (
                        <p className="text-[10px] text-destructive">{confPlan.error}</p>
                      ) : confBalanceError ? (
                        <p className="text-[10px] leading-snug text-destructive">
                          {confBalanceError}
                        </p>
                      ) : confPoolError ? (
                        <p className="text-[10px] leading-snug text-destructive">{confPoolError}</p>
                      ) : (
                        <p className="text-[10px] leading-snug text-muted-foreground">
                          Committed as{" "}
                          <span className="font-mono text-foreground">{confPlan.notes.length}</span>{" "}
                          note{confPlan.notes.length === 1 ? "" : "s"} ·{" "}
                          <span className="font-mono">{confPlan.label}</span>. Each note claims
                          separately against others of the same size, which is what keeps your
                          payout unlinkable from your deposit.
                        </p>
                      )}
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
                      <span className="text-muted-foreground">Stake · side hidden</span>
                      <span className="font-mono font-semibold text-foreground">
                        {confPlan.error ? "—" : `${Number(confAmount)} FXRP`}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Payout if your side wins</span>
                      <span className="font-mono text-foreground">
                        {confPlan.error ? "—" : `${Number(confAmount) * CONF_PAYOUT_MULT} FXRP`}
                      </span>
                    </div>
                    <Button
                      onClick={handleConfidentialBet}
                      disabled={
                        confBusy === "commit" ||
                        Boolean(confPlan.error) ||
                        Boolean(address && confBalanceError) ||
                        Boolean(address && confPoolError)
                      }
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
                      <div className="flex items-baseline justify-between">
                        <label className="text-xs uppercase tracking-wide text-muted-foreground">Amount (FXRP)</label>
                        {balance != null ? (
                          <button
                            type="button"
                            onClick={() => setAmount(String(Math.floor(balance * 100) / 100))}
                            className="font-mono text-[10px] text-muted-foreground transition hover:text-accent"
                          >
                            Balance {balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} · max
                          </button>
                        ) : null}
                      </div>
                      <Input
                        type="number"
                        min={1}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        aria-invalid={Boolean(betError)}
                        className="mt-1 border-border bg-background font-mono"
                      />
                      {betError ? (
                        <p className="mt-1 text-[11px] text-destructive">{betError}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Est. payout if {side === OUTCOME.YES ? "YES" : "NO"} wins</span>
                      <span className="font-mono text-foreground">{payout.toFixed(2)} FXRP</span>
                    </div>
                    <p className="text-[10px] leading-snug text-muted-foreground">
                      Estimate only — pari-mutuel, net of the 2% fee. It moves as the
                      pools fill, and is final only at close.
                    </p>
                    <Button
                      onClick={handleBet}
                      disabled={placing || Boolean(address && betError)}
                      className="w-full gap-1.5"
                      size="lg"
                    >
                      {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      {address ? `Bet on-chain · ${side === OUTCOME.YES ? "YES" : "NO"}` : "Connect wallet"}
                    </Button>
                    {/*
                      Do not let this line imply privacy it does not deliver.
                      It read "🔒 Each bet submits a BN254 Groth16 proof verified
                      on-chain", next to a padlock, on the PUBLIC ticket. The
                      proof is real and `betZk` really does verify it and burn a
                      nullifier — but its public signals bind to no market, side,
                      amount or sender, so it gates nothing about this bet. The
                      side is plainly visible on-chain here. Privacy lives on the
                      Private tab, where the side is committed and later claimed
                      with an outcome-bound proof. Say which is which.
                    */}
                    <p className="text-center text-[11px] text-muted-foreground">
                      Public bet · real FXRP escrow · FTSOv2-settled. Your side is visible on-chain —
                      use the <span className="text-foreground">Private</span> tab to hide it.
                    </p>
                  </>
                )}
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
            <OnChainPositionsPanel
              id={id}
              address={address}
              resolved={resolved}
              winner={resolved ? (m.outcome ?? null) : null}
              onRedeem={handleRedeem}
              redeeming={redeeming}
            />
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
        {/*
          This used to read "a live reference market sourced from Polymarket".
          Nothing in the app has ever fetched Polymarket, and the only way to
          land here is an id that is neither an on-chain market nor a backend
          one — i.e. a bad or stale link. Say that instead.
        */}
        <p className="text-sm text-muted-foreground">
          No market matches this link. It may have been mistyped, or the market may have been
          removed. Live markets are on the <strong className="text-foreground">Crypto</strong> tab.
        </p>
        <Link to="/markets" className="mt-4 inline-block">
          <Button size="sm">Browse Molfi markets</Button>
        </Link>
      </div>
    </section>
  );
}
