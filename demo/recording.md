# Molfi — demo recording plan

**Target:** one continuous raw take, ~7 minutes, narration-locked (one-clock method).
**Chain:** Flare Coston2 (114). **Blockchain app** — signing beats flagged `SIGNING`.

Real clicks, real typing, real RPC, real signed transactions, real enclave
responses. If a beat fails on camera it gets a real fix and a re-record.

## What Molfi is

XRP-settled prediction markets. Stake **FXRP** — the FAssets representation of
real XRP — on where a price lands; settle against **FTSOv2**, Flare's own oracle.
Three ways to bet: **public**, **private** (side hidden behind a Groth16
commitment), and **sealed** (side ECIES-encrypted to a Flare Confidential Compute
enclave and opened only after close).

## Surface

| Route | Content |
|---|---|
| `/` | Landing hero → CTA |
| `/markets` | Live market grid, categories, open/closed, search |
| `/predictions/<id>` | Spot, strike, YES odds, oracle, countdown, chart, pool depth, ticket (Standard/Private/Sealed), position, contract links |
| `/portfolio` | Positions, realized/unrealized P&L, win rate |
| `/vault` | TVL, NAV/share, lifetime fees, deposit, activity |
| `/leaderboard` | Ranked by realized PnL from Bet/Redeem events |
| `/guide` | Explainer incl. "What it runs on" |

Backend/enclave JSON shown as slides:

| Endpoint | Slide |
|---|---|
| `GET /api/health` | FTSOv2 prices, all four feeds |
| `GET /api/sealed/key` | **enclave pubkey + teeSigner + chainId — the TEE identity** |
| `GET /api/onchain/markets/:id` | market read straight from chain |
| `GET /api/zk/proof` | Groth16 proof shape |
| `GET /api/confidential/tiers` | note denominations |
| `GET /api/vaults` | vault state from `MolfiLpVault` |
| `GET /api/web2/attestations` | FDC Web2Json verdicts + voting rounds |

Contracts (Coston2): `PredictEscrow 0xbe2EEc9a…`, `MolfiMarket 0xD709773A…`,
`ConfidentialBet 0x1e5e41cb…`, `SealedBidBook 0x10B31991…`,
`MolfiLpVault 0x5F03D675…`, `FXRP 0x0b6A3645…`.

## Pre-flight

1. **Wallet** — molfi test wallet `0x3997bAD5…`, Coston2 only. Verified
   **9.03 FXRP / 6.2 C2FLR**. Never mainnet.
2. Clear `localStorage`/`sessionStorage`/IndexedDB before driving.
3. Injecting proxy supplies the wallet before the bundle boots; auto-approves so
   no extension popup can steal the capture. Signatures remain real.
4. Suppress `alert`/`confirm`/`prompt`.
5. Count console errors first; assert the count doesn't grow.
6. Verify recorder with its own 2s capture + frame check before the take.
7. Enclave `/api/sealed/key` must answer, else the sealed beats are cut.

## Beats

| # | id | Beat | Flags |
|---|---|---|---|
| 1 | `intro` | Landing hero — what Molfi is | |
| 2 | `markets` | Live market grid: question, strike, live spot, countdown, pot | |
| 3 | `market-open` | Open a market: spot vs strike, YES odds, FTSOv2, countdown, chart | |
| 4 | `pool-depth` | Pool depth read live from PredictEscrow — real staked FXRP | |
| 5 | `ftso-json` | **SLIDE** `/api/health` — the four FTSOv2 feeds settlement uses | SLIDE |
| 6 | `bet-enter` | Type a stake on the Standard tab; payout estimate is pari-mutuel, net of 2% | |
| 7 | `bet-sign` | Real `betZk` — held until Coston2 confirms | **SIGNING** |
| 8 | `bet-result` | Pool and position update to the same number | |
| 9 | `explorer-bet` | **SLIDE** the bet on Coston2 explorer — side visible, public bet | EXPLORER |
| 10 | `private-tab` | Private tab: tiers, commitment note, side hidden | |
| 11 | `zk-json` | **SLIDE** `/api/zk/proof` — BN254 Groth16 proof + public signals | SLIDE |
| 12 | `sealed-tab` | Sealed tab: book sealed, stake public, YES/NO split absent on-chain | |
| 13 | `tee-key-json` | **SLIDE** `/api/sealed/key` — **enclave pubkey, teeSigner, chainId 114** | SLIDE |
| 14 | `sealed-sign` | Real `sealBid` — side ECIES-sealed in browser, held until confirmed | **SIGNING** |
| 15 | `tee-tx-json` | **SLIDE** the sealed tx hash + the enclave's response for it | SLIDE |
| 16 | `portfolio` | Positions, realized P&L, win rate — all chain-derived | |
| 17 | `vault` | TVL, NAV/share, lifetime fees, activity from real events | |
| 18 | `vault-json` | **SLIDE** `/api/vaults` — the same numbers, read from `MolfiLpVault` | SLIDE |
| 19 | `leaderboard` | Ranked by realized PnL from Bet/Redeem events | |
| 20 | `fdc-json` | **SLIDE** `/api/web2/attestations` — FDC verdicts + voting rounds | SLIDE |
| 21 | `guide` | "What it runs on": FXRP/FAssets, FTSOv2, FDC, Confidential Compute | |
| 22 | `honest` | **SLIDE** the honest limit — `SIMULATED_TEE`, what status 2 does and doesn't prove | SLIDE |
| 23 | `outro` | Recap; thanks for watching | |

**Signing beats — 2:** `bet-sign`, `sealed-sign`. Each renders a full-bleed
"Signing Transaction" overlay held until a real receipt, and is marked `SIGNING`.

## The shot that has to land

**Beat 9 vs 12–15.** A public bet whose side is legible on the explorer, then a
sealed bid where the stake moves but the YES/NO split genuinely does not exist
on-chain until the enclave opens it. That contrast is the product.

## Honesty

Beat 22 states it plainly: molfi's FCC machine reads **status 2 (PRODUCTION)** on
`FlareTeeManager` — Flare's own verdict on reachability, governance and
availability — but registration ran with `SIMULATED_TEE=true`, so the quote came
from a simulator, not an Intel TDX CPU. The enclave in this recording is the
local one. Integrity of the opening still holds: `SealedBidBook` reconciles any
TEE-signed aggregate against its own escrow and bid count.

## Deliverables

`demo/raw/take.mp4` · `demo/audio/*.wav` + `durations.json` · `demo/raw/beats.log` · this file
