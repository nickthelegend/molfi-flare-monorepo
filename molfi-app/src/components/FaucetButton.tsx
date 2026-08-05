import { Droplets, ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/context/WalletContext";
import { fxrpBalance } from "@/lib/stellar/soroban";
import { FXRP_UNIT, FAUCET_URL } from "@/lib/stellar/contracts";
import { cn } from "@/lib/utils";

/**
 * Header button: shows the live FXRP balance and links to the Flare faucet.
 *
 * This is NOT a mint button, and that difference is the point of the Flare
 * port. The Avalanche build collateralized markets in a mock token with an open
 * `mint()`, so "get funds" was a contract call. FXRP is the FAssets
 * representation of real XRP — over-collateralized and redeemable back to the
 * XRP Ledger — so no one can conjure it. Funds come from the faucet on testnet,
 * and from the FAssets mint flow against real XRP in production.
 */
export function FaucetButton({ className }: { className?: string }) {
  const { address, connect } = useWallet();

  const { data: balance } = useQuery({
    queryKey: ["fxrp-balance", address],
    queryFn: () => fxrpBalance(address as string),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });

  const handleClick = () => {
    if (!address) {
      void connect();
      return;
    }
    window.open(FAUCET_URL, "_blank", "noopener,noreferrer");
  };

  const balanceLabel =
    address && balance != null
      ? `${(Number(balance) / FXRP_UNIT).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })} FXRP`
      : "Get FXRP";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleClick}
      title={
        address
          ? "Get testnet FXRP + C2FLR from the Flare faucet"
          : "Connect a wallet"
      }
      className={cn("gap-1.5", className)}
    >
      <Droplets className="h-4 w-4 text-accent" />
      <span className="hidden sm:inline">{balanceLabel}</span>
      {address ? <ExternalLink className="hidden h-3 w-3 opacity-60 sm:inline" /> : null}
    </Button>
  );
}
