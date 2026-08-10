/**
 * Keeps real, tradeable markets on chain.
 *
 * `ensureMarkets` in server.js creates the Mongo mirror. Nothing created the
 * ON-CHAIN ones, so `MolfiMarket` only ever gained a market when a human ran a
 * script — and once those closed, the app's main page showed an empty list with
 * nothing to bet on. Fifty-eight markets had been created and settled; not one
 * was open.
 *
 * This is the writer. It rolls markets forward on a fixed cadence and settles
 * them from FTSOv2 once they close, so the venue keeps working with nobody
 * watching it.
 *
 * COST IS THE REASON THIS IS NARROW. `createPriceMarket` runs ~200k gas, which
 * at Coston2's 650 gwei is ~0.13 C2FLR per market. Rolling four assets on two
 * cadences would burn ~25 C2FLR a day. It defaults to one asset on one cadence
 * and is widened by env, deliberately — an unattended keeper that drains the
 * deployer is worse than a quiet one.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  formatUnits,
  parseUnits,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.MOLFI_RPC || "https://coston2-api.flare.network/ext/C/rpc";
const CHAIN_ID = Number(process.env.MOLFI_CHAIN_ID || 114);
const KEEPER_KEY = process.env.MOLFI_KEEPER_KEY || "";

/**
 * Which assets get on-chain markets, and on what minute cadence.
 *
 * `MOLFI_ONCHAIN_SYMBOLS` accepts a bare symbol or `SYMBOL:MINUTES`, so cadence
 * can differ per asset — "XRP:30,BTC:60,ETH:60,FLR:60" keeps the headline feed
 * settling twice an hour (a judge can watch one close) while the rest cost half
 * as much gas. A bare symbol falls back to `MOLFI_ONCHAIN_CADENCES`.
 *
 * Cadence is the dominant cost lever: every slot is one `createPriceMarket`
 * (~192k gas) plus one `resolveFromOracle` (~115k), so halving a feed's cadence
 * halves its burn exactly.
 */
export const CADENCES = (process.env.MOLFI_ONCHAIN_CADENCES || "30")
  .split(",").map((s) => Number(s.trim())).filter((n) => n > 0);

/** [{ symbol, cadences }] — the full schedule the keeper rolls. */
export const SCHEDULE = (process.env.MOLFI_ONCHAIN_SYMBOLS || "XRP")
  .split(",")
  .map((entry) => {
    const [sym, mins] = entry.trim().split(":");
    const symbol = (sym || "").trim().toUpperCase();
    if (!symbol) return null;
    const per = Number(mins);
    return { symbol, cadences: per > 0 ? [per] : CADENCES };
  })
  .filter(Boolean);

/** Back-compat: the plain symbol list, still used by callers and tests. */
export const SYMBOLS = SCHEDULE.map((e) => e.symbol);
/** Don't create a market so close to its own expiry that nobody can bet. */
const MIN_LEAD_SECONDS = Number(process.env.MOLFI_MIN_LEAD_SECONDS || 240);
/** Settlement needs the feed no older than this. */
const MAX_STALENESS = BigInt(process.env.MOLFI_MAX_STALENESS || 86_400);

/**
 * Opening liquidity the keeper stakes on BOTH sides of every market it creates.
 *
 * A market with an empty pot has no odds — the UI can only show 50/50 and the
 * first bettor prices against nothing. Seeding both sides is what a market
 * maker does, and here it costs almost nothing: the keeper wins one leg and
 * loses the other, so the only real outflow is the 2% fee on its own turnover
 * (~0.004 FXRP per market at the default size), and `redeemOwn` recycles the
 * winning side back.
 *
 * Set to 0 to disable. Whatever is staked here is real FXRP at real risk and
 * settles exactly like any other position — it is NOT display liquidity.
 */
const SEED_FXRP = process.env.MOLFI_SEED_LIQUIDITY ?? "0.05";

const ESCROW = process.env.MOLFI_ESCROW || "0xbe2EEc9aEb6fb923c0dDA1B11bD0BC22fA103067";
const FXRP_TOKEN = process.env.MOLFI_FXRP || "0x0b6A3645c240605887a5532109323A3E12273dc7";
const CBET = process.env.MOLFI_CBET || "0x1e5e41cbC1e6FB96635DBc3191A03d8CC970ba99";

const ESCROW_ABI = [
  { type: "function", name: "bet", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "redeem", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
];
const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const chain = defineChain({
  id: CHAIN_ID,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});
const pub = createPublicClient({
  chain, transport: http(RPC), batch: { multicall: { batchSize: 4096, wait: 16 } },
});
export const keeper = KEEPER_KEY ? privateKeyToAccount(KEEPER_KEY) : null;
const wallet = keeper ? createWalletClient({ account: keeper, chain, transport: http(RPC) }) : null;

const MARKET_ABI = [
  {
    type: "function", name: "createPriceMarket", stateMutability: "nonpayable",
    inputs: [
      { type: "bytes32" }, { type: "string" }, { type: "uint64" }, { type: "bytes21" },
      { type: "uint256" }, { type: "uint8" }, { type: "uint64" },
    ],
    outputs: [],
  },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
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
];

const fmtTime = (ms) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/**
 * The market id for a (symbol, cadence, slot).
 *
 * Derived, not random: two keeper instances — or one restarted mid-cycle —
 * compute the same id and the second `createPriceMarket` reverts with `Exists`
 * instead of creating a duplicate market for the same slot.
 */
export function slotMarketId(symbol, cadenceMins, closeTsSec) {
  return keccak256(toHex(`molfi:${symbol}:${cadenceMins}m:${closeTsSec}`));
}

/**
 * The rounding step for a price, at roughly 0.1–1% of its magnitude.
 *
 * Per-symbol constants got this wrong the moment an asset was cheap: FLR at
 * $0.00607 rounded on a $0.001 step landed on $0.006, a strike 1.2% BELOW spot,
 * so the market opened already decided. Deriving the step from the price keeps
 * every feed on the same relative granularity — $0.00001 for FLR, $0.01 for
 * XRP, $10 for ETH, $100 for BTC — and needs no edit when a feed is added.
 */
function strikeStep(price) {
  return Math.pow(10, Math.floor(Math.log10(price)) - 2);
}

/** Decimal places needed to write a price on `step` exactly. */
function stepDecimals(step) {
  return Math.max(0, -Math.floor(Math.log10(step)));
}

/**
 * Round the strike so the question reads like a price, not a float.
 *
 * Returns a STRING: `Math.round(x / 1e-5) * 1e-5` reintroduces binary float
 * noise ("0.006070000000000001"), and that string goes straight into
 * `parseUnits`, which rejects excess precision.
 */
function roundStrike(price) {
  const step = strikeStep(price);
  return (Math.round(price / step) * step).toFixed(stepDecimals(step));
}

const fmtStrike = (strike) => {
  const n = Number(strike);
  // Group thousands, but never drop the decimals a cheap asset needs.
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: (strike.split(".")[1] ?? "").length,
    maximumFractionDigits: (strike.split(".")[1] ?? "").length,
  })}`;
};

/**
 * Priority fee, in wei. One gwei by default.
 *
 * The RPC suggests 150 gwei and viem takes it, which on a 500 gwei base fee
 * means paying 650 to win a race against nobody — Coston2 blocks are empty.
 * At ~192k gas per market that was 0.1246 C2FLR a market; a 1 gwei tip makes
 * it 0.0960, which is 23% off the keeper's entire burn rate and buys about a
 * day of extra runway per three it had.
 *
 * Raise it if markets ever start landing slowly.
 */
const PRIORITY_FEE_WEI = BigInt(process.env.MOLFI_PRIORITY_FEE_WEI || 1_000_000_000);

async function send(args) {
  const [gas, block] = await Promise.all([
    pub.estimateContractGas({ account: keeper, ...args }),
    pub.getBlock(),
  ]);
  // 2x base as the ceiling, so a base-fee spike between estimate and inclusion
  // does not strand the transaction. This is a CAP, not a payment: the chain
  // charges base + tip, so headroom is free.
  const base = block.baseFeePerGas ?? 0n;
  const hash = await wallet.writeContract({
    ...args,
    gas: (gas * 13n) / 10n,
    maxPriorityFeePerGas: PRIORITY_FEE_WEI,
    maxFeePerGas: base * 2n + PRIORITY_FEE_WEI,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`reverted: ${args.functionName} · ${hash}`);
  return hash;
}

/** Approve the escrow once, for a lot, so seeding is a single call per market. */
async function ensureEscrowAllowance(need) {
  const cur = await pub.readContract({
    address: getAddress(FXRP_TOKEN), abi: ERC20_ABI, functionName: "allowance",
    args: [keeper.address, getAddress(ESCROW)],
  });
  if (cur >= need) return;
  await send({
    address: getAddress(FXRP_TOKEN), abi: ERC20_ABI, functionName: "approve",
    args: [getAddress(ESCROW), parseUnits("1000000", 6)],
  });
}

/**
 * Stake the opening liquidity on both sides of a fresh market.
 *
 * Deliberately non-fatal: a market with no seed is worse than no market, but
 * only slightly — if this fails the market is still perfectly tradeable, so it
 * logs and moves on rather than aborting the keeper cycle.
 */
async function seedBothSides(marketId, log) {
  const amount = parseUnits(String(SEED_FXRP), 6);
  if (amount === 0n) return;
  try {
    // Idempotent: seeding runs for markets that ALREADY exist too (a keeper
    // restart must not leave the current slot's markets with an empty pot),
    // so it has to be safe to call repeatedly on the same market.
    const mine = await pub.readContract({
      address: getAddress(ESCROW), abi: ESCROW_ABI, functionName: "position",
      args: [marketId, 0, keeper.address],
    });
    if (mine > 0n) return;

    const held = await pub.readContract({
      address: getAddress(FXRP_TOKEN), abi: ERC20_ABI, functionName: "balanceOf", args: [keeper.address],
    });
    if (held < amount * 2n) {
      log(`[molfi-backend] seed skipped — keeper holds ${formatUnits(held, 6)} FXRP, needs ${formatUnits(amount * 2n, 6)}`);
      return;
    }
    await ensureEscrowAllowance(amount * 2n);
    for (const outcome of [0, 1]) {
      await send({
        address: getAddress(ESCROW), abi: ESCROW_ABI, functionName: "bet",
        args: [marketId, outcome, amount],
      });
    }
    log(`[molfi-backend] seeded ${formatUnits(amount * 2n, 6)} FXRP into ${marketId.slice(0, 12)}…`);
  } catch (e) {
    log(`[molfi-backend] seed failed for ${marketId.slice(0, 12)}…: ${e.message.split("\n")[0]}`);
  }
}

/**
 * Claim back the keeper's own winning leg after settlement.
 *
 * This is what makes seeding sustainable: the keeper staked both sides, so one
 * leg always wins and recycling it means the standing cost is the 2% fee on its
 * own turnover rather than the whole stake.
 */
async function redeemOwn(market, marketId, log) {
  try {
    await send({
      address: getAddress(ESCROW), abi: ESCROW_ABI, functionName: "redeem",
      args: [marketId, keeper.address],
    });
    log(`[molfi-backend] recycled seed from ${marketId.slice(0, 12)}…`);
  } catch {
    // Nothing staked, already redeemed, or the losing leg — all expected.
  }
}

/**
 * Create any missing market for the current slot of each (symbol, cadence).
 *
 * @param market   MolfiMarket address
 * @param feeds    symbol → bytes21 FTSO feed id
 * @param lastPrice symbol → latest spot, used for the strike
 */
export async function ensureOnchainMarkets({ market, feeds, lastPrice, log = console.log }) {
  if (!wallet) return { created: [], skipped: "MOLFI_KEEPER_KEY not configured" };

  const admin = await pub.readContract({
    address: getAddress(market), abi: MARKET_ABI, functionName: "admin",
  });
  if (getAddress(admin) !== getAddress(keeper.address)) {
    // Only the admin may create markets. Say so once rather than reverting on a
    // loop every cycle.
    return { created: [], skipped: `keeper ${keeper.address} is not the market admin (${admin})` };
  }

  const created = [];
  const now = Date.now();
  for (const { symbol, cadences } of SCHEDULE) {
    const feedId = feeds[symbol];
    const price = lastPrice[symbol];
    if (!feedId || price == null) continue;

    for (const mins of cadences) {
      const slotMs = mins * 60 * 1000;
      let closeMs = Math.ceil(now / slotMs) * slotMs;
      // A market that closes in thirty seconds is not tradeable. Roll to the
      // next slot rather than publishing something nobody can use.
      if (closeMs - now < MIN_LEAD_SECONDS * 1000) closeMs += slotMs;
      const closeSec = Math.floor(closeMs / 1000);

      const id = slotMarketId(symbol, mins, closeSec);
      const existing = await pub.readContract({
        address: getAddress(market), abi: MARKET_ABI, functionName: "marketOf", args: [id],
      });
      if (existing[8]) {
        // Already created — but it may still be unseeded (keeper restarted, or
        // the seed failed last cycle). `seedBothSides` no-ops when the keeper
        // already holds a position, so this is cheap.
        await seedBothSides(id, log);
        continue;
      }

      const strike = roundStrike(price);
      const question = `Will ${symbol} be above ${fmtStrike(strike)} at ${fmtTime(closeMs)} UTC? (${mins}m)`;
      try {
        const hash = await send({
          address: getAddress(market), abi: MARKET_ABI, functionName: "createPriceMarket",
          args: [id, question, BigInt(closeSec), feedId, parseUnits(strike, 18), 0, MAX_STALENESS],
        });
        created.push({ id, symbol, cadenceMins: mins, closeTs: closeMs, strike: Number(strike), hash });
        log(`[molfi-backend] on-chain market ${symbol} ${mins}m @ ${fmtStrike(strike)} · ${hash}`);
        await seedBothSides(id, log);
      } catch (e) {
        // `Exists` is benign — another instance won the race for this slot.
        if (!/Exists/i.test(String(e.message))) {
          log(`[molfi-backend] createPriceMarket failed (${symbol} ${mins}m): ${e.message.split("\n")[0]}`);
        }
      }
    }
  }
  return { created };
}

/**
 * Settle every past-close market that FTSO can still price.
 *
 * Permissionless on the contract, so this is a convenience, not an authority:
 * anyone can call `resolveFromOracle` and get the same answer. Without someone
 * doing it, a closed market sits unresolved and nobody can redeem.
 */
export async function resolveDue({ market, marketIds, log = console.log }) {
  if (!wallet) return { resolved: [] };
  const resolved = [];
  const now = Math.floor(Date.now() / 1000);

  for (const id of marketIds) {
    const m = await pub
      .readContract({ address: getAddress(market), abi: MARKET_ABI, functionName: "marketOf", args: [id] })
      .catch(() => null);
    if (!m || !m[8]) continue;
    const [, closeTs, , , , , status, , , hasOracle] = m;
    if (!hasOracle || status === 2 || Number(closeTs) > now) continue;

    try {
      const hash = await send({
        address: getAddress(market), abi: MARKET_ABI, functionName: "resolveFromOracle", args: [id],
      });
      resolved.push({ id, hash });
      log(`[molfi-backend] resolved ${id.slice(0, 12)}… · ${hash}`);
      await redeemOwn(market, id, log);
    } catch (e) {
      // A stale feed makes settlement revert ON PURPOSE — better an unresolved
      // market than every position paid against a frozen price. Retry next tick.
      log(`[molfi-backend] resolve ${id.slice(0, 12)}… deferred: ${e.message.split("\n")[0]}`);
    }
  }
  return { resolved };
}

// ── ConfidentialBet: publish the root a winning note proves against ──────────

const CBET_ABI = [
  { type: "function", name: "registerRoot", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "knownRoot", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

/**
 * Make a note's Merkle root claimable, and answer whether it now is.
 *
 * `ConfidentialBet.claim` refuses any root the admin has not registered
 * (`UnknownRoot`), and every note carries its OWN root — the circuit derives it
 * from the note's leaf and a fixed path, so there is no shared tree to publish
 * once up front. Without this step a commit could be made from the app but
 * never claimed; the only code that registered roots was the SDK demo, which
 * signs with the deployer key locally.
 *
 * Registration happens at CLAIM time, not commit time, and that ordering is the
 * privacy-preserving one: a root published when the note is committed would let
 * anyone watching link that commit to the later claim that spends the same
 * root. Registering only when the holder comes to claim reveals nothing that
 * their own claim transaction is not about to reveal anyway.
 *
 * Idempotent — a second claim attempt on the same note reads `knownRoot` and
 * sends nothing.
 */
export async function ensureConfidentialRoot(marketId, tier, root, log = console.log) {
  if (!wallet) throw new Error("MOLFI_KEEPER_KEY not configured — cannot register the claim root");
  const address = getAddress(CBET);
  const args = [marketId, BigInt(tier), BigInt(root)];

  if (await pub.readContract({ address, abi: CBET_ABI, functionName: "knownRoot", args })) {
    return { registered: false, alreadyKnown: true };
  }
  const hash = await send({ address, abi: CBET_ABI, functionName: "registerRoot", args });
  log(`[molfi-backend] registered claim root for ${marketId.slice(0, 12)}… tier ${tier} · ${hash}`);
  return { registered: true, alreadyKnown: false, hash };
}

export const publicClient = pub;
