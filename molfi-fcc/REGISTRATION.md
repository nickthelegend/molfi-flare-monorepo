# Molfi on Flare Confidential Compute — live registration

Registered and verified on Coston2. Reproduce with `scripts/register.sh`.

| | |
|---|---|
| `FlareTeeManager` | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| `EXTENSION_ID` | `0x…0101cc` (65996) |
| `InstructionSender` | `0x64799fc225db28d52cAe8593214E8AB372C658A3` |
| TEE machine | `0xD114B9B601B77D5Fa1EBdc82bdcafCdB7129f205` |
| **Status** | **`2` = PRODUCTION** |
| `SealedBidBook` | `0x22B0F197b12e86653d449326b7677e65e2162c90` |
| Enclave sealing key | `0x02a26c712091177a68e3d1b68cf7ce4a4010b76653382c76a9b11c3d05b9eae77c` |
| Enclave signer (`teeSigner`) | `0x6a066930CD29B1e3f9c697B7dc13cc18a0824069` |

Verified independently of the tooling that wrote it:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" \
  0xD114B9B601B77D5Fa1EBdc82bdcafCdB7129f205 \
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
