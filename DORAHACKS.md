# Molfi — submission copy

Copy-paste ready. **No markdown tables anywhere** — the DoraHacks editor renders
them as raw pipes, which is what made the contract addresses unreadable. Plain
headings and lists only.

Blanks are marked **`<FILL IN>`** and are the only things that need editing.

---

## 1. BUIDL logo

`demo/out/molfi-logo-480.png` — 480 × 480 PNG, 90 KB (limit 2 MB).
Rebuild with `node demo/logo.mjs`.

## 2. BUIDL name

```
Molfi
```

## 3. Category

```
DeFi
```

Also tag `Privacy`, `Infrastructure`, `Oracle` if multiple are allowed.

## 4. Vision (256 characters)

```
Molfi turns any price feed or public API into a prediction market on Flare, settled by FTSOv2 in FXRP — and lets you bet publicly, privately with a zero-knowledge proof, or sealed inside a TEE so the crowd cannot read your side before close.
```

*241 characters.*

## 5. Links

- GitHub — `https://github.com/nickthelegend/molfi-flare-monorepo`
- Website — `https://molfi.fun`
- Demo video — **`<FILL IN>`** (upload `demo/out/molfi-demo.mp4` to YouTube)
- Social link 1 — **`<FILL IN>`** (e.g. `https://x.com/<your-handle>`)

---

## 6. Description — paste everything in this block

```markdown
## Molfi — XRP-settled prediction markets on Flare

Bet on where a price lands. Stake FXRP, settle against Flare's own oracle, and
choose how much of your position the world gets to see.

**Live at https://molfi.fun** · Flare Coston2 (chain 114)

### The problem

A prediction market leaks its own signal. The instant a bet lands the pool split
is public, so late bettors read the crowd instead of the question and the market
prices consensus rather than information. Your side, your size and your timing
are permanent and public.

That is fine for a toy and disqualifying for anyone whose position is itself a
signal — a fund, a market maker, a trader with a view worth having. The usual
fix is to move the order book off-chain, which trades the leak for a custodian
you have to trust with settlement.

Molfi keeps settlement on-chain and makes disclosure the bettor's choice.

### Three ways to bet, all settling to the same contracts

**Public.** An ordinary escrowed bet. Side and size are visible to anyone.

**Private.** The stake enters as a commitment note at a fixed denomination, so
on-chain it is indistinguishable from every other note of that size. The chain
sees a hash, never a side. After settlement you claim with a BN254 Groth16
proof; a nullifier prevents a second claim, and nothing links the claim to the
deposit.

**Sealed.** Your browser encrypts the side to a TEE's public key before it
leaves the page. The YES/NO split does not exist on-chain until the market
closes, when the enclave opens every bid, signs the aggregate, and SealedBidBook
verifies that signature with ecrecover.

Pricing is pari-mutuel — winners split the pot pro-rata, net of a 2% fee that
accrues to the liquidity vault.

### How the sealed bid stays sealed

1. Your browser encrypts the side to the enclave's public key. The stake stays
   public; the side does not.
2. SealedBidBook stores an opaque blob. Nothing on Coston2 reveals which way the
   bid leaned.
3. Only the enclave holds the key — a Flare Confidential Compute image on
   Phala's dstack, memory the CPU keeps encrypted, registered on FlareTeeManager
   and reachable at status 2.
4. At close the enclave decrypts every bid, aggregates, and signs the result.
5. The contract checks that signature with ecrecover against the registered
   teeSigner. A total nobody in the enclave signed is not accepted.

### Built on Flare, not bolted onto it

A prediction market needs four things: a price to settle on, a way to reach the
world outside the chain, collateral worth betting, and somewhere to keep a
secret. On most chains those are four separate vendors. On Flare they are
enshrined protocols secured by the same validator set — which is why Molfi is a
set of contracts rather than a stack of integrations.

- **FTSOv2** — the settlement price, produced by the validators that secure the
  chain. The number in the UI is the number settlement uses.
- **FAssets (FXRP)** — real XRP as collateral, 6 decimals, minted through the
  FAssets agent flow.
- **Flare Data Connector** — Web2Json attestations let a market settle against
  any public JSON API, verified on-chain as a Merkle proof against a voting
  round.
- **Flare Confidential Compute** — the sealed-bid enclave.

### Deployed on Coston2

- MolfiMarket — `0xD709773A1128c1160b292F505FAA8E3e8d0786fF`
- PredictEscrow — `0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067`
- ConfidentialBet — `0x1e5e41cbC1e6FB96635DBc3191A03d8CC970ba99`
- ConfidentialBetVerifier (BN254) — `0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5`
- SealedBidBook (FCC) — `0x10B3199147B5B08b15224d1b6149b5e32697396C`
- MolfiInstructionSender (FCC) — `0xF91a16Ae48609927EA9220508dda9DEA2149B846`
- Web2JsonOracle (FDC) — `0xD1f281023Eb50a11Df96b496FE35aFB98b9deC28`
- FXRP (FAssets FTestXRP) — `0x0b6A3645c240605887a5532109323A3E12273dc7`

Browse any of them at https://coston2-explorer.flare.network

### What the demo shows

Four transactions, signed live, each against a different contract — a public
bet, a private commitment, a sealed bid, and a vault deposit — with every one
opened on the Coston2 explorer immediately after it lands.

Markets roll forward on their own: a keeper opens each slot, seeds both sides
and settles at close against FTSOv2. The portfolio, leaderboard and vault
figures are derived from chain events rather than a mirrored database.

### Roadmap

- XRP settlement through FAssets on Songbird, then Flare mainnet.
- Sealed markets opened by a quorum of enclaves rather than a single one.
- The Data Connector pointed at sports, elections, and any public API.
- Deeper vault liquidity so larger positions clear at the same price.

### Scope

Molfi runs on Flare Coston2 testnet with testnet FXRP. The sealed-bid enclave is
registered on FlareTeeManager and reads status 2 (PRODUCTION) — Flare's own
verdict on reachability, governance and availability. That status does not
assert a hardware measurement: registration ran with the FCC scaffold's
SIMULATED_TEE default, so the attestation quote came from dstack's simulator
rather than an Intel TDX CPU. The sealing, the key custody and the ecrecover
check are real and on-chain; the hardware root of trust is the piece that lands
with a production CVM.
```

---

## 7. YouTube — title

Primary (59 characters, survives truncation in search):

```
Molfi: private prediction markets on Flare, settled in FXRP
```

Alternates:

```
Molfi — bet public, private, or sealed inside a TEE | Flare + FXRP
```

```
Prediction markets that don't leak your side — Molfi on Flare
```

## 8. YouTube — description

```
Molfi turns any price feed or public API into a prediction market on Flare — settled by FTSOv2, collateralised in FXRP, and with three levels of privacy you choose per bet.

A prediction market leaks its own signal: the moment a bet lands the pool split is public, so late bettors read the crowd instead of the question. Molfi keeps settlement on-chain and lets you decide what to reveal — a public bet, a private one behind a zero-knowledge proof, or a sealed bid encrypted to a TEE that nobody can read until the market closes.

Every transaction in this video is real and signed live on Flare Coston2 — a public bet, a private commitment, a sealed bid and a vault deposit, each opened on the block explorer straight after it lands.

Try it: https://molfi.fun
Code: https://github.com/nickthelegend/molfi-flare-monorepo
Explorer: https://coston2-explorer.flare.network

CHAPTERS
0:00 Intro
0:03 Markets settled by FTSOv2
0:12 Live markets on Coston2
0:20 Inside a market
0:43 Placing a public bet
1:07 The public bet on the explorer
1:16 Private mode — commitment notes
1:34 No side in the transaction
1:44 The Groth16 proof
1:54 Sealed mode — the signal problem
2:05 How the TEE seal works
2:46 The sealed bid on-chain
2:59 Portfolio from chain events
3:06 The liquidity vault
3:21 Vault deposit on the explorer
3:37 Leaderboard
3:45 Flare Data Connector
4:06 Why Flare
4:25 What's next

BUILT ON
FTSOv2 for settlement prices, produced by the validators that secure the chain.
FAssets for FXRP — real XRP as collateral.
Flare Data Connector for settling against public JSON APIs, verified on-chain as a Merkle proof.
Flare Confidential Compute for the sealed-bid enclave, running on Phala's dstack.

CONTRACTS ON COSTON2
MolfiMarket 0xD709773A1128c1160b292F505FAA8E3e8d0786fF
PredictEscrow 0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067
ConfidentialBet 0x1e5e41cbC1e6FB96635DBc3191A03d8CC970ba99
ConfidentialBetVerifier 0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5
SealedBidBook 0x10B3199147B5B08b15224d1b6149b5e32697396C
Web2JsonOracle 0xD1f281023Eb50a11Df96b496FE35aFB98b9deC28
FXRP 0x0b6A3645c240605887a5532109323A3E12273dc7

SCOPE
Molfi runs on Flare Coston2 testnet with testnet FXRP. The sealed-bid enclave is registered on FlareTeeManager at status 2 — Flare's verdict on reachability, governance and availability. Registration used the FCC scaffold's SIMULATED_TEE default, so the attestation quote came from dstack's simulator rather than an Intel TDX CPU: the sealing, key custody and ecrecover check are real and on-chain, and the hardware root of trust lands with a production CVM.

#Flare #FXRP #PredictionMarkets #ZeroKnowledge #TEE #DeFi
```

### Uploading

- Subtitles: upload `demo/out/molfi-demo.srt` under Subtitles → English. The
  video already has captions burned in, but the SRT makes it searchable and
  gives viewers a transcript.
- Chapters work because the first timestamp is `0:00` and there are at least
  three of them — keep that if you edit the list.

---

## Before you submit

1. Upload the video and paste the URL into the DoraHacks demo field.
2. Add at least one social link — a personal X or GitHub profile is accepted.
3. Rotate the credentials exposed during development: the Heroku API key, the
   Atlas password, and the two GitHub PATs.
