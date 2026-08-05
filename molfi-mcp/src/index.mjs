#!/usr/bin/env node
/**
 * Molfi MCP server — XRP prediction markets on Flare as agent tools.
 *
 * Any MCP-capable agent (Claude, or any LLM client) can browse markets priced
 * by FTSOv2, stake FXRP, settle, and redeem — without a human touching a wallet.
 *
 * Run:
 *   MOLFI_AGENT_KEY=0x… node src/index.mjs
 *
 * Without a key the server still starts and serves every read tool, so an agent
 * can research markets before anyone decides to fund it.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.mjs";
import { agentAccount } from "./chain.mjs";

const TOOL_SPECS = [
  {
    name: "molfi_get_price",
    description:
      "Read a live price from Flare's FTSOv2 oracle — the exact feed Molfi " +
      "markets settle against. Supported: XRP, FLR, BTC, ETH.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "XRP | FLR | BTC | ETH" } },
      required: ["symbol"],
    },
  },
  {
    name: "molfi_list_markets",
    description:
      "List prediction markets. Each is a binary question on where a price " +
      "lands at close, collateralized in FXRP (FAssets-wrapped XRP) and " +
      "settled by FTSOv2. Returns strikes, pools and time to close.",
    inputSchema: {
      type: "object",
      properties: {
        openOnly: { type: "boolean", description: "Only markets still accepting bets (default true)" },
        limit: { type: "number", description: "Max markets to return (default 25)" },
      },
    },
  },
  {
    name: "molfi_get_market",
    description:
      "Full detail for one market, including what it WOULD settle to right now " +
      "given the live FTSO price (preview). Use before betting.",
    inputSchema: {
      type: "object",
      properties: { marketId: { type: "string", description: "bytes32 market id" } },
      required: ["marketId"],
    },
  },
  {
    name: "molfi_get_wallet",
    description:
      "The agent's own wallet: address, C2FLR gas, and FXRP bankroll. FXRP " +
      "cannot be minted — it is a real claim on XRP, funded from the faucet.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "molfi_get_position",
    description:
      "Escrowed position on a market (YES/NO in FXRP), whether it has been " +
      "redeemed, and the payout if the held side wins.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string" },
        address: { type: "string", description: "Defaults to the agent's own address" },
      },
      required: ["marketId"],
    },
  },
  {
    name: "molfi_place_bet",
    description:
      "Stake FXRP on YES or NO. Approves exactly this bet's amount, then " +
      "escrows on-chain. Pari-mutuel: winners split the whole pot minus a 2% fee.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string" },
        outcome: { type: "string", description: "YES or NO" },
        amount: { type: ["string", "number"], description: "FXRP, e.g. 0.5" },
      },
      required: ["marketId", "outcome", "amount"],
    },
  },
  {
    name: "molfi_resolve_market",
    description:
      "Settle a closed market from FTSOv2. Permissionless — any caller may " +
      "settle any market past its close, including ones they have no stake in.",
    inputSchema: {
      type: "object",
      properties: { marketId: { type: "string" } },
      required: ["marketId"],
    },
  },
  {
    name: "molfi_redeem",
    description: "Claim winnings in FXRP after a market resolves.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string" },
        address: { type: "string", description: "Defaults to the agent's own address" },
      },
      required: ["marketId"],
    },
  },
];

const server = new Server(
  { name: "molfi", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SPECS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const fn = TOOLS[name];
  if (!fn) {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${name}` }],
    };
  }
  try {
    const result = await fn(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    // Surface the reason rather than a stack — the agent has to act on this.
    return {
      isError: true,
      content: [{ type: "text", text: String(e?.shortMessage ?? e?.message ?? e) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

const acct = agentAccount();
console.error(
  `[molfi-mcp] ready on Coston2 — ${acct ? `signing as ${acct.address}` : "read-only (no MOLFI_AGENT_KEY)"}`,
);
