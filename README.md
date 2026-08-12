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

## Try it — live

| | |
|---|---|
| **App** | **https://molfi.fun** |
| API | https://molfi-backend-b2390041d5b6.herokuapp.com/api/health |

Live on Flare **Coston2** against the deployed contracts below. To place a bet,
get **C2FLR + FXRP** from https://faucet.flare.network/coston2 — on Coston2 the
faucet dispenses FXRP directly (100 C2FLR + 10 FXRP per address per 24h), so the
full FAssets mint flow is not needed to try the app.

Markets roll forward on their own: an unattended keeper opens each slot, seeds
both sides, and settles from FTSOv2 at close. Nothing on the page is seeded by
hand at demo time.

**One caveat, stated up front:** sealed-bid markets need the Flare Confidential
Compute enclave, which is not reachable from the hosted API yet. On
https://molfi.fun the Sealed tab reports the enclave as unreachable and disables
itself; **Standard and Private (ZK) bets work fully.** Run the stack locally
(below) to exercise the sealed book end to end.

## Run it

```bash
# 1. contracts
cd molfi-contracts && npm i && npx hardhat test          # 152/152
npx hardhat run scripts/check-flare.ts --network coston2 # read-only preflight

# 2. backend  (needs MongoDB; see molfi-backend/.env.example)
cd ../molfi-backend && npm i && node --env-file=.env server.js   # :4100

# 3. app
cd ../molfi-app && npm i && npm run dev                  # :8090
```

The local stack additionally reaches the Confidential Compute enclave on
`:6675`, so the sealed-bid path works here even though the hosted API cannot
reach it yet.

## Tests

| Package | Command | Result |
|---|---|---|
| `molfi-contracts` | `npx hardhat test` | **152/152** |
| `molfi-predict-sdk` | `npm test` | **15/15** |
| `molfi-mcp` | `npm test` | **12/12** |
| `molfi-mcp` | `npm run selftest` | live on Coston2 — reads + a real bet |
| `molfi-fcc` | `npm test` | **18/18** — the enclave's seal/open, cross-checked against the browser sealer |
| `molfi-backend` | `npm test` | **33/33** |
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

### What `PRODUCTION` proves, and what it does not

*This is the paragraph we submit. It is deliberately worded so it cannot be read
as "hardware-attested enclave", because it isn't one.*

> Molfi's sealed-bid book runs in a Flare Confidential Compute image registered
> on `FlareTeeManager`, machine `0x0A752D897f7D61Ce0690EEF812027000813467bb`,
> which reads **status 2 (PRODUCTION)** on Coston2. That status is Flare's
> verdict rather than our claim: to reach it, Flare's data providers had to
> reach the machine at its registered URL, request `tee-attestation`, match the
> registered signer set and threshold against an on-chain reward epoch, and vote
> an availability proof. A machine nobody can reach stalls at `1`; a governance
> mismatch reverts with `InvalidGovernanceHash`.
>
> **It does not prove a hardware measurement.** Registration ran with
> `SIMULATED_TEE=true` — a flag that defaults to on at `scripts/post-build.sh:142`
> — so the attestation quote was produced by dstack's simulator, not signed by an
> Intel TDX CPU. The registered code hash is a hash of the image we built,
> attested by software we ran, not a measurement rooted in silicon. Concretely:
> **the confidentiality of a sealed bid rests on the operator not reading the
> enclave's memory.** Read status 2 as *reachable, correctly governed, available,
> running a code hash we declared* — not as *hardware-attested*.
>
> What does not depend on the quote is the **integrity of the opening**.
> `SealedBidBook` independently knows its own escrowed total and bid count and
> rejects any TEE-signed aggregate that fails to reconcile against them, so a
> dishonest enclave cannot move a bettor's stake to the other side no matter who
> signed the quote. The ECIES sealing, the EIP-191 `TEE_ACTION_RESULT` scheme,
> `openMarketFromTee`'s signer recovery and that on-chain reconciliation are real
> and run unchanged on production silicon. What changes on real hardware is who
> signs the quote — nothing else in the path.

**The registered URL is dead.** It decodes to a Cloudflare quick tunnel that now
returns 404, so the sealed path cannot be exercised against the registered
machine until the URL is re-pointed. This is fixable without rebuilding the image
— `MachineManagerFacet.updateTeeMachineSettings` rewrites the URL and never
touches the code hash — but it demotes the machine `PRODUCTION → PAUSED` until a
fresh availability proof is voted through `toProduction`. We are not spending the
`2` on that this close to the deadline.

The extension is registered with Flare's `FlareTeeManager` and reached the
network's own availability check:

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

**Honest caveat, stated up front — read this before you weigh the `2`.**

Registration ran with `SIMULATED_TEE=true`. That flag is in
`~/molfi-fce/.env`, in `molfi-fcc/.env.local`, recorded as `simulatedTee: true`
in `deployments/coston2.json` — and it **defaults to on** at
`scripts/post-build.sh:142` (`export SIMULATED_TEE="${SIMULATED_TEE:-true}"`),
which is exactly the kind of default that ends up shipped without anyone
deciding to ship it.

So be precise about what the `2` is worth. It proves three things, and they are
real:

- **Reachability** — Flare's data providers reached this machine at its
  registered URL and got an answer. A machine nobody can reach stalls at `1`.
- **Governance** — the signer set and threshold the node signs with were
  registered and matched; a mismatch fails with `InvalidGovernanceHash`.
- **Availability** — policy consistency was checked against an on-chain reward
  epoch (5909) and the availability proof was obtained and voted.

It does **not** prove a hardware measurement. The attestation quote was produced
by the simulator, not signed by a CPU. Everything downstream of it — the routing,
the ECIES sealing, the EIP-191 signing scheme, `openMarketFromTee`'s recovery,
the on-chain reconciliation in `SealedBidBook` — is real and reproducible, and
runs unchanged on real hardware. What changes on real hardware is who signs the
quote.

One consequence worth stating rather than implying: with a simulated quote, the
**confidentiality** of a sealed bid rests on the operator not reading the
enclave's memory. The **integrity** does not — `SealedBidBook` independently
knows its own escrow and bid count and rejects any opening that does not
reconcile, so a dishonest enclave cannot move a bettor's stake to the other side
regardless of what the quote says.

**If you open the machine's registered URL in a browser you will get
`404 page not found`. That is not a dead machine.** tee-proxy serves no root
route; the URL is the API endpoint Flare's data providers POST to, not a page.
`GET /info` on the same host returns live `teeInfo`, and the `2` above is the
network's own confirmation that it answered. It is a Cloudflare *quick* tunnel,
so its hostname lives only as long as the `cloudflared` process — see
[REGISTRATION.md](molfi-fcc/REGISTRATION.md) for why re-pointing it needs no
rebuild.

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
call for a market it has never seen has to read the book from Coston2 before it
can answer. When it overruns, the signed result carries `status: 3` and empty
`data`; `tee-node` retries and the second attempt succeeds in ~10ms off the warm
cache, but the proxy publishes only the *first* result for an instruction id, so
the retry is not the one a caller can fetch.

We first blamed the public RPC's rate limiting and recommended a dedicated
endpoint. Measuring killed that theory: `flare.network`, Ankr and Enosys all
answer a Coston2 round trip in 0.4-0.6s, so a different provider buys about
0.1s against a budget that was being missed by more than that. The cost is the
*number of sequential round trips*, not the speed of any one.

So the fix is in the extension, and it is in this repo: `BookReader.bids()`
re-fetched `bidCount` even though `books()` — which `summary()` already reads in
the parallel group — returns it, putting a whole extra round trip in series
ahead of the `getBid` batch. The critical path is now two round trips instead of
three (`molfi-fcc/extension/src/app/`, synced into the scaffold).

It is **not yet deployed**, and that is deliberate. Landing it means rebuilding
the image, which regenerates `tee-node`'s identity key and produces a new
machine — the address published above, the one you can verify yourself, would
have to be re-registered and re-attested by Flare's data providers on their
schedule, not ours. Path 1 is unaffected either way: it talks to the extension
directly, not through the container. To deploy:

```bash
cd molfi-fcc && npm run sync                     # already done — scaffold is in sync
cd ~/molfi-fce && ./scripts/start-services.sh --chain coston2
npx hardhat run scripts/set-tee-machine.ts --network coston2   # register the new machine
npx hardhat run scripts/retire-stale-tee.ts --network coston2  # pause the old one
```

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

## How the hosted stack is wired

| Piece | Where | Notes |
|---|---|---|
| App | Vercel, `molfi.fun` | Vite SPA, `VITE_MOLFI_BACKEND_URL` points at the API |
| API + keeper | Heroku, one `web` dyno | `Procfile` → `node server.js`, Node 22 |
| Database | MongoDB Atlas | `MONGODB_DB=molfi_flare` |
| Chain | Flare Coston2 | contracts below, read via `MOLFI_RPC` |

Two things worth knowing if you redeploy it yourself:

- **The backend reads contract addresses from `molfi-contracts/deployments/`,
  which is outside its own package.** Deploy the backend subtree on its own and
  that file is not there — every read fails with *"missing contract address for
  markets"*. Set `MOLFI_MARKET`, `MOLFI_ESCROW`, `MOLFI_CBET`, `MOLFI_VERIFIER`,
  `MOLFI_ORACLE`, `MOLFI_LP_VAULT`, `MOLFI_FXRP` (plus `MOLFI_SEALED_BOOK` and
  `MOLFI_WEB2_ORACLE`) as env vars; every one of them already has an override in
  `chain.js`.
- **The keeper needs gas, and it fails quietly at the edges.** With an empty
  keeper wallet the API still answers `200` and the site still says "markets
  engine online" — but no new slots open and closed markets never settle, so the
  venue looks abandoned rather than broken. Keep C2FLR in the keeper address.

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
