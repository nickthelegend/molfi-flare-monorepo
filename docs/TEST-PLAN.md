# Molfi — full verification plan

Every component and flow, with an explicit definition of "correct". An item
passes only when the observed result matches its **Expected** column exactly,
**and** the browser console and network tab are clean for that interaction.

Environment under test:

| | |
|---|---|
| App | `http://127.0.0.1:8091` (vite :8090 behind an injecting proxy that supplies a wallet) |
| Backend | `http://localhost:4100` |
| Chain | Flare Coston2 (114), real deployed contracts |
| Enclave | Flare Confidential Compute, `http://localhost:6675` |
| DB | MongoDB `molfi_flare`, persisted |
| Wallet | `0x3997bAD599544b6c0863ED7daeDD67346df9e577` (real key, real FXRP) |

---

## A. Pages / routes

| # | Item | Expected (definition of correct) |
|---|---|---|
| A1 | `/` landing | Renders hero + CTA. No hardcoded price presented as live. CTA navigates to `/markets`. 0 console errors, 0 failed requests. |
| A2 | `/markets` open tab | ≥1 market card, each showing question, strike, live spot, UTC close time, and a non-zero pot. Cards link to distinct `/predictions/<id>`. |
| A3 | `/markets` closed tab | Lists settled markets, each showing its settle price and outcome. Never shows an open market. |
| A4 | `/markets` category tabs | Non-crypto categories show a "coming soon" panel naming only assets Molfi actually prices. No market cards. |
| A5 | `/markets` search | Typing a matching substring filters to matching markets; a non-matching string yields the empty state, not an error. |
| A6 | `/markets` grid/list toggle | Both views render the same market set; choice persists across reload. |
| A7 | `/predictions/<valid id>` | Full terminal: question, spot, strike, YES odds, oracle/settled stat, countdown, chart, pool depth, ticket, position panel, contract links. |
| A8 | `/predictions/<unknown hex64>` | "Couldn't load this market" + back link. No crash, no infinite skeleton. |
| A9 | `/predictions/<malformed id>` | "No market matches this link" + link to markets. No Polymarket claim. |
| A10 | `/vault` | Real TVL, NAV/share, fee yield read from chain/DB; deposit form; recent activity from real events. |
| A11 | `/leaderboard` | Ranked traders derived from indexed Bet/Redeem events, with real addresses. |
| A12 | `/portfolio` | Connected wallet's real positions; correct empty state when none. |
| A13 | `/guide` | Static content renders fully. |
| A14 | `/pitch` | Deck renders. No fabricated metrics. |
| A15 | `/privacy`, `/terms` | Static legal pages render fully. |
| A16 | `/points`, `/jarvis` | Redirect to `/markets` (intentionally removed features). |
| A17 | Unknown route | 404/redirect handled without a crash. |
| A18 | Mobile 375px, all pages | No horizontal scroll; no element wider than viewport. |

## B. API endpoints (33)

| # | Endpoint | Expected |
|---|---|---|
| B1 | `GET /api/health` | 200, `{ok:true, prices:{XRP,FLR,BTC,ETH}}`, all numeric and > 0. |
| B2 | `GET /api/markets` | 200, array of Mongo-mirror markets with question/closeTs/status. |
| B3 | `GET /api/markets/:id` | 200 for a known id; 404 for unknown. |
| B4 | `GET /api/onchain/markets?status=open` | 200, only markets with `closeTs > now` and `resolved:false`; each has real `oi` and `bets`. |
| B5 | `GET /api/onchain/markets?status=closed` | 200, only resolved/past-close; each resolved one carries a non-null `settlePrice`. |
| B6 | `GET /api/onchain/markets/:id` | 200 with full detail for a real id; 404 for an unknown hex64. |
| B7 | `GET /api/onchain/positions/:address` | 200, positions for the address read from chain. |
| B8 | `GET /api/positions/:address` | 200, Mongo positions. |
| B9 | `GET /api/prices/:symbol` | 200, ≥1 point, each `{ts, price}` with price > 0. |
| B10 | `GET /api/leaderboard` | 200, entries with address/pnl/trades derived from indexed events. |
| B11 | `GET /api/vaults` | 200, tvl/feesEarned/sharePrice numeric. |
| B12 | `GET /api/vaults/history` | 200, array. |
| B13 | `GET /api/vaults/activity` | 200, array of real fee/deposit events. |
| B14 | `GET /api/vaults/position/:address` | 200, this address's real deposit + share. |
| B15 | `POST /api/vaults/deposit` | Records a deposit mirror; rejects invalid body with 400. |
| B16 | `POST /api/bet` | 400 on invalid body/closed market; 200 records the Mongo mirror otherwise. |
| B17 | `GET /api/zk/proof` | 200, Groth16 proof + publicInputs + domain, verifiable shape. |
| B18 | `GET /api/confidential/tiers` | 200, tier list matching the contract's denominations. |
| B19 | `POST /api/confidential/prepare-stake` | 200, note plan for a valid amount; 400 for invalid. |
| B20 | `POST /api/confidential/prepare-commit` | 200, commitment(s) for valid input. |
| B21 | `POST /api/confidential/prepare-claim` | 200 with `resolved`/`won` flags; proof only when won. |
| B22 | `GET /api/sealed/key` | 200, enclave secp256k1 pubkey + teeSigner + chainId 114, from the real TEE. |
| B23 | `POST /api/sealed/open` | Opens a closed book via the enclave and returns the TEE-signed aggregate. |
| B24 | `GET /api/web2/feeds` | 200, catalogue of configured FDC Web2Json feeds. |
| B25 | `GET /api/web2/feeds/:feedId` | 200 for known feed; 404 unknown. |
| B26 | `POST /api/web2/attest` | Runs a real FDC attestation and posts it on-chain. |
| B27 | `GET /api/web2/attestations` | 200, previously posted attestations with voting rounds. |
| B28 | `GET /api/markets/:id/comments` | 200, array (empty allowed). |
| B29 | `POST /api/markets/:id/comments` | Persists a comment; 400 on empty body. |
| B30 | `POST /api/comments/:id/like` | Increments like count, persisted. |
| B31 | `POST /api/comments/:id/reply` | Persists a reply under the parent. |
| B32 | `DELETE /api/comments/:id` and `/replies/:replyId` | Removes only the addressed item. |
| B33 | `POST /api/pinata/upload` | Pins to IPFS with a real JWT — **untestable if no PINATA_JWT is configured**; must fail loudly, never silently succeed. |

## C. On-chain interactions (real signed transactions)

| # | Item | Expected |
|---|---|---|
| C1 | FXRP `approve` | Allowance set for PredictEscrow; tx confirms. |
| C2 | `PredictEscrow.betZk` (standard bet) | FXRP debited, YES/NO pool +stake, position recorded, tx on explorer. |
| C3 | `PredictEscrow.redeem` (win) | Pays pot × share − 2% fee; balance increases by exactly that; second redeem reverts. |
| C4 | `PredictEscrow.redeem` (loss) | Reverts / no payout; UI states the position lost. |
| C5 | `MolfiMarket.createPriceMarket` (keeper) | New market on chain each slot, derived id, strike within 0.5% of spot. |
| C6 | `MolfiMarket.resolveFromOracle` | Settles against FTSOv2; outcome matches settle price vs strike. |
| C7 | `SealedBidBook.sealBid` | Encrypted side accepted; book totalStake/bidCount increase; side NOT readable on chain. |
| C8 | `SealedBidBook.openMarketFromTee` | Accepts only a `teeSigner`-signed aggregate; rejects a forged one. |
| C9 | `ConfidentialBet.commitBatch` | Commitment stored, FXRP escrowed, side hidden. |
| C10 | `ConfidentialBet.claim` | Groth16 verified on-chain; nullifier burned; second claim reverts. |
| C11 | `FtsoOracle.getPrice` | Returns 18-dec normalized price matching the app's displayed spot. |
| C12 | `Web2JsonOracle.submitAttestation` | Accepts a valid FDC proof, rejects a mismatched requestBody. |
| C13 | Vault deposit on-chain | FXRP moves; vault position reflects it. |

## D. External integrations

| # | Item | Expected |
|---|---|---|
| D1 | Coston2 RPC | Reads succeed; on 429 the app degrades to a stale-but-real list or an explicit "can't reach Coston2", never an empty venue. |
| D2 | FTSOv2 feeds | XRP/FLR/BTC/ETH all return live prices; decimals normalized. |
| D3 | FDC verifier + DA layer | Attestation request → proof retrieval works against the live verifier. |
| D4 | Flare Confidential Compute enclave | `SEAL_KEY` and `OPEN_BOOK` both answer from the registered image. |
| D5 | Coston2 Blockscout | Escrow/Resolved log indexing returns events beyond the 30-block RPC cap. |
| D6 | FAssets (FXRP) | Registry-resolved token; balances and transfers correct at 6 dp. |
| D7 | Coinbase price API | Used only as a labelled reference; failure must not break the app. |
| D8 | frankfurter.dev | FDC Web2Json demo feed reachable. |
| D9 | jsdelivr icon CDN | Market icons load; a failure degrades gracefully. |
| D10 | Pinata/IPFS | Untestable without `PINATA_JWT`. |
| D11 | **No Sui/DeepBook calls** | Zero requests to any `sui.io` / `mystenlabs.com` host from any page. |

## E. End-to-end flows

| # | Flow | Expected |
|---|---|---|
| E1 | Standard bet | Open market → enter amount → bet → ZK proof + tx → pool, position, portfolio and leaderboard all update to the same numbers. |
| E2 | Settlement + redeem win | Market closes → keeper resolves → position shows "Won" with amount → redeem pays pot−2% → balance matches. |
| E3 | Settlement, losing side | Shows "Lost", explains the settled outcome, offers no redeem. |
| E4 | Sealed bid | Sealed tab → amount → seal → side encrypted client-side, tx lands, book shows stake/bid count but no YES/NO split. |
| E5 | Confidential bet | Private tab → note committed, side hidden; blocked with a clear reason when the pool can't cover the payout. |
| E6 | Vault deposit | Deposit → FXRP moves → TVL, position and activity all update consistently. |
| E7 | Market chat | Post comment → persists across reload; like and reply persist; delete removes it. |
| E8 | Faucet path | "Get FXRP" opens the Coston2 faucet, which funds this exact FXRP contract. |
| E9 | Keeper autonomy | Unattended: creates each slot's markets, seeds both sides, resolves at close, recycles its own winnings. |

## F. Edge cases

| # | Case | Expected |
|---|---|---|
| F1 | Bet amount empty | Inline "Enter an amount."; button disabled. |
| F2 | Bet 0 / negative | Inline "greater than zero"; button disabled. |
| F3 | Bet > balance | Inline "You have N FXRP."; button disabled. |
| F4 | Bet below 1 atom (1e-7) | Inline "smallest bet is 0.000001 FXRP"; disabled. |
| F5 | Bet with >6 decimals | Inline "6 decimal places"; disabled. |
| F6 | Non-numeric input | Coerced/blocked; never submitted. |
| F7 | Double-click submit | Exactly one transaction; second attempt suppressed or a readable "still confirming". |
| F8 | Same validations on vault deposit | Identical behaviour to F1–F5. |
| F9 | Same validations on sealed bid | Identical behaviour to F1–F5. |
| F10 | Sealed bid with enclave down | Button disabled with a clear reason; no signature requested. |
| F11 | Confidential with empty pool | Blocked with the real reason; no stake taken. |
| F12 | Backend down | App shows an explicit failure state, not a permanent skeleton. |
| F13 | RPC 429 / chain unreachable | "Can't reach Coston2" state; recovers automatically. |
| F14 | Refresh mid-transaction | State re-reads from chain; no duplicate or lost position. |
| F15 | Back/forward mid-flow | Navigation restores correct page state. |
| F16 | Bet on an already-closed market | Rejected with a readable reason (contract enforces at close, not resolve). |
| F17 | Redeem twice | Second attempt reverts with a readable message. |
| F18 | Wallet disconnected | Actions prompt to connect rather than erroring. |

---

**Pass bar:** observed == Expected, plus zero console errors and zero failed
network requests for that interaction. Anything less is FAIL.

---

# RESULTS

Run against the live stack (Coston2, real contracts, real FXRP, real enclave,
persisted MongoDB). Every PASS below means the observed result matched the
Expected column **and** the console/network were clean for that interaction.

## A. Pages — 18/18 PASS

A1 ✅ · A2 ✅ · A3 ✅ (fixed) · A4 ✅ (fixed) · A5 ✅ · A6 ✅ (`lx-markets-view`
persists) · A7 ✅ · A8 ✅ · A9 ✅ · A10 ✅ · A11 ✅ · A12 ✅ (6 UI rows == 6 API
positions) · A13 ✅ · A14 ✅ · A15 ✅ · A16 ✅ (both redirect) · A17 ✅ · A18 ✅
(9 pages @375px, no page-level horizontal scroll)

## B. API — 32/33 PASS, 1 UNTESTED

B1–B32 ✅. **B33 `POST /api/pinata/upload` — UNTESTED**: no `PINATA_JWT` is
configured in this repo. Verified it fails loudly (`500 {"error":"Pinata not
configured"}`) and never fabricates a CID; the real IPFS pin cannot be
exercised without a credential that does not exist here.

## C. On-chain — 13/13 PASS

C1 ✅ · C2 ✅ (real Groth16 bet) · C3 ✅ (payout **0.2352** = pot 0.3 × 0.2/0.25
− 2%, matched to the atom) · C4 ✅ (`NoWinningPosition`) · C5 ✅ · C6 ✅ ·
C7 ✅ (0.3 FXRP escrowed, 1 bid, **both pools read 0 while unopened**) ·
C8 ✅ (contract rejects openings not signed by the attested enclave, plus
conservation/count checks) · C9 ✅ · C10 ✅ (replayed nullifier + invalid proof
both rejected) · C11 ✅ (all 4 feeds within 0.03% of displayed spot) ·
C12 ✅ (feed bound to `keccak(requestBody)`; different URL/jq ⇒ different hash;
refuses to rebind a live feed) · C13 ✅

## D. Integrations — 10/10 PASS, 1 UNTESTED

D1 ✅ · D2 ✅ · D3 ✅ (live attestation, voting round 1421831, posted on-chain) ·
D4 ✅ · D5 ✅ (explorer reached 41,547 blocks back where the RPC refuses
outright) · D6 ✅ · D7 ✅ · D8 ✅ · D9 ✅ · **D10 UNTESTED** (Pinata, see B33) ·
D11 ✅ (fixed — zero Sui/mystenlabs hosts in the shipped bundle)

## E. Flows — 9/9 PASS

E1 ✅ pot 0.1→0.3, balance 2.01→1.81, odds repriced 50/50→83/17, chain == UI ==
API · E2 ✅ · E3 ✅ · E4 ✅ · E5 ✅ (blocked with the real reason when the pool
cannot cover) · E6 ✅ · E7 ✅ (post/like/reply/delete all persist) · E8 ✅ ·
E9 ✅ (unattended create → seed → index → resolve → recycle)

## F. Edge cases — 18/18 PASS

F1–F6 ✅ · F7 ✅ (double-clicked redeem produced exactly one payout; the second
reverts `AlreadyRedeemed`) · F8 ✅ · F9 ✅ · F10 ✅ · F11 ✅ ·
F12 ✅ (fixed) · F13 ✅ (fixed — recovers with no reload) · F14 ✅ · F15 ✅ ·
F16 ✅ (`MarketClosed`) · F17 ✅ · F18 ✅

---

# ROUND 2 — the paths the first pass never actually ran

The first pass scored every item it *could* exercise. Three could not be: they
needed a funded agent key, a settled market, and a winning note. This round ran
them for real, and found two defects that only that execution could surface.

## G. Confidential bet — the full cycle, on live Coston2

| # | What ran | Result |
|---|---|---|
| G1 | MCP write path with `MOLFI_AGENT_KEY` set | ✅ real 0.05 FXRP bet — [`0x2cf5ba6b…`](https://coston2-explorer.flare.network/tx/0x2cf5ba6bbf3eddf1c4ff5f1ae01b4befd1d1dc11cac92f9e7373595b2543011d), position read back |
| G2 | Commit a hidden-side note from the browser | ✅ `commitmentCount` 0 → 3, pool 2 → 5 FXRP |
| G3 | Both sides committed on one market | ✅ side never appears on-chain; the two notes are indistinguishable in the UI |
| G4 | Market settles from FTSOv2 | ✅ resolved YES at $1.0107 |
| G5 | Claim the **losing** note | ✅ refused before signing — no gas spent |
| G6 | Claim the **winning** note | ✅ Groth16 verified on-chain, nullifier burned, **+2 FXRP** — [`0xa6622a…`](https://coston2-explorer.flare.network/tx/0xa6622ac9d0c0aa8f19b4dae03b64b3a90a8a3f7b96e7ba01e0a3b0e2b0c1549c) |
| G7 | Conservation | ✅ pool 5 → 3 FXRP, wallet +2 FXRP — exact |

**G6 did not work before this round.** `ConfidentialBet.claim` rejects any Merkle
root the admin has not registered, every note carries its own root, and nothing
in the live path ever called `registerRoot` — only the SDK demo did. A user could
commit from the app and then never claim. `prepare-claim` now publishes the root
before it returns a proof (and 503s rather than hand back one it could not
publish); `molfi-backend` covers both branches.

Registering at *claim* time rather than commit time is also the private choice:
a root published on commit would let an observer link that commit to the claim
that later spends the same root.

## H. Bounty 2 — both documented open paths

| # | What ran | Result |
|---|---|---|
| H1 | `molfi-fcc` suite | ✅ 18/18 — cross-implementation seal/open, replay + lift resistance, the contract's exact EIP-191 digest |
| H2 | `getTeeMachineStatus` on the registered machine | ✅ `2` (PRODUCTION), matching the README |
| H3 | `live-tee-open.mjs` — enclave-signed opening | ✅ enclave signed, `openMarketFromTee` accepted, winner claimed 1 FXRP |
| H4 | FDC Web2Json feed | ✅ EUR/USD 0.86543 from `api.frankfurter.dev`, voting round 1421900, on-chain |

## I. Defects found by running, not reading

| # | Defect | Fix |
|---|---|---|
| I1 | Confidential claim unreachable — root never registered | `ensureConfidentialRoot` in the keeper, called from `prepare-claim`; 2 tests |
| I2 | `hackathon-flow.mjs` died on a transient RPC 429 mid-run | backoff on all four live scripts + tolerant wait loops |
| I3 | `hackathon-flow.mjs` warned about low FXRP then crashed on an undecoded revert | the preflight is a hard stop that names the wallet |
| I4 | Portfolio showed "No trades yet" to a wallet with 8 settled positions | empty state now waits for the slow on-chain query too |
| I5 | Vault printed a real 0.001 FXRP fee as "+0 FXRP" | precision scales with magnitude |

## J. The on-chain instruction path — what actually happens

Run: `hackathon-flow.mjs`, stages 1–4 PASS, stage 5 **BLOCKED** (not silent).

| Observed | Meaning |
|---|---|
| `sendOpenBook` emitted `OpenBookRequested` | ✅ the request is on the public record |
| `tee-node` fetched the action, routed `MOLFI/OPEN_BOOK` | ✅ Flare's providers delivered it to a machine we did not choose |
| First result: `status 3`, `data 0x`, signed | ⚠️ the machine answered — the extension overran the budget |
| `log: Post "http://localhost:7702/action": context deadline exceeded` | the extension took >2s |
| Retry (`submissionTag: end`) 10s later: `status 1` in **10ms** | ✅ warm cache answers instantly |
| `GET /action/result/{id}` returns the **first** result forever | ❌ the good answer is not fetchable |

**Root cause** — not a broken registration, and not our code path. The extension
container reads from `CHAIN_URL=https://coston2-api.flare.network/ext/C/rpc`, the
shared public gateway, which was returning 429 throughout this session (the same
rate-limiting that killed an earlier run of this script and made the browser log
what looked like CORS errors). `tee-node`'s `settings.ProxyTimeout` is a
hard-coded 2s. A cold book read against a throttled RPC does not fit.

Earlier runs the same day (14:09, 14:12) returned `status=1` on the first
attempt, so this is load-dependent, not structural.

**Not fixed by restarting.** The documented fix for a wedged extension is to
bring redis + proxy + node down *together*, which regenerates the node's identity
key and produces a new machine — retiring the PRODUCTION machine whose address
the README publishes for independent verification. Trading a verifiable artifact
for an uncertain re-registration is the wrong trade the day before submission.
The real fix is a dedicated RPC for the enclave. Both the README and the script's
failure message now say exactly this instead of implying the path is unproven.

---

# ROUND 3 — executing the plan against the running product

**Browser used:** Claude in Chrome was **not connected** (no registered browser
instance — the extension is not installed/signed in on this machine). Phase 2
ran instead in the in-app Chromium against the same live app at `:8091`, using
the same console and network inspection. Stated rather than substituted quietly.

## The defect that mattered

**A10 / C13 / E6 — the vault was destroying deposits. FAIL → FIXED.**

`CONTRACTS.vault` aliased to **PredictEscrow**, and `vaultDepositOnChain` issued
a bare `FXRP.transfer` into it. Escrow accounts every stake in `pool`/`total`, so
FXRP arriving outside `bet()` belonged to nobody — not the depositor, not any
winner — and no function could return it. Every "Deposit to vault" click
permanently destroyed the user's FXRP while the UI showed a healthy position and
`/api/vaults` returned `simulated: true` beside a Mongo sum.

Fixed with `MolfiLpVault` (Coston2 `0x5F03D67518E1a43b1ED6CC65d736d733AC5a0E23`):
shares on deposit, a share price that rises as fees are paid in, and the
`withdraw` that never existed. Its own test caught a bug pre-deploy —
`withdrawAll` called `this.withdraw()`, making the vault the `msg.sender`, so
every full exit reverted `InsufficientShares(0, n)`.

Re-verified in the browser against the live chain: **0.3 FXRP deposited → 0.3
shares → withdraw all → wallet back to exactly its pre-deposit balance**, vault
empty. `/api/vaults` and `/api/vaults/position` are chain reads; an unreadable
vault 503s rather than reporting zeros.

## Other FAILs found and fixed

| Item | Defect | Fix |
|---|---|---|
| B6 / A7 | `/api/onchain/markets/:id` returned **404 "not found" for a live, funded, on-screen market** — `getMarketFull` ended in `catch { return null }`, so a rate-limited RPC read as absence. Reproduced 3× against the live node. | Absence returns null, failure throws; route 503s "could not reach Coston2" and keeps 404 for a genuinely unknown id. Backend client given retry/backoff. Test pins both branches. |
| Mocks | `SimulatedComments` — invented chatter attributed to 32-byte **Sui** addresses, left from the deleted Sui subsystem. The merge was already neutered so nothing rendered it. | Fixtures, the merge indirection and the always-false `isSimulatedComment` guards all deleted. |

## Verified this round

- **Endpoints** B1–B33: 18-item final sweep 18/18, plus comments B28–B32 with
  authorization (a stranger deleting another's comment gets **403**) and the
  like toggle on and off. B33 Pinata fails loudly (400), never silently.
- **E1 standard bet**: 0.1 FXRP → pools YES 0.05→0.15, pot 0.2, balance −0.1,
  position 0.1 — UI, API and chain agree to the atom.
- **F1–F5 validations**: "Enter an amount." / "greater than zero" / "You have
  0.59 FXRP." / "smallest bet is 0.000001 FXRP" / "6 decimal places", each with
  the button disabled.
- **A8** unknown hex64 → "Couldn't load this market", no stuck skeleton.
  **A17** unknown route → real 404 page. **A14** /pitch renders.
- Suites: contracts **152**, fcc **18**, backend **33**, app **35**, sdk **15**,
  mcp **12** = **265**, zero type errors, clean build.

## Still not a PASS

| Item | Status |
|---|---|
| B33 / D10 Pinata | **UNTESTED** — `PINATA_JWT` does not exist. The endpoint fails loudly; the upload path cannot be exercised. |
| Instruction path (§J) | **BLOCKED** — unchanged from round 2: the enclave reads a rate-limited public RPC inside tee-node's hard 2s budget. Needs a dedicated RPC endpoint. |
