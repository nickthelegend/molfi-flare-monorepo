import { useQuery } from "@tanstack/react-query";
import { listMarkets, type OnChainMarket } from "@/lib/stellar/soroban";

/**
 * Live markets read straight from the `MolfiMarket` contract on Flare Coston2
 * via viem `eth_call` — enumerate `markets()`, then `getMarket()` per id. No
 * indexer. (The `stellar/` module path is retained for import compatibility
 * across chain migrations; the chain underneath is Flare's C-Chain.)
 */
export function useStellarMarkets() {
  return useQuery<OnChainMarket[]>({
    queryKey: ["stellar", "markets"],
    queryFn: listMarkets,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
