# Molfi on Flare Confidential Compute — live registration

Registered and verified on Coston2. Reproduce with `scripts/register.sh`.

| | |
|---|---|
| `FlareTeeManager` | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| `EXTENSION_ID` | `0x…01023c` (66108) |
| `InstructionSender` | `0xF91a16Ae48609927EA9220508dda9DEA2149B846` |
| TEE machine | `0x0A752D897f7D61Ce0690EEF812027000813467bb` |
| **Status** | **`2` = PRODUCTION** |
| `SealedBidBook` | `0x10B3199147B5B08b15224d1b6149b5e32697396C` |
| Enclave sealing key | `0x02a26c712091177a68e3d1b68cf7ce4a4010b76653382c76a9b11c3d05b9eae77c` |
| Enclave signer (`teeSigner`) | `0x6a066930CD29B1e3f9c697B7dc13cc18a0824069` |

Verified independently of the tooling that wrote it:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" \
  0x0A752D897f7D61Ce0690EEF812027000813467bb \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
# → 2
```

Registration passed the real availability check: Flare's data providers reached
the machine through its registered URL, `tee-attestation` was requested, policy
consistency matched on-chain reward epoch 5909, and the availability proof was
obtained. A machine that is unreachable stalls at `1` (INITIALIZED) — the `2`
is the network's verdict, not ours.

## What actually runs inside the registered image

```
Flare data providers  ──signed instructions──▶  tee-proxy (public)
                                                    │
                                                    ▼
                                          TEE node ── extension (Molfi)
                                                       MOLFI/SEAL_KEY
                                                       MOLFI/OPEN_BOOK
```

The confidential logic is **compiled into the registered container**, not run
beside it. `extension/src/app/` in this repo is the source; the Flare extension
scaffold is upstream code kept in a separate checkout, and `scripts/sync-extension.mjs`
mirrors ours into it before the image is built.

```bash
node scripts/sync-extension.mjs           # monorepo → scaffold, verifies upstream base/
cd ~/molfi-fce && ./scripts/start-services.sh --chain coston2
node scripts/verify-image.mjs             # prove it, from the running container
```

`verify-image.mjs` reads only from the container: its `/state`, its `/action`
responses over the real FCC wire format, the `@noble` versions its own `npm ci`
resolved, and — the decisive one — whether it can decrypt a ciphertext sealed
from outside. The container holds the private half and never emits it, so a
successful open is only possible if the code inside really is the enclave.

```
✓ serving "molfi-sealed-book" (not the scaffold sample)
✓ commands SEAL_KEY · OPEN_BOOK
✓ GREETING/SAY_HELLO → 501, the sample handler is not compiled in
✓ in-image @noble/curves 1.7.0 · @noble/hashes 1.6.1
✓ a bid sealed out here decrypts to the right side in there
✓ replay into another market rejected inside the enclave
✓ lift by another bidder rejected inside the enclave
✓ the book accepts this enclave's signer 0x6a066930CD29B1e3f9c697B7dc13cc18a0824069
```

## The whole flow, live on Coston2, with real FXRP

`node scripts/live-sealed-book.mjs` holds **no enclave key**. It fetches the
sealing key over HTTP and asks the enclave to open the book; the private half
never exists outside it.

```
enclave        : http://localhost:6675
sealing key    : 0x02a26c712091177a68e3d1b6…
the book already trusts this enclave ✅

sealed 1.5 FXRP · 0xbe78a700235598d1ce0815d58fa37a9e8e4e924d2b2233297284b71cdde6ba8f
sealed 2 FXRP   · 0xb3fb674050ad72313d9b83279ce5ef9b7fe17fdc7036eae2ea9a3a8c389880c9

PUBLIC VIEW while live: 3.5 FXRP across 2 bids, opened=false
the YES/NO split is NOT on-chain — the odds do not exist yet

market resolved from FTSOv2 → YES
ENCLAVE OPENED: YES 1.5 FXRP · NO 2 FXRP
pools reconcile with the 3.5 FXRP the contract escrowed ✅
the enclave signed the contract's own digest ✅
book opened  · 0xb5db0d3d63b4a42166f5b618a411ff7b0c79d21243d365ee402e4ddf1b861df8
winner claimed 3.43 FXRP · 0x2ae7daf1a0293c3d2fac04bc8da5954fbdd602aba19dbd7a637f6541d28cb8d1
```

The FXRP is not faucet FXRP. It was minted through FAssets: 10.025 XRP paid on
the XRP Ledger (`F3D6EB06…`), attested by the Flare Data Connector in voting
round 1418448, and `executeMinting` called with that proof
(`0x8e791d1a4317a584a5c268bf36831eab173bbc0f19bd94d8b89c2ecb49d02593`). See
`molfi-contracts/deployments/fassets-mint.json`.

## Three implementations, one key derivation

The sealing format has three independent implementations: the browser
(`molfi-app`, WebCrypto + `@noble` v2), the standalone host enclave
(`molfi-fcc/src`, `node:crypto` + v1.9) and the image (`extension/`, v1.7/1.6).
They differ in runtime, crypto library and major version.

That is not incidental — it is the highest-risk seam in the system. A divergence
in the HKDF `info` or the GCM AAD does not throw; it derives a *different key*,
and every bid sealed in the meantime becomes permanently unopenable, leaving the
bettor's FXRP in the book until the market opens with their side guessed wrong.
`@noble` v2 rejecting a string `info` where v1 UTF-8 encoded it would have done
exactly that. So agreement is tested, not assumed:

| test | pins |
|---|---|
| `molfi-app/src/lib/sealed/seal.spec.ts` | browser ↔ host enclave ↔ compiled image |
| `molfi-fcc/test/cross-impl.test.mjs` | host ↔ image: keys, pools, Merkle root, digest |
| `scripts/verify-image.mjs` | the versions actually resolved in the shipped image |

## The leak that made everything else pointless

`OPEN_BOOK` did not check whether the market had closed.

`SealedBidBook.openMarket` rejects an early opening with `NotClosedYet`, and it
was tempting to treat that as sufficient. It is not: the contract protects
*settlement*, and by the time it says no, the handler's response — containing
every bidder's plaintext side — has already left the enclave. Anyone who could
reach the extension could read a live book and trade against it.

Caught by asking, against the real Coston2 market that had just taken a sealed
bid from the browser, with 36 minutes still on the clock:

```
{"yesPool":"2000000","noPool":"0","bidCount":1,
 "openings":[{"index":0,"side":0,"amount":"2000000","bidder":"0xBDAAda27…"}]}
```

That is the product's central promise, returned over plain HTTP to anyone who
asked. Both implementations now read the market's close time from the book
itself — not from configuration, so the enclave cannot be pointed at a different
market contract — and refuse:

```
error: market is still open — closes in 2013s. The book cannot be opened before close.
```

with `data: "0x"`. `fcc-e2e-local.ts` fails the whole run if it ever answers
again.

## The on-chain instruction path — live

Settlement can be *asked for by a transaction*. Nothing in the chain below
depends on our server being honest, or up: the request is attributable, the
machine is chosen by the registry, and the answer is signed by an identity Flare
attested.

```
sendOpenBook(marketId)                      MolfiInstructionSender 0xF91a16Ae…
  → data providers route it                 extension 66108
  → a machine the REGISTRY picked           0x0A752D89… (PRODUCTION)
  → tee-node signs the ActionResult
  → openMarketFromTee(data, id, tag, status, signature)
```

Proven end to end on Coston2:

```
requested on-chain · instruction 0xea69866c4b3c77492d403827819a002193424c2b554bef467c48fec291da142f
                     tx 0x8a8f7deeb66654e02c75f47072f53616483322fa877bffe4d176ef6d3def90e8
answered · status 1 · tag "threshold"
openMarketFromTee accepted · 0xf4fe8a3fc5907600464334d1d437d66da6f2964ad5cedbf144a9dd8c686212bc
bid 0 claimed 1 FXRP       · 0xd7ddf62e518e9b5efa10e03d7144316d4a1ad4839d60c5a804bd5536746db383
```

### Three failures on the way, each worth knowing

**1. The proxy pins the node's identity at bootstrap — and only at bootstrap.**
Restarting *only* the `extension-tee` container gives the node a fresh key while
the proxy keeps the old one, and it then rejects every result the node produces:

```
result lost … opType=F_GET opCommand=TEE_INFO: 'forbidden': invalid teeID
tee info update unsuccessful in 16623 attempts
```

16,676 rejections in our case, and the *only* outward symptom is a 404 when you
fetch an action result. Nothing says "identity mismatch" where you are looking.
**Always bring redis + proxy + node down together**, not just the extension.

**2. An extension gets exactly 2 seconds.** `settings.ProxyTimeout` in tee-node
is a hard-coded `2 * time.Second`, not configurable. A round trip to Coston2's
public RPC measures 400-600ms; the Multicall3 probe alone is 595ms. The first
instruction paid the probe, the market-address read, the book read and the bid
reads in sequence and went over — producing a signed ActionResult with
`status: 3` and `data: "0x"`, which decodes to nothing and settles no market:

```
"log": "Post \"http://localhost:7702/action\": context deadline exceeded"
```

Fixed by paying the fixed costs at startup (`BookReader.warm()`), caching the
book's immutable `market` address, collapsing `closeInfo` into one parallel
round, and caching computed openings — safe because `sealBid` reverts after
close, so a closed book can never change.

**3. Every rebuild leaves a stale machine ACTIVE.** The node's key is
regenerated on each container start, so each registration adds a machine and the
previous one stays active with nobody listening. `getRandomTeeIds` keeps handing
them out, so a share of instructions vanish into a void — and after a few
rebuilds, most of them. `scripts/retire-stale-tee.ts` pauses all but the live
one.

## Two ways to authorise an opening, and why the second is better

`SealedBidBook` now accepts an opening from either of two identities.

| | trusts | key lives |
|---|---|---|
| `openMarket` | `teeSigner` | handed to the extension via `config/extension.env` |
| `openMarketFromTee` | `teeMachine` | generated inside tee-node; only a public key and a loopback `/sign` are reachable |

The first was the honest soft spot of the whole design: every integrity check on
it is real, but the identity signing is one **we** configured. The second is
Flare's own scheme — when an extension returns an `ActionResult`, tee-node's
router signs it with the node's attested identity key, which the extension
cannot read or substitute.

```
resultHash = keccak256( keccak256(data) ‖ actionId ‖ keccak256(tag) ‖ status )   -- packed
payload    = keccak256( abi.encode(bytes32("TEE_ACTION_RESULT"), chainId, resultHash) )  -- NOT packed
signature  = EIP-191 personal-sign over payload
```

Note the deliberate mix of `encodePacked` and `encode`. Get either wrong and you
produce a perfectly valid signature over the wrong bytes, which surfaces as an
unrecognised signer — pointing you at the key rather than the encoding.

**A stronger signer buys no extra latitude.** Both paths converge on the same
reconciliation: bid count and total escrow are facts the chain already witnessed,
and an opening that disagrees with either does not execute. Authorisation decides
*who may publish*; it never decides what the numbers are.
`SealedBidBook.teePath.test.ts` asserts the conservation and count checks still
fire on the TEE path specifically, because "the machine signed it" is exactly the
argument that would tempt someone to skip them.

### Two things the docs do not tell you, established by experiment

- **The node's address** is `keccak256(x‖y)` of `teeInfo.publicKey` from the
  proxy's `/info`, last 20 bytes. It is NOT `machineData.initialOwner` — that is
  the deployer, and on this stack it really is a different address.
- **`/sign` signs `EIP-191(keccak256(message))`**, not the message and not the
  bare hash. Found by signing three messages and checking which of four
  candidate preimages gave a *stable* recovered address across all of them; the
  other three each produced a different address per message. So passing
  `abi.encode(PREFIX, chainId, resultHash)` as `message` lands on exactly the
  digest the contract recomputes.

### Proven on Coston2

`node scripts/live-tee-open.mjs` — this script holds no signing key at all:

```
book        0x10B3199147B5B08b15224d1b6149b5e32697396C
tee node    0x33ed6fba3FC0b8A9bD656AfAaa8dd1915DEDB201  (derived from /info publicKey)
sealed 1 FXRP across 1 bid(s) — side not on chain
resolved from FTSOv2 → YES
ENCLAVE OPENED: YES 1 FXRP · NO 0 FXRP
signed by the TEE node itself — no key in this process ✅
openMarketFromTee accepted · 0x8b70ec744717f7ddbe0783afead2930d5ac7f6d6753654101e7c3d2333562c06
winner claimed 1 FXRP · 0x01e79bd33a663af2dbda677670b4400627ac8d656135caefa03e58ab9fb44686
```

Note the node address is **not** the registered machine `0x0A752D89…`: the node
key is regenerated on every container start with no persistence, so a restart
invalidates it. `setTeeMachine` exists for that, and the script rotates before
opening rather than failing mysteriously.

**What is still not wired.** Reaching this path through Flare's *on-chain*
instruction pipeline — `InstructionSender` → registry → data providers → proxy →
tee-node — needs MOLFI send functions on the InstructionSender and a
re-registration of the extension. That is not done. The signature above is
obtained from the same tee-node that pipeline would use, through its own signing
API, so the scheme and the identity are real; the on-chain *routing* to it is not
yet.

## The signer-drift trap

The enclave's signing key is generated inside the extension. Rebuild the image,
or restart without a pinned key, and the address changes while `SealedBidBook`
still trusts the old one. Nothing looks wrong: sealing works, bids land. It
surfaces at close, when `openMarket` reverts with `BadSignature` and every stake
in the book is frozen behind an opening that cannot be accepted.

This was real — the book trusted `0x2Ab15c68…` while the enclave signed as
`0x6a066930…`. Two things now prevent it recurring silently:

- **The enclave refuses.** `OPEN_BOOK` reads `teeSigner()` and returns
  `tee signer mismatch: …` rather than producing a signature the contract will
  reject. One eth_call turns a frozen market into one line of output.
- **A script fixes it.** `molfi-contracts/scripts/set-tee-signer.ts` reads the
  live enclave's identity and rotates the contract to match, refusing to point
  at a key nothing is running.

## Honest scope

- `SIMULATED_TEE=true`. Accepted for judging; confidentiality is a development
  posture, not a hardware guarantee. Every INTEGRITY property is real either
  way — conservation, bid count, signature, market/bidder binding, and the
  Merkle openings are all enforced on-chain.
- **Keys are injected, not generated in-enclave.** Under `SIMULATED_TEE` the
  sealing and signing keys come from `config/extension.env` so they survive a
  restart. The handler generates them in-enclave when absent — the correct
  production posture — but then a container restart strands every bid already
  sealed to the old key. A real deployment needs sealed storage or
  attestation-derived key material; that gap is not closed here.
- **The app reads `SEAL_KEY` from the sibling host process on `:6675`, not from
  the container.** The scaffold's compose does not publish the extension port,
  and it should not — tee-node is supposed to front it. That process runs the
  same logic and, verifiably, the *same keys* (compare `/state` on both). It is
  a convenience endpoint, not a second enclave.
- The URL above is a **quick** cloudflared tunnel, whose hostname changes on
  restart. Data providers push to the URL stored on-chain, so after a restart
  the machine goes stale: re-run `post-build.sh` with the new `EXT_PROXY_URL`,
  or use a named tunnel / reserved domain for anything long-lived.

## Gotchas that cost real time

- **The compose default is Go.** `docker compose build` alone rebuilds
  `go/Dockerfile` regardless of `LANGUAGE=typescript`, because
  `EXTENSION_DOCKERFILE` is resolved by `scripts/start-services.sh`, not by
  `.env`. Building by hand produces a working image of the *wrong* extension.
  Always go through `./scripts/start-services.sh --chain coston2`.
- `npm ci` — which is what the Dockerfile runs — refuses to build when
  `package.json` declares a dependency the lockfile's root entry does not. Adding
  `@noble/*` as direct dependencies requires regenerating the lock, which
  `sync-extension.mjs` does.
- `docker-compose.coston2.yaml` is an OVERRIDE. It must be layered on the base
  file (`-f docker-compose.yaml -f docker-compose.coston2.yaml`); alone it
  fails with "service ext-proxy has neither an image nor a build context".
- The proxy PANICS rather than retrying if redis is not resolvable at startup.
  Bring redis up first.
- Docker Desktop on macOS cannot bind-mount files from arbitrary paths — from
  an unshared directory it silently creates a directory where the config file
  should be, and the container dies with "not a directory". Keep the scaffold
  under `$HOME`.
- `config/proxy/extension_proxy.coston2.docker.toml` does not exist until you
  copy the `.example` and fill in the indexer DB block. Host `34.38.42.208`,
  port 3306, database `indexer`; credentials come from the Flare team.

## Sibling tenants — dorr and hadal inside this machine

`0x0A752D89…` is the expensive part. Flare's data providers reached it,
requested `tee-attestation`, matched policy against reward epoch 5909 and voted
it available. That artifact is per-machine, so a sibling product standing up its
own box gets a server with no such artifact — running *inside* this machine is
strictly better. Hence tenants, not deployments.

Nothing about registration binds an opType. `post-build.sh` submits a TEE
version string, the governance signer set and the machine's proxy URL; dispatch
is `framework.lookup(opType, opCommand)` with a 501 fallback
(`base/server.ts:133`). `DORR` and `HADAL` are simply more `framework.handle`
calls.

Sharing one key across products would be worse than not sharing: a quote issued
for dorr would verify against hadal's contract, and a ciphertext sealed "to the
enclave" would open for whichever tenant asked first. So each derives its own,
matching `flare-tee-kit` byte for byte:

    signingKey(p) = HKDF-SHA256(seed, salt = "flare-tee-kit/v1/sign",  info = p)
    sealingKey(p) = HKDF-SHA256(seed, salt = "flare-tee-kit/v1/ecies", info = p)

Vendored (`extension/src/app/tenants.ts`), not depended on — ~100 lines using
imports the image already had. Inside a registered enclave a smaller audited
surface beats dependency hygiene: adding a package means auditing its tree
inside the trust boundary.

**Molfi is not a tenant.** Its sealing key stays pinned by `ENCLAVE_PRIVATE_KEY`
and its signer by `TEE_SIGNER_KEY`. Deriving them would move the sealing key
away from the one live bids were sealed to, and the signer away from what
`SealedBidBook.teeSigner` points at. `MOLFI/SEAL_KEY`, `MOLFI/OPEN_BOOK` and
`MOLFI/OPENINGS` are untouched — nothing in the tenant path is reachable from a
MOLFI action.

Separation is of **identity, not blast radius**: code in this process can derive
any tenant's key, so a compromise of the enclave compromises all of them. Two
products that must be safe from each other's *bugs* need two enclaves.

`verify-image.mjs` proves it from inside the container — distinct signers and
sealing keys, molfi's signer shared with none of them, and every cross-tenant
open rejected. On a molfi-only image it says so rather than passing vacuously.

**Not deployed.** Landing it rebuilds the image, and the node's identity key is
regenerated on every container start (see gotcha 3), so it means a new machine,
`register-tee`, and another availability check on Flare's schedule. Molfi's
`2` is not lost while that happens — the old machine stays ACTIVE, and molfi's
off-chain path talks to the extension directly rather than through the
container — but instructions split between old and new until
`retire-stale-tee.ts` pauses the old one.

    cd molfi-fcc && npm run sync         # already in sync
    cd ~/molfi-fce && ./scripts/start-services.sh --chain coston2
    cd molfi-fcc && npm run verify       # tenant checks stop being vacuous here
