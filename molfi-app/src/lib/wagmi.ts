/**
 * wagmi + RainbowKit config for Molfi — Flare Coston2 only.
 * The connect-wallet experience is RainbowKit's modal; writes flow through the
 * connected wallet client (wired into the on-chain layer by WalletContext).
 *
 * `flareTestnet` from wagmi/chains IS Coston2 (chainId 114), so there is no
 * need to hand-roll a chain definition here.
 */
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { flareTestnet } from "wagmi/chains";
import { http } from "wagmi";
import { FLARE } from "@/lib/stellar/contracts";

/** WalletConnect Cloud project id. Injected wallets (MetaMask etc.) work
 * without it; set VITE_WALLETCONNECT_PROJECT_ID to enable WalletConnect / mobile. */
const projectId =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? "molfi_dev_placeholder";

export const wagmiConfig = getDefaultConfig({
  appName: "Molfi",
  projectId,
  chains: [flareTestnet],
  transports: { [flareTestnet.id]: http(FLARE.rpcUrl) },
  ssr: false,
});
