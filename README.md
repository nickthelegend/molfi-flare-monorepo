<h1 align="center">Molfi on Flare</h1>

<p align="center"><b>XRP-settled prediction markets, collateralized in FXRP.</b></p>

<p align="center">
Take a position on where a price lands, stake <b>FXRP</b> — the FAssets
representation of real XRP — and settle against <b>FTSOv2</b>, Flare's
first-party oracle. XRP holders get exposure to a real derivative without their
asset ever leaving Flare's custody model.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Flare-Coston2-e62058" alt="Coston2" />
  <img src="https://img.shields.io/badge/collateral-FXRP%20(FAssets)-23a2f6" alt="FXRP" />
  <img src="https://img.shields.io/badge/oracle-FTSOv2-2fbf71" alt="FTSOv2" />
  <img src="https://img.shields.io/badge/ZK-Groth16%20BN254-a855f7" alt="ZK" />
</p>

> Built for **Flare Summer Signal** — Bounty 1, Interoperable Asset Products.
> This is a port of [Molfi on Avalanche](https://github.com/nickthelegend/molfi-predict-avax-monorepo);
> see [What was built during the hackathon](#what-was-built-during-the-hackathon).

---

## Why this is an interoperable-asset product

XRP has no smart contracts. Historically, an XRP holder who wanted derivative
exposure had to sell into another asset or trust a centralized venue.

FAssets changes the input, and Molfi is what you can build on top of it:

- **Collateral is FXRP** — a 1:1, over-collateralized claim on XRP held by
  FAssets agents, redeemable back to the XRP Ledger at any time. Not a mock
  token, not a stablecoin standing in for XRP.
- **Settlement is FTSOv2** — Flare's native oracle, produced by the same
  validator set that secures the chain. No third-party oracle network sits
  between the market and its price.
- **The round trip stays on Flare.** Mint FXRP from XRP, take a position, settle,
  redeem back to XRP. The asset never touches a centralized bridge or exchange.

The Avalanche version of this app escrowed a mock ERC-20 with an open `mint()`.
Swapping that for FXRP is not a token substitution — it changes what the product
*is*, and it is why the faucet button in this build is a link rather than a
contract call.

## Deployed on Coston2 (chainId 114)

| Contract | Address |
|---|---|
| `FtsoOracle` | [`0xABB3FAFD87F60a8dEA8C2074C1A36984305fB099`](https://coston2-explorer.flare.network/address/0xABB3FAFD87F60a8dEA8C2074C1A36984305fB099) |
| `MolfiMarket` | [`0xD709773A1128c1160b292F505FAA8E3e8d0786fF`](https://coston2-explorer.flare.network/address/0xD709773A1128c1160b292F505FAA8E3e8d0786fF) |
| `PredictEscrow` | [`0x75dd1eA3e80E3B32f639bDA0894Dd2c15A58a865`](https://coston2-explorer.flare.network/address/0x75dd1eA3e80E3B32f639bDA0894Dd2c15A58a865) |
| `ConfidentialBet` | [`0xd765Fa0886FD534A176190828fc4A47c8C3Fbfd0`](https://coston2-explorer.flare.network/address/0xd765Fa0886FD534A176190828fc4A47c8C3Fbfd0) |
| `ConfidentialBetVerifier` (BN254) | [`0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5`](https://coston2-explorer.flare.network/address/0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5) |
| `FXRP` (FAssets FTestXRP, 6 dp) | [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) |

FXRP is resolved through `ContractRegistry.getAssetManagerFXRP().fAsset()` rather
than hardcoded — Flare upgrades protocol contracts by re-pointing the registry.

## Live end-to-end — real FXRP, real settlement

Run against the deployed contracts, no mocks anywhere:

```bash
cd molfi-contracts && npx hardhat run scripts/e2e-live.ts --network coston2
```

It creates a market from the current FTSO price, funds two independent EOAs,
stakes real FXRP on both sides, waits for close, settles **permissionlessly from
the counterparty's wallet**, and redeems:

```
[1] FTSOv2 XRP/USD = $1.063932
[4] alice 0.02 FXRP → YES · bob 0.04 FXRP → NO · pot 0.06 FXRP
[5] settled by counterparty (permissionless) → YES
[6] alice payout 0.0588 FXRP · bob (loser) refused ✅

payout 0.0588 FXRP (expected 0.0588)   ← pot minus the 2% fee
```

## Packages

| Package | Role |
|---|---|
| [`molfi-contracts`](./molfi-contracts) | Solidity — market lifecycle, FXRP escrow, FTSO oracle adapter, ZK verifier (Hardhat) |
| [`molfi-backend`](./molfi-backend) | Market engine — seeds rolling markets, serves on-chain state, prices from FTSO |
| [`molfi-app`](./molfi-app) | Trading UI — React + Vite + wagmi/viem on Coston2 |
| [`molfi-mcp`](./molfi-mcp) | **MCP server** — any MCP agent browses markets, stakes FXRP, settles, redeems |
| [`molfi-predict-sdk`](./molfi-predict-sdk) | Agent SDK + `SKILL.md` — an LLM agent can run the full lifecycle |
| [`molfi-circuits`](./molfi-circuits) | Circom BN254 circuits + proving artifacts |

## Run it

```bash
# 1. contracts
cd molfi-contracts && npm i && npx hardhat test          # 56/56
npx hardhat run scripts/check-flare.ts --network coston2 # read-only preflight

# 2. backend  (needs MongoDB; see molfi-backend/.env.example)
cd ../molfi-backend && npm i && node --env-file=.env server.js   # :4100

# 3. app
cd ../molfi-app && npm i && npm run dev                  # :8080
```

Get testnet **C2FLR + FXRP** from https://faucet.flare.network/coston2 — on
Coston2 the faucet dispenses FXRP directly, so the full FAssets mint flow isn't
needed to try the app.

## Tests

| Package | Command | Result |
|---|---|---|
| `molfi-contracts` | `npx hardhat test` | **56/56** |
| `molfi-predict-sdk` | `npm test` | **12/12** |
| `molfi-mcp` | `npm test` | **11/11** |
| `molfi-mcp` | `npm run selftest` | live on Coston2 — reads + a real bet |
| live e2e | `npx hardhat run scripts/e2e-live.ts --network coston2` | passing on Coston2 |

## Two things Coston2 taught us

**`eth_estimateGas` under-reports FXRP transfers.** Measured: a transfer burns
**151,388** gas every time, but estimation intermittently returns **130,981**.
Using the estimate as the limit produces an out-of-gas revert with *empty* revert
data — indistinguishable from a policy rejection, which sends you looking for a
whitelist that doesn't exist. FAssets does transfer-fee epoch bookkeeping whose
cost depends on execution-time state. Every FXRP-moving call here sends an
explicit gas limit; see [`scripts/fassets-gas.ts`](./molfi-contracts/scripts/fassets-gas.ts).

**FTSO feed decimals are not uniform.** Observed on Coston2: XRP **6**, FLR **8**,
BTC **2**, ETH **3** — and they can change. The Chainlink build hardcoded `e8`;
doing that here would silently settle markets against the wrong scale. Prices are
read via `getFeedByIdInWei`, normalized to 18 decimals by the protocol.

## What was built during the hackathon

**Pre-existing:** the Molfi product concept, the premium trading UI, the Circom
circuit design, and the Avalanche/Fuji implementation it was ported from.

**Built here:**

- The entire on-chain layer for Flare — `FtsoOracle` (new), `MolfiMarket`
  re-pointed from Chainlink aggregators to `bytes21` FTSO feed ids with
  18-decimal thresholds, `PredictEscrow` re-collateralized in FXRP at 6 decimals,
  deployed to Coston2, and 56 tests written from scratch.
- The FXRP integration — registry-resolved collateral, the gas-limit discovery
  above, and the product change from "mint yourself funds" to real bridged XRP.
- The backend's chain layer, rewritten so prices come from the deployed
  `FtsoOracle` — the number shown is the number settlement uses. The on-chain
  markets endpoint was also parallelized (13.7s → 2.5s for 16 markets).
- The frontend port to Coston2, plus fixes for six defects that made the app
  unusable — most importantly an `_app` layout loader that awaited a Sui indexer
  inherited from the upstream fork and therefore never resolved, freezing every
  screen on its loading skeleton.
- The agent SDK and `SKILL.md` re-pointed at Coston2/FXRP.
- **`molfi-mcp`, new in this hackathon** — an MCP server exposing eight Molfi
  tools so any MCP-capable agent can trade the markets directly. Verified by a
  live self-test that places a real FXRP bet on Coston2.

**Corrected while porting:** the Avalanche README advertised eERC confidential
stakes. That was never implemented in code — a full audit found eERC only in two
dead config fields and marketing copy. This build does not repeat the claim. The
real confidentiality is the Groth16 hidden-side circuit, described honestly in
[`SKILL.md`](./molfi-predict-sdk/SKILL.md).

## Honest scope

Testnet only, unaudited. Confidential bets hide the side and enforce
outcome-binding and single-use nullifiers on-chain, but the anonymity set is the
set of commitments under a registered root, and that Merkle root is checkpointed
by an operator (the EVM has no native Poseidon). Markets are seeded by an
operator; settlement itself is permissionless and anyone can call it.

---

_Flare · Coston2 · FAssets (FXRP) · FTSOv2 · Circom/Groth16 (BN254) · Hardhat · React_
