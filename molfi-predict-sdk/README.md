# molfi-predict-sdk

Modular SDK for the **Molfi** private prediction market on **Flare Coston2**
(viem + snarkjs). One package, two layers — built so humans *and* AI agents trade
through the same API:

- **Agent / on-chain layer** (`MolfiAgent`, `MolfiChain`, wallet, data): generate an
  EVM wallet, fund its C2FLR gas and check its `FXRP` balance, read live markets /
  odds / order book, and place **real on-chain bets** that escrow FXRP (optionally
  gated by a zero-knowledge proof verified on-chain), then redeem winnings.
- **CLOB layer** (`signClobOrder`, `buildOrder`): order signing — secp256k1 over a
  canonical 104-byte order layout (`canonicalOrderBytes`). Honest scope: the
  signing is real and tested, but no matching engine and no on-chain settlement
  verifier are built, so nothing consumes these orders yet.

> 🤖 Agents: see [`SKILL.md`](./SKILL.md) for the autonomous-trading runbook.

## Install & build

```bash
npm install
npm run build
node examples/agent-trade.mjs   # live demo: wallet → gas → read markets → bet
```

## Quick start — autonomous agent

```ts
import { MolfiAgent, OUTCOME_YES } from "@molfi/predict-sdk";

const agent = MolfiAgent.create();            // fresh EVM wallet
await agent.onboard({ funderKey });             // sends this wallet C2FLR for gas and
                                               // reports its FXRP balance. FXRP cannot be
                                               // minted — it is FAssets-wrapped real XRP, so
                                               // bankroll comes from the Coston2 faucet:
                                               // https://faucet.flare.network/coston2
const markets = await agent.markets();         // live odds, OI, sentiment
const [m]     = await agent.onChainMarkets();  // a 32-byte hex market id you can bet on
await agent.bet(m.marketId, OUTCOME_YES, 100); // escrow 100 FXRP on YES (real tx)

if (await agent.isResolved(m.marketId)) {
  await agent.redeem(m.marketId);              // claim pro-rata winnings
}
```

Restore an existing trader: `new MolfiAgent(privateKey)` (a `0x…` EVM key). Point
at another deployment with env vars (`MOLFI_BACKEND_URL`, `MOLFI_RPC`,
`MOLFI_ESCROW`, `MOLFI_MARKET`, `MOLFI_CBET`, …) — see [`src/config.ts`](./src/config.ts).

## Quick start — CLOB order signing

```ts
import { signClobOrder, PrivateKeyOrderSigner, MolfiAgent } from "@molfi/predict-sdk";
import { hexToBytes, bytesToHex } from "viem";

const [m] = await MolfiAgent.create().onChainMarkets();
const signed = await signClobOrder(
  {
    market: hexToBytes(m.marketId),        // must be exactly 32 bytes
    outcome: "YES",
    price: 0.62,                            // probability, packed as price * 1e6
    size: 100n,                             // shares
    nonce: 1n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 300),  // Unix SECONDS
  },
  new PrivateKeyOrderSigner(privateKey),
);
// signed.signature (65-byte r,s,v) and signed.makerPubkey are Uint8Array —
// bytesToHex(...) to transport them.
```

## API surface

| Group | Members |
|---|---|
| Agent | `MolfiAgent` (`create`, `onboard`, `markets`, `orderBook`, `leaderboard`, `vaults`, `onChainMarkets`, `bet`, `betZk`, `redeem`, `fxrp`, `winningOutcome`) |
| Chain | `MolfiChain` (`faucet`, `fxrpBalance`, `bet`, `betZk`, `redeem`, `escrowTotal`, `escrowPosition`, `isResolved`, `winningOutcome`, `resolveFromOracle`) — plus the public `config`, `chain`, `pub` (viem `PublicClient`, the escape hatch for raw reads) and the `address` getter |
| Wallet | `generateWallet`, `walletFromSecret` (EVM keys) |
| Data | `fetchMarkets`, `fetchMarket`, `fetchOrderBook`, `fetchPrices`, `fetchLeaderboard`, `fetchVaults`, `fetchOnChainMarkets` |
| Config | `TESTNET`, `toBaseUnits`, `fromBaseUnits`, `OUTCOME_YES`, `OUTCOME_NO` |
| CLOB | `signClobOrder`, `canonicalOrderBytes`, `PrivateKeyOrderSigner`, `buildOrder`, `canonicalize` |

FXRP has **6 decimals** — XRP is denominated in drops, so 1 FXRP = 1_000_000.
Outcomes: YES=0, NO=1. Default config targets **Flare Coston2** (chain id **114**).
Run the suites with `npm test` here and in [`../molfi-mcp`](../molfi-mcp).
