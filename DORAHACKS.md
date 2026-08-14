# DoraHacks BUIDL submission — Molfi

Everything below is copy-paste ready. Fields are in the order the DoraHacks form
asks for them. Anything I could not know is marked **`<FILL IN>`** — those are the
only blanks; nothing else needs editing.

---

## BUIDL logo

`demo/out/molfi-logo-480.png` — 480 × 480 PNG, 90 KB (limit is 2 MB).

Regenerate any time with `node demo/logo.mjs`. It uses the app's own mark
(`molfi-app/public/molfi.svg`), so the tile and the product are visibly the same
thing.

---

## BUIDL (project) name

```
Molfi
```

If a longer name reads better in the listing:

```
Molfi — XRP-settled prediction markets on Flare
```

---

## Vision

### The problem this project solves

```
Prediction markets have a privacy problem that is structural, not cosmetic.

The moment a bet lands, the pool split is public. Late bettors stop reading the
question and start reading the crowd, so the market prices consensus instead of
information — and anyone can see exactly which side you took, at what size, in
which market, forever. That is fine for a toy and disqualifying for anyone whose
position is a signal: a fund, a market maker, a trader with a view worth having.

The usual fix is to move the order book off-chain, which trades the leak for a
custodian you have to trust with settlement.

Molfi keeps settlement on-chain and gives the bettor three levels of disclosure
instead of one:

  * Public   — an ordinary bet. Side and size visible to anyone.
  * Private  — the stake enters as a fixed-denomination commitment note. The
               chain sees a hash, not a side; after settlement you claim with a
               Groth16 proof that cannot be linked to the deposit.
  * Sealed   — the bid is encrypted to a TEE's public key before it leaves the
               browser. The YES/NO split does not exist on-chain until the
               market closes and the enclave signs the aggregate, which the
               contract verifies with ecrecover.

Settlement itself never leaves the chain: FTSOv2 for prices, the Flare Data
Connector for public JSON APIs, FXRP from FAssets as collateral. The result is a
venue where you choose what to reveal, and nobody has to be trusted to settle.
```

### Vision (256 characters)

```
Molfi turns any price feed or public API into a prediction market on Flare, settled by FTSOv2 in FXRP — and lets you bet publicly, privately with a zero-knowledge proof, or sealed inside a TEE so the crowd cannot read your side before close.
```

*(241 characters, including spaces.)*

---

## Category

```
DeFi
```

Secondary tags, if the form allows more than one: `Privacy`, `Infrastructure`,
`Oracle`.

---

## Links

| Field | Value |
| --- | --- |
| GitHub | `https://github.com/nickthelegend/molfi-flare-monorepo` |
| Project website | `https://molfi.fun` |
| Demo video | **`<FILL IN>`** — upload `demo/out/molfi-demo.mp4` to YouTube and paste the watch URL |

### Social links (at least one required)

I don't know your accounts, so these are blanks rather than guesses — a wrong
handle on a submission is worse than an empty field.

| Field | Value |
| --- | --- |
| Link 1 | **`<FILL IN>`** — e.g. `https://x.com/<your-handle>` |
| Link 2 | *(optional)* |
| Link 3 | *(optional)* |

If you have no project account, your personal X/GitHub profile is accepted and
is better than leaving the section empty.

---

## Description — paste this into the BUIDL description field

```markdown
## Molfi — XRP-settled prediction markets on Flare

Bet on where a price lands. Stake FXRP, settle against Flare's own oracle, and
choose how much of your position the world gets to see.

**Live:** https://molfi.fun · Flare Coston2 (chain 114)

---

### The problem

A prediction market leaks its own signal. The instant a bet lands, the pool
split is public — so late bettors read the crowd instead of the question, and
the market ends up pricing consensus rather than information. Your side, your
size, and your timing are permanent and public.

Moving the book off-chain hides the leak by introducing a custodian. Molfi keeps
settlement on-chain and makes disclosure the bettor's choice.

### Three ways to bet, all settling to the same contracts

| Mode | What the chain sees | How it works |
| --- | --- | --- |
| **Public** | Side, size, market | An ordinary escrowed bet. |
| **Private** | A commitment hash | The stake enters as a fixed-denomination note — indistinguishable from every other note of that size. After settlement you claim with a **BN254 Groth16** proof; a nullifier prevents a second claim, and nothing links the claim to the deposit. |
| **Sealed** | A stake and an opaque blob | Your browser encrypts the side to the enclave's public key. The YES/NO split does not exist on-chain until close, when the enclave opens every bid, signs the aggregate, and `SealedBidBook` verifies that signature with `ecrecover`. |

Pricing is pari-mutuel — winners split the pot pro-rata, net of a 2% fee that
accrues to the liquidity vault.

### Built on Flare, not bolted onto it

A prediction market needs four things: a price to settle on, a way to reach the
world outside the chain, collateral worth betting, and somewhere to keep a
secret. On most chains those are four separate vendors. On Flare they are
enshrined protocols secured by the same validator set — which is why Molfi is a
set of contracts rather than a stack of integrations.

* **FTSOv2** — settlement price, produced by the validators that secure the
  chain. The number shown in the UI is the number settlement uses.
* **FAssets (FXRP)** — real XRP as collateral, 6 decimals, minted through the
  FAssets agent flow.
* **Flare Data Connector** — Web2Json attestations let a market settle against
  any public JSON API, verified on-chain as a Merkle proof against a voting
  round.
* **Flare Confidential Compute** — the sealed-bid enclave, running as an FCC
  image on Phala's dstack, registered on `FlareTeeManager`.

### Deployed on Coston2

| Contract | Address |
| --- | --- |
| `MolfiMarket` | `0xD709773A1128c1160b292F505FAA8E3e8d0786fF` |
| `PredictEscrow` | `0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067` |
| `ConfidentialBet` | `0x1e5e41cbC1e6FB96635DBc3191A03d8CC970ba99` |
| `ConfidentialBetVerifier` (BN254) | `0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5` |
| `SealedBidBook` (FCC) | `0x10B3199147B5B08b15224d1b6149b5e32697396C` |
| `MolfiInstructionSender` (FCC) | `0xF91a16Ae48609927EA9220508dda9DEA2149B846` |
| `Web2JsonOracle` (FDC) | `0xD1f281023Eb50a11Df96b496FE35aFB98b9deC28` |
| `FXRP` (FAssets FTestXRP) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |

Every transaction in the demo video is on the
[Coston2 explorer](https://coston2-explorer.flare.network) — one per mode,
against three different contracts.

### What's running

Markets roll forward on their own: a keeper opens each slot, seeds both sides
and settles at close against FTSOv2. The portfolio, leaderboard and vault
figures are all derived from chain events rather than a mirrored database.

### Roadmap

* XRP settlement through FAssets on Songbird, then Flare mainnet.
* Sealed markets opened by a quorum of enclaves rather than a single one.
* The Data Connector pointed at sports, elections, and anything else with a
  public API.
* Deeper vault liquidity so larger positions clear at the same price.

### Scope

Molfi runs on **Flare Coston2 testnet** with testnet FXRP. The sealed-bid
enclave is registered on `FlareTeeManager` and reads status 2 (PRODUCTION) —
Flare's own verdict on reachability, governance and availability. That status
does not assert a hardware measurement: registration ran with the FCC
scaffold's `SIMULATED_TEE` default, so the attestation quote came from dstack's
simulator rather than an Intel TDX CPU. The sealing, the key custody and the
`ecrecover` check are real and on-chain; the hardware root of trust is the piece
that lands with a production CVM.
```

---

## Notes before you submit

1. **The demo video needs uploading.** `demo/out/molfi-demo.mp4` (6m 43s,
   14.4 MB) — YouTube renders as an embedded player on the BUIDL page, which is
   what DoraHacks recommends. Subtitles are in `demo/out/molfi-demo.srt`; upload
   them alongside so the video is legible with sound off.
2. **The scope paragraph is deliberate.** Judges check this. Claiming a
   hardware-attested enclave when registration used the simulator default is the
   one thing that would sink an otherwise strong submission on inspection — the
   wording above claims the parts that hold and names the part that doesn't.
3. **Rotate the exposed credentials** before making the repo more visible: the
   Heroku API key, the Atlas password, and the two GitHub PATs from this
   session's history.
