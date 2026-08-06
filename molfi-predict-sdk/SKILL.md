---
name: molfi-confidential-bet
description: Bet on Molfi prediction markets on Flare — your side stays hidden behind a ZK commitment, stakes are collateralized in FXRP (FAssets-wrapped XRP), markets resolve from FTSOv2. An AI agent can run the whole lifecycle autonomously.
---

# Molfi — confidential, agent-native prediction markets on Flare

You (an AI agent) can bet on real-world outcomes where **your side (YES/NO) never
touches the chain**. Positions are collateralized in **FXRP** — the FAssets
representation of real XRP on Flare — and markets resolve from a **FTSOv2**
price feed. Everything is on **Flare Coston2**.

## What stays private
- **Side** — hidden behind a Poseidon commitment; you claim your win with a
  zero-knowledge Groth16 proof (BN254), unlinkable to your bet. The contract
  injects the resolved winner as a public input, so a losing note cannot prove.
- **Size** — every confidential note is a FIXED denomination, so stake size
  leaks nothing on-chain.

**Honest scope:** the amount is uniform rather than encrypted, and the anonymity
set is the set of commitments sharing a registered Merkle root (built off-chain
and checkpointed by an operator, since the EVM has no native Poseidon).
Side-hiding, outcome-binding and the single-use nullifier are all enforced
on-chain.

## The lifecycle (one flow, no human)

1. **Wallet** — create a fresh EVM key; get funded with a little C2FLR (gas) and
   `FXRP` (bankroll) from https://faucet.flare.network/coston2 — FXRP is real bridged XRP and cannot be minted.
2. **Prove your side** — pick YES(0) or NO(1). Generate a Groth16 proof
   (`confidential_bet` circuit, BN254) that a note with your side exists; the
   side is a *private* input, never revealed. Public signals:
   `[root, nullifierHash, outcome, recipient]`.
3. **Commit** — `approve(FXRP)` then `ConfidentialBet.commit(commitment)` to
   escrow the fixed denom. The side is not on-chain.
4. **Resolve** — after close, anyone calls `MolfiMarket.resolveFromOracle(id)`;
   it reads the FTSOv2 feed by its `bytes21` id (`getFeedByIdInWei`, normalized
   to 18 decimals and freshness-checked) and sets the winner. There is no
   `latestRoundData` here — that is Chainlink's per-pair aggregator interface;
   Flare's FTSO is one contract serving every feed, keyed by id.
5. **Claim** — `ConfidentialBet.claim(id, a, b, c, root, nullifierHash, you)`.
   The contract injects the resolved winner as a public input, so a losing note
   can't prove. The nullifier is burned; you're paid, unlinkable to your bet.

## Run it

```bash
OPERATOR_KEY=0x<funded Coston2 key> npm run agent:demo
```

`demo/agent-confidential-bet.mjs` is a complete, self-contained agent that does
all five steps live on Coston2 and prints the Coston2 explorer transactions. It uses only
`viem` + `snarkjs` and the built circuit artifacts in
`molfi-circuits/build/confidential_bet/`. Addresses come from
`molfi-contracts/deployments/coston2.json`, so a redeploy can't strand it.

`OPERATOR_KEY` must be the `ConfidentialBet` admin (it checkpoints the Poseidon
root for the market) and hold at least 3 FXRP — 1 to bankroll the agent and 2 to
cover the 2× payout, since the pool holds only the single committed note. The
demo checks this up front and exits with the faucet URL rather than reverting.

## Contracts (Coston2 · chainId 114)
- `MolfiMarket` `0xD709773A1128c1160b292F505FAA8E3e8d0786fF` — FTSOv2-resolved markets (enumerable)
- `PredictEscrow` `0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067` — real-FXRP pari-mutuel + ZK-gated bets
- `ConfidentialBet` `0x19679CceD8EF85096e779A5D7685505bE4D9bDB7` — hidden-side bets + ZK claim
- Groth16 verifier `0x5bc5f11a8e4cC8BFaeD44688DFBBbCDB00B099B5`
- `FXRP` `0x0b6A3645c240605887a5532109323A3E12273dc7`
- `FtsoOracle` `0xABB3FAFD87F60a8dEA8C2074C1A36984305fB099` — reads FTSOv2, normalized to 18 decimals
- FTSOv2 feed ids (bytes21, not addresses): XRP/USD `0x015852502f55534400000000000000000000000000` · FLR/USD `0x01464c522f55534400000000000000000000000000`
