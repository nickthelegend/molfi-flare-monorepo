# molfi-fcc/extension — the code inside the registered TEE image

This is Molfi's Flare Confidential Compute extension: the handler that Flare's
data providers reach when they route a `MOLFI` instruction to TEE machine
`0xD114B9B601B77D5Fa1EBdc82bdcafCdB7129f205`.

```
src/app/      ours     — the confidential logic
src/base/     theirs   — upstream infrastructure, mirrored for typechecking only
src/main.ts   theirs   — upstream entry point
```

## Why the split

The Flare extension scaffold is upstream code with its own release cadence, and
`base/` is marked *do not modify* — it implements a wire contract that tee-node
enforces. Vendoring the whole scaffold here would quietly fork that contract, so
instead only `app/` lives in this repo and gets synced into a scaffold checkout
before the image is built:

```bash
node ../scripts/sync-extension.mjs          # monorepo → scaffold
node ../scripts/sync-extension.mjs --check  # CI: fail if they diverge
node ../scripts/sync-extension.mjs --adopt  # take upstream's base/ after a bump
```

Every run verifies the mirrored files byte-for-byte and refuses to proceed if
upstream moved, because a silently stale `base/` means this repo and the image
no longer speak the same protocol.

## The two operations

| | payload | returns |
|---|---|---|
| `MOLFI/SEAL_KEY` | none | the ECIES public key clients seal bids to |
| `MOLFI/OPEN_BOOK` | `abi.encode(bytes32)` or `{"marketId":"0x…"}` | pools, Merkle root, openings, signature |

`OPEN_BOOK` takes only a market id. Everything else — the bidders, the amounts,
the ciphertexts — is read from `SealedBidBook` over RPC, because the bidder
address is authenticated data inside every ciphertext and accepting a
caller-supplied one would let someone re-point a sealed bid at another account.

## What the signature is not

`OPEN_BOOK` returns an EIP-191 signature over the aggregate. It is **not** a
request to believe the enclave. `SealedBidBook` independently knows how many bids
it holds and exactly how much FXRP it escrowed, and rejects any opening whose
pools do not sum to that escrow or whose count disagrees. A compromised enclave
cannot move a bettor's stake to the other side without the totals failing to
reconcile.

The confidentiality is a TEE assumption. The integrity is not.

## Files

| | |
|---|---|
| `app/seal.ts` | ECIES: ephemeral secp256k1 → ECDH → HKDF-SHA256 → AES-256-GCM, with (market, bidder) as AAD |
| `app/open-book.ts` | decrypt the whole book, total the pools, build the sorted-pair Merkle tree, recompute the contract's digest |
| `app/chain.ts` | read the book from chain; probes for Multicall3 once and batches only if the chain has it |
| `app/abi.ts` | decode the market id from either the on-chain or the off-chain payload shape |
| `app/handlers.ts` | dispatch, the conservation and signer-drift checks, and the signature |

## Proving it works

```bash
cd ..                                  # molfi-fcc
npm test                               # host ↔ image agreement, 18 tests
npm run verify                         # against the RUNNING registered container

cd ../molfi-contracts
npx hardhat node &                     # a real chain
npx hardhat run scripts/fcc-e2e-local.ts --network localhost
```

The last one is the end-to-end: it seals bids with this image's own sealer,
calls the compiled `handleOpenBook` against a live JSON-RPC chain, hands the
result to `openMarket`, and makes the winners claim with the Merkle proofs the
handler produced. Nothing in it is stubbed.
