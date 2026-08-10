import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EyeOff, Loader2, Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sealedBookStatus, sealBid, fxrpBalance } from "@/lib/stellar/soroban";
import { CONTRACTS, FXRP_UNIT, OUTCOME, contractUrl } from "@/lib/stellar/contracts";
import { fetchSealedKey } from "@/lib/molfi-backend";
import { sealSide } from "@/lib/sealed/seal";
import { showError, showTxSuccess, showTxError } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The sealed book — Molfi's Flare Confidential Compute surface.
 *
 * While a market is live this shows how much is at stake and refuses to show
 * which way it leans, because the split genuinely is not on-chain: each bid's
 * side is encrypted to the enclave and only opened after close. That is the
 * whole feature, so the panel is built to make the absence visible rather than
 * to hide an empty state.
 */
export function SealedBidPanel({
  marketId,
  address,
  closed,
  onConnect,
}: {
  marketId: string;
  address: string | null;
  closed: boolean;
  onConnect: () => void;
}) {
  // Sized against the faucet's 10 FXRP.
  const [amount, setAmount] = useState("1");
  const [side, setSide] = useState<number>(OUTCOME.YES);
  const [busy, setBusy] = useState(false);

  const book = useQuery({
    queryKey: ["sealed-book", marketId],
    queryFn: () => sealedBookStatus(marketId),
    refetchInterval: 12_000,
  });

  // The enclave's public key. Fetched through the backend so the browser never
  // carries the tunnel hostname, which rotates.
  const key = useQuery({
    queryKey: ["sealed-key"],
    queryFn: fetchSealedKey,
    staleTime: 300_000,
    retry: 1,
  });

  const total = Number(book.data?.totalEscrowed ?? 0n) / FXRP_UNIT;
  const count = book.data?.bidCount ?? 0;
  const opened = book.data?.opened ?? false;
  const yesPool = Number(book.data?.yesPool ?? 0n) / FXRP_UNIT;
  const noPool = Number(book.data?.noPool ?? 0n) / FXRP_UNIT;

  /**
   * Spendable FXRP — same key and raw-atom return as the header faucet pill, so
   * React Query's dedupe cannot hand the two components different units.
   *
   * The sealed form had the same gap as the bet ticket and the vault deposit:
   * only `amt > 0` was checked, so an amount over the balance reached the
   * contract and came back as a raw revert.
   */
  const balanceQuery = useQuery({
    queryKey: ["fxrp-balance", address],
    queryFn: () => fxrpBalance(address as string),
    enabled: Boolean(address),
    refetchInterval: 20_000,
  });
  const balance = balanceQuery.data == null ? null : Number(balanceQuery.data) / FXRP_UNIT;

  /** Why this sealed bid cannot be submitted, in the user's terms — or null. */
  const bidError = (() => {
    // Without the enclave's public key there is nothing to encrypt to. The
    // button used to stay enabled here (`key.isLoading` is false once the
    // query has FAILED), so the only feedback was an error toast after a
    // click that could never have worked.
    if (!key.isLoading && !key.data?.publicKey) {
      return "The enclave is unreachable, so a bid cannot be sealed right now. Standard and private bets still work.";
    }
    const amt = Number(amount);
    if (!amount.trim()) return "Enter an amount.";
    if (!Number.isFinite(amt) || amt <= 0) return "Enter an amount greater than zero.";
    if (amt < 1 / FXRP_UNIT) return "The smallest bid is 0.000001 FXRP.";
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

  const inFlight = useRef(false);

  const place = async () => {
    if (!address) return void onConnect();
    if (!key.data?.publicKey) {
      return showError("The enclave is unreachable — a sealed bid cannot be encrypted right now.");
    }
    if (bidError) return showError(bidError);
    // Synchronous latch: `busy` is state, so a double-click sends twice.
    if (inFlight.current) return;
    inFlight.current = true;
    const amt = Number(amount);
    setBusy(true);
    try {
      // Encrypted HERE, in the page. The side never leaves this function in
      // plaintext — not to the backend, not to the RPC, not to the chain.
      const ciphertext = await sealSide(
        key.data.publicKey,
        marketId,
        address,
        side === OUTCOME.YES ? 0 : 1,
      );
      const hash = await sealBid(address, marketId, amt, ciphertext);
      showTxSuccess(`🔒 Sealed ${amt} FXRP — your side is encrypted to the enclave`, hash);
      await book.refetch();
    } catch (e) {
      showTxError(e);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* What the public can see. The point is that it is deliberately partial. */}
      <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
          {opened ? <Unlock className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          {opened ? "Book opened by the enclave" : "Book sealed"}
        </div>
        <div className="mt-2 flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">At stake</span>
          <span className="font-mono font-semibold text-foreground">
            {total.toLocaleString()} FXRP · {count} bid{count === 1 ? "" : "s"}
          </span>
        </div>
        {opened ? (
          <div className="mt-1.5 flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">Split</span>
            <span className="font-mono">
              <span className="text-[var(--long-text)]">YES {yesPool.toLocaleString()}</span>
              {" · "}
              <span className="text-[var(--short-text)]">NO {noPool.toLocaleString()}</span>
            </span>
          </div>
        ) : (
          <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
            The YES/NO split is <strong>not on-chain yet</strong>. Every side is encrypted to a
            Flare Confidential Compute enclave and opened only after close — so the odds cannot
            be read, and your bet cannot be front-run.
          </p>
        )}
      </div>

      {closed ? (
        <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          This market has closed. The enclave opens the book, publishes both pools, and winners
          claim with a proof of their own side.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            {[
              { s: OUTCOME.YES, label: "YES", cls: "long" },
              { s: OUTCOME.NO, label: "NO", cls: "short" },
            ].map(({ s, label, cls }) => (
              <button
                key={label}
                type="button"
                onClick={() => setSide(s)}
                className={cn(
                  "rounded-lg py-2.5 text-sm font-semibold transition",
                  side === s
                    ? `bg-[var(--${cls}-bg)] text-[var(--${cls}-text)] ring-2 ring-[var(--${cls}-text)]/40`
                    : "border border-border text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Stake (FXRP)
            </label>
            <Input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 border-border bg-background font-mono"
            />
          </div>

          {bidError ? <p className="text-[11px] text-destructive">{bidError}</p> : null}
          <Button
            onClick={place}
            disabled={busy || key.isLoading || Boolean(address && bidError)}
            className="w-full gap-1.5"
            size="lg"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            {busy ? "Sealing…" : "Seal bid"}
          </Button>

          {key.isError ? (
            <p className="text-[10px] text-destructive">
              Enclave unreachable — sealed bids are unavailable until it is back.
            </p>
          ) : key.data ? (
            <p className="text-[10px] leading-snug text-muted-foreground">
              Encrypted in your browser to enclave key{" "}
              <span className="font-mono">{key.data.publicKey.slice(0, 14)}…</span>
              {key.data.simulated ? " (SIMULATED_TEE — dev posture)" : ""}. Amount is public;
              only the side is sealed.
            </p>
          ) : null}
        </>
      )}

      <a
        href={contractUrl(CONTRACTS.sealedBidBook)}
        target="_blank"
        rel="noreferrer"
        className="block text-[10px] text-accent hover:underline"
      >
        SealedBidBook contract ↗
      </a>
    </div>
  );
}
