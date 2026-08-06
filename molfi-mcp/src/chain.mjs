/**
 * Molfi's Flare Coston2 chain layer for the MCP server.
 *
 * Reads go through a public client. Writes are signed by the agent's key
 * (MOLFI_AGENT_KEY) — the server holds it so the agent never has to.
 *
 * GAS: every call that moves FXRP or reads FTSO sends an explicit limit.
 * Coston2's eth_estimateGas under-reports both (an FXRP transfer burns 151,388
 * but estimates at 130,981), and the resulting out-of-gas revert carries EMPTY
 * revert data — which reads as a policy rejection rather than a gas problem.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  formatUnits,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const RPC =
  process.env.MOLFI_RPC || "https://coston2-api.flare.network/ext/C/rpc";

export const coston2 = defineChain({
  id: 114,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: {
    default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" },
  },
  testnet: true,
});

export const CONTRACTS = {
  market: process.env.MOLFI_MARKET || "0xD709773A1128c1160b292F505FAA8E3e8d0786fF",
  escrow: process.env.MOLFI_ESCROW || "0x75dd1eA3e80E3B32f639bDA0894Dd2c15A58a865",
  oracle: process.env.MOLFI_ORACLE || "0xABB3FAFD87F60a8dEA8C2074C1A36984305fB099",
  fxrp: process.env.MOLFI_FXRP || "0x0b6A3645c240605887a5532109323A3E12273dc7",
};

/** FTSOv2 feed ids (bytes21) — ids, not addresses. */
export const FEEDS = {
  XRP: "0x015852502f55534400000000000000000000000000",
  FLR: "0x01464c522f55534400000000000000000000000000",
  BTC: "0x014254432f55534400000000000000000000000000",
  ETH: "0x014554482f55534400000000000000000000000000",
};

/** FXRP has 6 decimals — XRP is denominated in drops. */
export const FXRP_DECIMALS = 6;
export const GAS = { fxrp: 900_000n, tx: 1_500_000n, approve: 200_000n };
export const EXPLORER = "https://coston2-explorer.flare.network";
export const txUrl = (h) => `${EXPLORER}/tx/${h}`;

export const MARKET_ABI = [
  { type: "function", name: "markets", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }] },
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  {
    type: "function", name: "marketOf", stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "question", type: "string" }, { name: "closeTs", type: "uint64" },
      { name: "feedId", type: "bytes21" }, { name: "threshold", type: "uint256" },
      { name: "op", type: "uint8" }, { name: "maxStaleness", type: "uint64" },
      { name: "status", type: "uint8" }, { name: "winningOutcome", type: "uint32" },
      { name: "exists", type: "bool" }, { name: "hasOracle", type: "bool" },
    ],
  },
  {
    type: "function", name: "previewResolution", stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ name: "price", type: "uint256" }, { name: "timestamp", type: "uint64" }, { name: "wouldBeYes", type: "bool" }],
  },
];

export const ESCROW_ABI = [
  { type: "function", name: "bet", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "redeem", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "redeemed", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "pools", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ name: "yesPool", type: "uint256" }, { name: "noPool", type: "uint256" }, { name: "totalPool", type: "uint256" }],
  },
  {
    type: "function", name: "previewPayout", stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "address" }, { type: "uint32" }],
    outputs: [{ name: "net", type: "uint256" }, { name: "fee", type: "uint256" }],
  },
];

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

export const ORACLE_ABI = [
  { type: "function", name: "getPrice", stateMutability: "view", inputs: [{ type: "bytes21" }], outputs: [{ name: "price", type: "uint256" }, { name: "timestamp", type: "uint64" }] },
];

export const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });

/** The agent's signer, or null when the server is running read-only. */
export function agentAccount() {
  const key = process.env.MOLFI_AGENT_KEY;
  if (!key) return null;
  return privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
}

export function walletClient() {
  const account = agentAccount();
  if (!account) {
    throw new Error(
      "No MOLFI_AGENT_KEY set — this server is read-only. Set MOLFI_AGENT_KEY " +
        "to a funded Coston2 key to place bets.",
    );
  }
  return createWalletClient({ account, chain: coston2, transport: http(RPC) });
}

export const fmtFxrp = (v) => formatUnits(v, FXRP_DECIMALS);
export const toFxrp = (v) => parseUnits(String(v), FXRP_DECIMALS);
export const asHex = (h) => (String(h).startsWith("0x") ? h : `0x${h}`);
export const feedSymbol = (feedId) => {
  const lower = String(feedId).toLowerCase();
  return Object.entries(FEEDS).find(([, f]) => f.toLowerCase() === lower)?.[0] ?? null;
};

/** Full market record, shaped for an agent to reason about. */
export async function readMarket(id) {
  const m = await publicClient.readContract({
    address: getAddress(CONTRACTS.market), abi: MARKET_ABI,
    functionName: "marketOf", args: [asHex(id)],
  });
  if (!m || !m[8]) return null;
  const symbol = feedSymbol(m[2]);
  const pools = await publicClient
    .readContract({ address: getAddress(CONTRACTS.escrow), abi: ESCROW_ABI, functionName: "pools", args: [asHex(id)] })
    .catch(() => [0n, 0n, 0n]);
  return {
    marketId: asHex(id),
    question: m[0],
    symbol,
    closeTs: Number(m[1]),
    closesInSeconds: Number(m[1]) - Math.floor(Date.now() / 1000),
    strike: Number(m[3]) / 1e18,
    // op 0 = YES iff price >= strike
    resolvesYesWhen: Number(m[4]) === 0 ? "price >= strike" : "price < strike",
    status: ["trading", "resolving", "resolved"][Number(m[6])] ?? "unknown",
    resolved: Number(m[6]) === 2,
    winningOutcome: Number(m[6]) === 2 ? (Number(m[7]) === 0 ? "YES" : "NO") : null,
    pools: {
      yes: fmtFxrp(pools[0]),
      no: fmtFxrp(pools[1]),
      total: fmtFxrp(pools[2]),
    },
  };
}
