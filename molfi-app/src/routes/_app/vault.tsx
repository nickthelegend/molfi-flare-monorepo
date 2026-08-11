import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, Coins, Loader2, Receipt, ShieldCheck, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LivePriceChart } from "@/components/LivePriceChart";
import { vaultDepositOnChain, vaultWithdrawAllOnChain, fxrpBalance } from "@/lib/stellar/soroban";
import { useWallet } from "@/context/WalletContext";
import {
  fetchVaults,
  fetchVaultPosition,
  fetchVaultHistory,
  fetchVaultActivity,
  vaultDeposit,
} from "@/lib/molfi-backend";
import { showError, showTxSuccess, showTxError } from "@/lib/toast";
import { FXRP_UNIT } from "@/lib/stellar/contracts";
import { pageTitle } from "@/lib/brand";
import { pageSimple, pageSimpleTitle } from "@/lib/leverx/tw";
import { cn } from "@/lib/utils";
import { routePendingOptions } from "@/lib/router/route-options";

/**
 * FXRP is FAssets-wrapped XRP, so it wears the XRP mark.
 *
 * This used to render the real USDC logo with alt="USDC" next to the label
 * "FXRP" — on a page whose whole point is that collateral is XRP-denominated
 * and NOT a USD peg. An LP reading the icon would price their risk wrong.
 */
const FXRP_LOGO =
  "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/xrp.png";

export const Route = createFileRoute("/_app/vault")({
  ...routePendingOptions,
  loader: () => null,
  head: () => ({
    meta: [
      { title: pageTitle("Vault") },
      { name: "description", content: "Deposit FXRP to the Molfi LP vault and earn trading fees." },
    ],
  }),
  component: VaultPage,
});

/**
 * Format an FXRP amount without ever rounding a real one away.
 *
 * A flat 2 decimals printed the 2% fee on a 0.05 FXRP bet — 0.001 — as
 * "+0 FXRP", which reads as "nothing actually happened" on the one panel meant
 * to show the vault earning. FXRP carries 6 decimals, so small amounts get the
 * precision they need and large ones stay readable.
 */
const usd = (n: number) => {
  const digits = n >= 1000 ? 0 : Math.abs(n) < 0.01 && n !== 0 ? 6 : 2;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
};

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-mono text-xl font-semibold", accent ? "text-accent" : "text-foreground")}>
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function timeAgo(ts: number, now: number) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function VaultPage() {
  const { address, connect } = useWallet();
  const queryClient = useQueryClient();
  // Sized against the faucet's 10 FXRP, not above it — see the bet ticket.
  const [amount, setAmount] = useState("1");
  const [depositing, setDepositing] = useState(false);

  /**
   * Spendable FXRP, shared by key with the header faucet pill (raw atoms —
   * scale at the consumer, never in the queryFn, or the two disagree).
   *
   * The deposit form had no validation at all: empty, 0, -1 and an amount far
   * over the balance all left "Deposit to vault" enabled, and the default of
   * 100 is more than most testnet wallets hold — so the first click was a
   * revert.
   */
  const balanceQuery = useQuery({
    queryKey: ["fxrp-balance", address],
    queryFn: () => fxrpBalance(address as string),
    enabled: Boolean(address),
    refetchInterval: 20_000,
  });
  const balance = balanceQuery.data == null ? null : Number(balanceQuery.data) / FXRP_UNIT;

  /** Why this deposit cannot be submitted, in the user's terms — or null. */
  const depositError = (() => {
    const amt = Number(amount);
    if (!amount.trim()) return "Enter an amount.";
    if (!Number.isFinite(amt) || amt <= 0) return "Enter an amount greater than zero.";
    if (amt < 1 / FXRP_UNIT) return "The smallest deposit is 0.000001 FXRP.";
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

  const { data: vaults } = useQuery({ queryKey: ["vaults"], queryFn: fetchVaults, refetchInterval: 15_000 });
  const vault = vaults?.[0];
  const { data: history = [] } = useQuery({
    queryKey: ["vault-history"],
    queryFn: fetchVaultHistory,
    refetchInterval: 30_000,
  });
  const { data: activity = [] } = useQuery({
    queryKey: ["vault-activity"],
    queryFn: fetchVaultActivity,
    refetchInterval: 15_000,
  });
  const { data: pos } = useQuery({
    queryKey: ["vault-position", address],
    queryFn: () => fetchVaultPosition(address as string),
    enabled: Boolean(address),
    refetchInterval: 15_000,
  });

  const navGrowth = vault?.sharePrice ? (vault.sharePrice - 1) * 100 : 0;
  const tvlPoints = history.map((h) => ({ ts: h.ts, price: h.tvl }));
  const now = Date.now();

  /**
   * Synchronous in-flight latch.
   *
   * `depositing` alone does not stop a double-click: both handlers run before
   * React re-renders, so two identical deposits went out and the node rejected
   * the second as "already known". A ref flips immediately.
   */
  const inFlight = useRef(false);

  const [withdrawing, setWithdrawing] = useState(false);
  const withdrawInFlight = useRef(false);

  /** Burn every share and take the FXRP back — deposit's missing other half. */
  const handleWithdraw = async () => {
    if (!address) return void connect();
    if (withdrawInFlight.current) return;
    withdrawInFlight.current = true;
    setWithdrawing(true);
    try {
      const hash = await vaultWithdrawAllOnChain();
      showTxSuccess("Withdrew your vault position", hash);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["vaults"] }),
        queryClient.invalidateQueries({ queryKey: ["vault-activity"] }),
        queryClient.invalidateQueries({ queryKey: ["vault-position", address] }),
        queryClient.invalidateQueries({ queryKey: ["fxrp-balance", address] }),
      ]);
    } catch (e) {
      showTxError(e);
    } finally {
      withdrawInFlight.current = false;
      setWithdrawing(false);
    }
  };

  const handleDeposit = async () => {
    if (!address) return void connect();
    const amt = Number(amount);
    if (depositError) return showError(depositError);
    if (inFlight.current) return;
    inFlight.current = true;
    setDepositing(true);
    try {
      // Real on-chain deposit into the LP vault contract (wallet-signed).
      const hash = await vaultDepositOnChain(address, amt);
      showTxSuccess(`Deposited ${amt} FXRP to the vault`, hash);
      // Mirror to the backend for the depositor count (non-fatal).
      await vaultDeposit(address, amt).catch(() => {});
      await queryClient.invalidateQueries({ queryKey: ["vaults"] });
      await queryClient.invalidateQueries({ queryKey: ["vault-history"] });
      await queryClient.invalidateQueries({ queryKey: ["vault-activity"] });
      await queryClient.invalidateQueries({ queryKey: ["vault-position", address] });
      await queryClient.invalidateQueries({ queryKey: ["fxrp-balance", address] });
    } catch (e) {
      showTxError(e);
    } finally {
      inFlight.current = false;
      setDepositing(false);
    }
  };

  return (
    <section className={pageSimple}>
      <div>
        <h1 className={pageSimpleTitle}>
          <Coins className="mb-1 mr-2 inline h-6 w-6 text-accent" />
          Vault
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          The <strong className="text-foreground">Molfi LP Vault</strong> backs market settlement and earns a share
          of the <strong className="text-foreground">2% trading fee</strong> charged on every bet. Deposit FXRP to
          provide liquidity and earn yield from trading activity across all markets.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total value locked" value={`${usd(vault?.tvl ?? 0)} FXRP`} />
        {/*
          A per-share return needs shares. Until someone deposits there are
          none, and dividing accrued fees by a notional stake printed a headline
          "56.7% realized yield · NAV 1.5668" that nobody was earning — the kind
          of number a reader is right to distrust, on the one page whose whole
          job is to be trusted with deposits. The fees are real and on-chain, so
          show those; show a return only once there is a holder to earn it.
        */}
        {vault?.totalShares ? (
          <>
            {/*
              `feesEarned` is the vault's on-chain `lifetimeFees` — every FXRP
              ever paid IN, across all generations of LPs. The yield beside it
              is NAV growth for the CURRENT holders. The two legitimately
              diverge: a full withdrawal re-prices shares at 1.0 for whoever
              deposits next, while `lifetimeFees` keeps counting. Say "paid in
              since inception" so the pair can't be read as one contradicting
              the other.
            */}
            <Stat
              label="Realized fee yield"
              value={`${vault?.apr ?? 0}%`}
              sub={`${usd(vault?.feesEarned ?? 0)} FXRP paid in since inception`}
              accent
            />
            <Stat
              label="NAV / share"
              value={`${(vault?.sharePrice ?? 1).toFixed(4)}`}
              sub={`${navGrowth >= 0 ? "+" : ""}${navGrowth.toFixed(2)}% since inception`}
              accent
            />
          </>
        ) : (
          <>
            {/*
              Say WHEN this was collected, not just how much.
              "Fees collected 9.57 FXRP · 2% of every settled bet" sitting beside
              "Total value locked 0 FXRP" invites exactly one reading: the number
              is invented. It isn't — it is the vault's on-chain `lifetimeFees`,
              accumulated across every LP generation since deployment, and the
              TVL is 0 only because the last LP withdrew. Date the figure so the
              pair reconciles on sight.
            */}
            <Stat
              label="Lifetime fees collected"
              value={`${usd(vault?.feesEarned ?? 0)} FXRP`}
              sub="paid in since deployment · TVL is 0 because the last LP withdrew"
              accent
            />
            <Stat label="NAV / share" value="—" sub="set by the first deposit" />
          </>
        )}
        <Stat label="Total shares" value={`${usd(vault?.totalShares ?? 0)}`} sub="on-chain LP shares" />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Vault performance · TVL</h2>
          <span className="font-mono text-sm text-[var(--long-text)]">
            +{usd(vault?.feesEarned ?? 0)} FXRP paid in
          </span>
        </div>
        {tvlPoints.length > 1 ? (
          <LivePriceChart points={tvlPoints} height={220} />
        ) : (
          <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
            Performance history appears as deposits and trading fees accrue.
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 rounded-xl border border-border bg-card p-5 lg:col-span-1">
          <h2 className="text-sm font-semibold text-foreground">Provide liquidity</h2>
          <div className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2">
            <img src={FXRP_LOGO} alt="FXRP" className="h-7 w-7 rounded-full" loading="lazy" />
            <div className="leading-tight">
              <p className="text-sm font-semibold text-foreground">FXRP</p>
              {/* FXRP is XRP-backed, not USD-pegged — it is a 1:1
                  over-collateralized claim on XRP held by FAssets agents. */}
              <p className="text-[11px] text-muted-foreground">XRP-backed · FAssets on Coston2</p>
            </div>
          </div>
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
            <div className="relative mt-1">
              <img
                src={FXRP_LOGO}
                alt=""
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full"
              />
              <Input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={Boolean(depositError)}
                className="border-border bg-background pl-10 font-mono"
              />
            </div>
            {depositError ? (
              <p className="mt-1 text-[11px] text-destructive">{depositError}</p>
            ) : null}
          </div>
          <Button
            onClick={handleDeposit}
            disabled={depositing || Boolean(address && depositError)}
            className="w-full gap-1.5"
            size="lg"
          >
            {depositing ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingUp className="h-4 w-4" />}
            {address ? "Deposit to vault" : "Connect wallet"}
          </Button>
          {address && pos ? (
            <div className="space-y-1 rounded-lg border border-border bg-background p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Your position</span>
                <span className="font-mono">{usd(pos.deposited)} FXRP</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shares</span>
                <span className="font-mono">{usd(pos.shares ?? 0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pool share</span>
                <span className="font-mono">{pos.sharePct}%</span>
              </div>
              {pos.earned == null ? null : (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fees earned</span>
                  <span className="font-mono text-[var(--long-text)]">
                    +{usd(pos.earned)} FXRP
                  </span>
                </div>
              )}
              {/*
                The way out. There was none: the old "deposit" transferred FXRP
                into PredictEscrow, which has no function that could ever pay it
                back. Offering a deposit without a withdrawal is not a vault.
              */}
              {(pos.shares ?? 0) > 0 ? (
                <Button
                  onClick={handleWithdraw}
                  disabled={withdrawing}
                  variant="outline"
                  className="mt-2 w-full gap-2"
                  size="sm"
                >
                  {withdrawing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Withdraw all
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Get testnet FXRP from the <strong>Faucet</strong> in the header first.
          </p>
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
          {activity.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {activity.map((e, i) => (
                <li key={`${e.address}-${e.ts}-${i}`} className="flex items-center gap-3 py-2.5">
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                      e.type === "deposit" ? "bg-accent/10 text-accent" : "bg-[var(--long-bg)] text-[var(--long-text)]",
                    )}
                  >
                    {e.type === "deposit" ? <ArrowDownLeft className="h-4 w-4" /> : <Receipt className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">
                      {e.type === "deposit" ? "Liquidity deposit" : `Trading fee · ${e.symbol ?? ""}`}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {e.address.slice(0, 6)}…{e.address.slice(-4)} · {timeAgo(e.ts, now)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-sm",
                      e.type === "deposit" ? "text-foreground" : "text-[var(--long-text)]",
                    )}
                  >
                    {e.type === "deposit" ? "" : "+"}
                    {usd(e.amount)} FXRP
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">How the vault works</h2>
        <ul className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
          <li className="flex gap-3">
            <Coins className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              <strong className="text-foreground">Deposit FXRP</strong> into the shared pool. Your deposit provides
              liquidity that backs market settlement.
            </span>
          </li>
          <li className="flex gap-3">
            <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              <strong className="text-foreground">Earn 2% of every trade.</strong> Each bet pays a 2% fee that accrues
              to the vault and lifts the NAV per share for all depositors.
            </span>
          </li>
          <li className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              {/* Ordinary stakes are public on-chain — only the ConfidentialBet
                  path hides a side. Claiming blanket privacy here was false. */}
              <strong className="text-foreground">Optional privacy.</strong> Ordinary bets are public and
              verifiable on Coston2. Traders who want their side hidden use a confidential bet —
              a commitment note plus a Groth16 proof — and the vault still earns the same fee.
            </span>
          </li>
        </ul>
      </div>
    </section>
  );
}
