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

> Built for **Flare Summer Signal** — **Bounty 1, Interoperable Asset Products**
> (FAssets/FXRP collateral settled by FTSOv2) and **Bounty 2, Confidential
> Compute Apps** ([a sealed-bid book opened inside a registered Flare
> Confidential Compute enclave](#bounty-2--sealed-bid-markets-inside-flare-confidential-compute)).
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
| `PredictEscrow` | [`0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067`](https://coston2-explorer.flare.network/address/0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067) |
| `ConfidentialBet` | [`0x1e5e41cbC1e6FB96635DBc3191A03d8CC970ba99`](https://coston2-explorer.flare.network/address/0x1e5e41cbC1e6FB96635DBc3191A03d8CC970ba99) |
| `ConfidentialBetVerifier` (BN254) | [`0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5`](https://coston2-explorer.flare.network/address/0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5) |
| `FXRP` (FAssets FTestXRP, 6 dp) | [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) |
| `SealedBidBook` (FCC) | [`0x10B3199147B5B08b15224d1b6149b5e32697396C`](https://coston2-explorer.flare.network/address/0x10B3199147B5B08b15224d1b6149b5e32697396C) |
| `MolfiInstructionSender` (FCC) | [`0xF91a16Ae48609927EA9220508dda9DEA2149B846`](https://coston2-explorer.flare.network/address/0xF91a16Ae48609927EA9220508dda9DEA2149B846) |
| `Web2JsonOracle` (FDC) | [`0xD1f281023Eb50a11Df96b496FE35aFB98b9deC28`](https://coston2-explorer.flare.network/address/0xD1f281023Eb50a11Df96b496FE35aFB98b9deC28) |

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
| [`molfi-fcc`](./molfi-fcc) | **Flare Confidential Compute** — the TypeScript extension that runs *inside* the registered TEE image, plus registration and live-verification scripts |

## Run it

```bash
# 1. contracts
cd molfi-contracts && npm i && npx hardhat test          # 143/143
npx hardhat run scripts/check-flare.ts --network coston2 # read-only preflight

# 2. backend  (needs MongoDB; see molfi-backend/.env.example)
cd ../molfi-backend && npm i && node --env-file=.env server.js   # :4100

# 3. app
cd ../molfi-app && npm i && npm run dev                  # :8090
```

Get testnet **C2FLR + FXRP** from https://faucet.flare.network/coston2 — on
Coston2 the faucet dispenses FXRP directly, so the full FAssets mint flow isn't
needed to try the app.

## Tests

| Package | Command | Result |
|---|---|---|
| `molfi-contracts` | `npx hardhat test` | **143/143** |
| `molfi-predict-sdk` | `npm test` | **15/15** |
| `molfi-mcp` | `npm test` | **12/12** |
| `molfi-mcp` | `npm run selftest` | live on Coston2 — reads + a real bet |
| `molfi-fcc` | `npm test` | **18/18** — the enclave's seal/open, cross-checked against the browser sealer |
| `molfi-backend` | `npm test` | **30/30** |
| `molfi-app` | `npx vitest run` | **35/35** (4 skipped: live-network e2e) |
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

## Bounty 2 — sealed-bid markets inside Flare Confidential Compute

A prediction market leaks its own signal. The moment a bet lands, the pool split
is public, so late bettors read the crowd instead of the question and early ones
get front-run. The usual answers are off-chain order books or trusted operators.

Molfi's answer is a **sealed book**: each bid's *side* is encrypted in the
browser to a key that only a registered Flare Confidential Compute enclave holds.
The stake is public — it moves through `transferFrom` either way — but the YES/NO
split genuinely does not exist on-chain until the market closes. Then the enclave
opens the book and returns a signed aggregate the contract verifies.

**This is not a mock TEE.** The extension is registered with Flare's
`FlareTeeManager` and reached the network's own availability check:

| | |
|---|---|
| `FlareTeeManager` | [`0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`](https://coston2-explorer.flare.network/address/0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE) |
| `EXTENSION_ID` | `0x…01023c` (66108) |
| TEE machine | `0x0A752D897f7D61Ce0690EEF812027000813467bb` |
| Status | **`2` = PRODUCTION** |
| Enclave sealing key | `0x02a26c712091177a68e3d1b68cf7ce4a4010b76653382c76a9b11c3d05b9eae77c` |
| Enclave signer (`teeSigner`) | `0x6a066930CD29B1e3f9c697B7dc13cc18a0824069` |

Verify the status yourself, independently of anything in this repo:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" \
  0x0A752D897f7D61Ce0690EEF812027000813467bb \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
# → 2
```

A machine that is unreachable stalls at `1` (INITIALIZED). Getting to `2` means
Flare's data providers reached the machine at its registered URL, requested
`tee-attestation`, matched policy consistency against an on-chain reward epoch,
and obtained the availability proof. The `2` is the network's verdict, not ours.

**Honest caveat, stated up front:** registration ran with `SIMULATED_TEE=true`.
The registration, routing, signing scheme and on-chain verification are all real
and reproducible; the hardware root of trust is not. On real hardware the same
image and the same handler run unchanged — what changes is that the attestation
quote is signed by the CPU rather than the simulator. We would rather say that
than let a judge discover it.

### What runs inside the registered image

The Molfi handler is compiled **into** the registered image, not run beside it —
so the code that holds the sealing key is the code the attestation covers:

```
Flare data providers ──signed instruction──▶ tee-proxy ──▶ TEE node ──▶ extension
                                                                        MOLFI/SEAL_KEY
                                                                        MOLFI/OPEN_BOOK
```

- **`MOLFI/SEAL_KEY`** returns the enclave's secp256k1 public key. The browser
  seals a bid to it with ECIES (ephemeral key → ECDH → HKDF-SHA256 → AES-256-GCM,
  with `(marketId, bidder)` as GCM additional data, so a ciphertext cannot be
  replayed onto another market or bidder).
- **`MOLFI/OPEN_BOOK`** runs after close: the enclave reads every sealed bid from
  chain, decrypts each side *inside* the enclave, and returns the YES/NO
  aggregate ABI-encoded, signed under Flare's `TEE_ACTION_RESULT` scheme.
  `SealedBidBook.openMarketFromTee` recovers the signer and rejects anything not
  signed by the registered `teeSigner`.

Ops route on `(opType, opCommand)` as right-padded UTF-8 `bytes32` — **not**
`keccak`, which is the single most common way to get an FCC extension silently
ignored.

### Two paths to open the book

Both are implemented. One is reliable; the other is reliable only when the RPC
is, and we would rather say so than let you find out.

1. **Off-chain call** — the backend asks the enclave directly and relays the
   signed result. Fast, and what the app uses. Verified end to end: the enclave
   signs, `openMarketFromTee` accepts, the winner is paid
   ([`live-tee-open.mjs`](molfi-fcc/scripts/live-tee-open.mjs)).
2. **On-chain instruction** — `MolfiInstructionSender` emits an instruction that
   Flare's data providers pick up and deliver to the enclave, with no server in
   the loop at all. This is the trust-minimized path: the enclave is driven by
   the chain, not by us.

**The honest caveat on path 2.** Every link works — the instruction is emitted,
the registry picks a machine we do not choose, that machine calls the extension
and signs the answer with its attested identity. What is fragile is the budget:
`tee-node`'s `ProxyTimeout` is a hard-coded 2 seconds, and the extension's first
call for a market it has never seen must read the book from Coston2's *public*
RPC. When that RPC is healthy the call lands well inside 2s and the path
completes. When it is rate-limiting — a shared testnet gateway, 429s — the first
attempt is cut off and the signed result carries `status: 3` and empty `data`.
`tee-node` retries and the second attempt succeeds in ~10ms off the warm cache,
but the proxy publishes only the *first* result for an instruction id, so the
retry is not the one a caller can fetch.

That is a deployment constraint, not a design flaw, and the fix is a dedicated
RPC endpoint for the enclave rather than the public one. We have left the
registered machine untouched rather than rebuild for it: restarting the stack
regenerates the node's identity key, and the machine address published above —
the one you can verify yourself — would no longer be the one answering.

```bash
cd molfi-fcc
node scripts/live-tee-open.mjs          # path 1, against the live enclave
node scripts/live-instruction-open.mjs  # path 2, fully on-chain
node scripts/hackathon-flow.mjs         # the whole judge flow, 7 stages
```

### Bounty 1 × Bounty 2

The two bounties are the same product, not two demos. A sealed bid escrows the
same **FXRP** in the same `PredictEscrow`, and settles against the same
**FTSOv2** feed — confidentiality is a property of the order flow, not a
separate app.

## FDC — markets on any public JSON API

`Web2JsonOracle` settles markets against data FTSOv2 does not carry, using the
Flare Data Connector's `Web2Json` attestation type. A feed is bound to
`keccak256(abi.encode(requestBody))`, so a proof for one URL and jq filter cannot
be replayed onto another feed, and `submitAttestation` is permissionless —
anyone can push a proof, nobody can forge one. Ordering and freshness come from
the attestation's **voting round**, not `lowestUsedTimestamp`, which FDC returns
as `2^64-1` and which would otherwise make every reading look infinitely fresh
while freezing the feed at its first value.

```bash
cd molfi-backend && node -e "import('./web2json.js').then(m=>m.runFeed('XRP-USD'))"
```

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
- **The whole Flare Confidential Compute surface, new in this hackathon** —
  `SealedBidBook.sol`, the TypeScript extension compiled into the registered TEE
  image, the ECIES browser sealer, a port of Flare's `TEE_ACTION_RESULT` signing
  scheme to Solidity (`TeeActionResult.sol`, with s-malleability and v-normalization
  guards), `MolfiInstructionSender` for the on-chain instruction path, and
  registration to `PRODUCTION` on `FlareTeeManager`. See
  [Bounty 2](#bounty-2--sealed-bid-markets-inside-flare-confidential-compute).
- **FDC `Web2Json` settlement, new in this hackathon** — `Web2JsonOracle.sol`
  plus the full prepare → submit → proof → on-chain pipeline in the backend, so a
  market can settle against any public JSON API rather than only an FTSO feed.
- **Blockscout log indexing** — Coston2's RPC caps `eth_getLogs` at 30 blocks,
  which cannot reach a market that settled an hour ago. Escrow history and
  settlement prices are read from the explorer instead, decoding topics locally
  (the explorer returns `decoded: null` for unverified contracts, so matching on
  `decoded.method_call` — the obvious approach — silently indexes nothing).
- **An unattended market keeper** — rolls markets forward on a per-symbol cadence
  and settles them from FTSOv2, with derived slot ids so two keepers collide on
  `Exists` rather than double-creating.

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

The Confidential Compute registration is real and reached `PRODUCTION`, but it
ran with `SIMULATED_TEE=true` — the routing, signing and on-chain verification
are genuine, the hardware root of trust is not. The sealed book therefore
demonstrates the full mechanism without yet inheriting hardware attestation.

---

_Flare · Coston2 · FAssets (FXRP) · FTSOv2 · FDC (Web2Json) · Flare Confidential Compute · Circom/Groth16 (BN254) · Hardhat · React_
