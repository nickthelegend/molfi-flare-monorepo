# @molfi/mcp

**XRP prediction markets on Flare, as agent tools.**

An MCP server that lets any MCP-capable agent — Claude, or any LLM client —
browse Molfi markets, read the FTSOv2 price they settle against, stake **FXRP**
(FAssets-wrapped XRP), settle a closed market, and redeem. No human touches a
wallet.

## Why an agent wants this

Molfi's markets are short-dated (15m/30m/60m) and settle deterministically
against a public oracle. That is a good fit for an agent: the question is
well-formed, the resolution rule is mechanical, and the payoff is computable
before you commit. `molfi_get_market` returns the strike, the live price, and
**what the market would resolve to right now** — so the model can decide with the
same information settlement will use.

## Tools

| Tool | What it does |
|---|---|
| `molfi_get_price` | Live FTSOv2 price (XRP, FLR, BTC, ETH) — the exact feed markets settle on |
| `molfi_list_markets` | Open markets with strike, pools, and time to close |
| `molfi_get_market` | One market in detail, incl. `preview` of how it would resolve now |
| `molfi_get_wallet` | Agent's address, C2FLR gas, FXRP bankroll |
| `molfi_get_position` | Escrowed YES/NO position and payout if that side wins |
| `molfi_place_bet` | Stake FXRP on an outcome (approve + escrow) |
| `molfi_resolve_market` | Settle a closed market from FTSOv2 — permissionless |
| `molfi_redeem` | Claim winnings after resolution |

## Run

```bash
npm install
MOLFI_AGENT_KEY=0x<funded Coston2 key> npm start
```

Without `MOLFI_AGENT_KEY` the server still starts and serves every **read** tool,
so an agent can research markets before anyone funds it. Write tools return a
clear error rather than failing obscurely.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "molfi": {
      "command": "node",
      "args": ["/absolute/path/to/molfi-mcp/src/index.mjs"],
      "env": { "MOLFI_AGENT_KEY": "0x..." }
    }
  }
}
```

## Verify it

```bash
npm test                                        # 11/11, offline
MOLFI_AGENT_KEY=0x… npm run selftest            # live, against Coston2
```

The self-test drives the real tool surface end to end:

```
✅ molfi_get_price XRP    XRP/USD $1.061116 · 2s old · FTSOv2
✅ molfi_list_markets     8 open · XRP strike $1.06 closes in 707s
✅ molfi_get_wallet       0x2904…8Feb · 64.79 C2FLR · 0.0002 FXRP
✅ molfi_get_market       would resolve YES at $1.061245
✅ molfi_place_bet        approve + bet, both confirmed on-chain
✅ molfi_get_position     YES 0.0001 · NO 0 FXRP
```

## Two things this server handles for the agent

**FXRP cannot be minted.** It is a real over-collateralized claim on XRP held by
FAssets agents, not a faucet token with an open `mint()`. `molfi_place_bet`
checks the balance first and fails with the faucet URL rather than reverting
mid-transaction.

**Coston2 under-estimates gas.** An FXRP transfer burns **151,388** gas, but
`eth_estimateGas` intermittently returns **130,981** — and the resulting
out-of-gas revert carries *empty* revert data, which reads as a policy rejection
rather than a gas problem. Every write here sends an explicit limit, and
`molfi_resolve_market` simulates first so a genuine stale-feed rejection is
distinguishable from running out of gas.

## Units

Everything in and out is **human**: FXRP amounts like `0.5`, prices like
`1.0611`. The agent never sees base units, and never needs to know that FXRP
carries 6 decimals (XRP drops) while FTSO returns 18.
