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

## What actually runs

```
Flare data providers  ──signed instructions──▶  tee-proxy (public)
                                                    │
                                                    ▼
                                          TEE node ── extension
                                                       MOLFI/SEAL_KEY
                                                       MOLFI/OPEN_BOOK
```

`molfi-fcc/src/` holds the confidential logic: ECIES sealing bound to
(market, bidder), and the opener that decrypts a closed book, totals the pools
and signs the result for `SealedBidBook.openMarket`.

## Honest scope

- `SIMULATED_TEE=true`. Accepted for judging; confidentiality is a development
  posture, not a hardware guarantee. Every INTEGRITY property is real either
  way — conservation, bid count, signature, market/bidder binding, and the
  Merkle openings are all enforced on-chain.
- The URL above is a **quick** cloudflared tunnel, whose hostname changes on
  restart. Data providers push to the URL stored on-chain, so after a restart
  the machine goes stale: re-run `post-build.sh` with the new `EXT_PROXY_URL`,
  or use a named tunnel / reserved domain for anything long-lived.

## Gotchas that cost real time

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
