/**
 * The Molfi tool surface, independent of MCP transport so it can be unit-tested
 * directly. Each handler returns a plain object; index.mjs wraps them for MCP.
 *
 * Design note: every tool answers in FXRP and human prices, never base units.
 * An agent reasoning about "should I take this bet" should not have to know
 * that FXRP carries 6 decimals or that FTSO returns 18 — those are our problem.
 */
import { getAddress } from "viem";
import {
  CONTRACTS, ESCROW_ABI, ERC20_ABI, FEEDS, GAS, MARKET_ABI, ORACLE_ABI,
  agentAccount, asHex, feedSymbol, fmtFxrp, publicClient, readMarket, toFxrp,
  txUrl, walletClient,
} from "./chain.mjs";

const OUTCOME = { YES: 0, NO: 1 };

/** Live FTSOv2 price for a symbol, read through the deployed oracle. */
export async function getPrice({ symbol }) {
  const feedId = FEEDS[String(symbol).toUpperCase()];
  if (!feedId) {
    throw new Error(`unknown symbol "${symbol}" — supported: ${Object.keys(FEEDS).join(", ")}`);
  }
  const [price, ts] = await publicClient.readContract({
    address: getAddress(CONTRACTS.oracle), abi: ORACLE_ABI,
    functionName: "getPrice", args: [feedId],
  });
  return {
    symbol: String(symbol).toUpperCase(),
    priceUsd: Number(price) / 1e18,
    updatedAt: new Date(Number(ts) * 1000).toISOString(),
    ageSeconds: Math.floor(Date.now() / 1000) - Number(ts),
    source: "FTSOv2 (Flare first-party oracle)",
  };
}

/** All markets, newest close first, optionally only those still open. */
export async function listMarkets({ openOnly = true, limit = 25 } = {}) {
  const ids = await publicClient.readContract({
    address: getAddress(CONTRACTS.market), abi: MARKET_ABI, functionName: "markets",
  });
  const all = (await Promise.all(ids.map((id) => readMarket(id).catch(() => null)))).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  const rows = openOnly ? all.filter((m) => !m.resolved && m.closeTs > now) : all;
  rows.sort((a, b) => a.closeTs - b.closeTs);
  return { count: rows.length, markets: rows.slice(0, limit) };
}

export async function getMarket({ marketId }) {
  const m = await readMarket(marketId);
  if (!m) throw new Error(`market ${marketId} not found`);
  // What it would settle to right now — free, and the same read settlement uses.
  try {
    const p = await publicClient.readContract({
      address: getAddress(CONTRACTS.market), abi: MARKET_ABI,
      functionName: "previewResolution", args: [asHex(marketId)],
    });
    m.preview = {
      priceUsd: Number(p[0]) / 1e18,
      wouldResolveTo: p[2] ? "YES" : "NO",
    };
  } catch {
    /* non-price market, or feed unavailable */
  }
  return m;
}

/** The agent's own wallet: address, gas, FXRP bankroll. */
export async function getWallet() {
  const account = agentAccount();
  if (!account) {
    return {
      connected: false,
      note: "No MOLFI_AGENT_KEY set — read-only. Set it to a funded Coston2 key to trade.",
    };
  }
  const [gas, fxrp] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: getAddress(CONTRACTS.fxrp), abi: ERC20_ABI,
      functionName: "balanceOf", args: [account.address],
    }),
  ]);
  return {
    connected: true,
    address: account.address,
    gasC2FLR: Number(gas) / 1e18,
    fxrp: fmtFxrp(fxrp),
    faucet: "https://faucet.flare.network/coston2",
    note:
      "FXRP cannot be minted — it is a real over-collateralized claim on XRP. " +
      "Top up from the faucet on testnet.",
  };
}

/** The agent's escrowed position on a market. */
export async function getPosition({ marketId, address }) {
  // Read-only servers have no agent account, so `address` is the only source.
  // Falling through to getAddress("") here surfaced viem's `Address "" is
  // invalid` — a library internal that names neither remedy.
  const target = address ?? agentAccount()?.address;
  if (!target) {
    throw new Error(
      "no address to read — pass `address`, or set MOLFI_AGENT_KEY to read " +
        "the agent's own position",
    );
  }
  const who = getAddress(target);
  const [yes, no, redeemed] = await Promise.all([
    publicClient.readContract({ address: getAddress(CONTRACTS.escrow), abi: ESCROW_ABI, functionName: "position", args: [asHex(marketId), 0, who] }),
    publicClient.readContract({ address: getAddress(CONTRACTS.escrow), abi: ESCROW_ABI, functionName: "position", args: [asHex(marketId), 1, who] }),
    publicClient.readContract({ address: getAddress(CONTRACTS.escrow), abi: ESCROW_ABI, functionName: "redeemed", args: [asHex(marketId), who] }),
  ]);
  const market = await readMarket(marketId);
  let payoutIfWin = null;
  if (market && !market.resolved) {
    const side = yes > 0n ? 0 : no > 0n ? 1 : null;
    if (side !== null) {
      const p = await publicClient.readContract({
        address: getAddress(CONTRACTS.escrow), abi: ESCROW_ABI,
        functionName: "previewPayout", args: [asHex(marketId), who, side],
      }).catch(() => null);
      if (p) payoutIfWin = { net: fmtFxrp(p[0]), fee: fmtFxrp(p[1]) };
    }
  }
  return {
    marketId: asHex(marketId),
    address: who,
    yes: fmtFxrp(yes),
    no: fmtFxrp(no),
    redeemed,
    resolved: market?.resolved ?? false,
    winningOutcome: market?.winningOutcome ?? null,
    payoutIfWin,
  };
}

/**
 * Stake FXRP on an outcome.
 *
 * Approves only what this bet needs rather than an infinite allowance — an
 * agent placing many small bets should not leave an unbounded approval behind.
 */
export async function placeBet({ marketId, outcome, amount }) {
  const side = String(outcome).toUpperCase();
  if (!(side in OUTCOME)) throw new Error(`outcome must be YES or NO, got "${outcome}"`);
  const amt = toFxrp(amount);
  if (amt <= 0n) throw new Error("amount must be > 0");

  const market = await readMarket(marketId);
  if (!market) throw new Error(`market ${marketId} not found`);
  if (market.resolved) throw new Error(`market already resolved (${market.winningOutcome} won)`);
  // Betting stops at CLOSE, not at resolution. Settlement reads the FTSO price
  // at close, and resolveFromOracle is permissionless and unscheduled — so in
  // the gap the outcome is already fixed and readable (molfi_get_market hands
  // the agent `preview.wouldResolveTo` for this exact market). PredictEscrow
  // rejects it on-chain; catching it here saves the agent a reverting tx.
  if (market.closesInSeconds <= 0) {
    throw new Error(
      `market closed ${-market.closesInSeconds}s ago and is awaiting settlement — ` +
        `no new stake accepted. Call molfi_resolve_market to settle it.`,
    );
  }

  const wallet = walletClient();
  const me = wallet.account.address;

  const balance = await publicClient.readContract({
    address: getAddress(CONTRACTS.fxrp), abi: ERC20_ABI, functionName: "balanceOf", args: [me],
  });
  if (balance < amt) {
    throw new Error(
      `insufficient FXRP: have ${fmtFxrp(balance)}, need ${fmtFxrp(amt)}. ` +
        `FXRP cannot be minted — fund at https://faucet.flare.network/coston2`,
    );
  }

  const allowance = await publicClient.readContract({
    address: getAddress(CONTRACTS.fxrp), abi: ERC20_ABI,
    functionName: "allowance", args: [me, getAddress(CONTRACTS.escrow)],
  });
  const txs = [];
  if (allowance < amt) {
    const h = await wallet.writeContract({
      address: getAddress(CONTRACTS.fxrp), abi: ERC20_ABI, functionName: "approve",
      args: [getAddress(CONTRACTS.escrow), amt], gas: GAS.approve,
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    txs.push({ step: "approve", hash: h, url: txUrl(h) });
  }

  const hash = await wallet.writeContract({
    address: getAddress(CONTRACTS.escrow), abi: ESCROW_ABI, functionName: "bet",
    args: [asHex(marketId), OUTCOME[side], amt], gas: GAS.fxrp,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  txs.push({ step: "bet", hash, url: txUrl(hash) });
  if (receipt.status !== "success") throw new Error(`bet reverted — see ${txUrl(hash)}`);

  return {
    ok: true,
    marketId: asHex(marketId),
    question: market.question,
    side,
    amountFxrp: fmtFxrp(amt),
    transactions: txs,
    settledBy: "FTSOv2 at close — anyone may call resolve",
  };
}

/**
 * Settle a market from FTSOv2. Permissionless: the agent can resolve any
 * market past its close, including ones it has no position in.
 */
export async function resolveMarket({ marketId }) {
  const market = await readMarket(marketId);
  if (!market) throw new Error(`market ${marketId} not found`);
  if (market.resolved) {
    return { ok: true, alreadyResolved: true, winningOutcome: market.winningOutcome };
  }
  if (market.closesInSeconds > 0) {
    throw new Error(`market has not closed yet — ${market.closesInSeconds}s remaining`);
  }
  const wallet = walletClient();
  // Probe first: a genuine rejection (stale feed) returns a decodable error,
  // whereas an out-of-gas does not — and on Coston2 both look identical on-chain.
  await publicClient.simulateContract({
    address: getAddress(CONTRACTS.market), abi: MARKET_ABI,
    functionName: "resolveFromOracle", args: [asHex(marketId)], account: wallet.account,
  });
  const hash = await wallet.writeContract({
    address: getAddress(CONTRACTS.market), abi: MARKET_ABI,
    functionName: "resolveFromOracle", args: [asHex(marketId)], gas: GAS.tx,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // Mined is not the same as succeeded — report a revert as a failure rather
  // than telling the agent the market settled when it did not.
  if (receipt.status !== "success") {
    throw new Error(`resolve reverted on-chain — see ${txUrl(hash)}`);
  }
  const after = await readMarket(marketId);
  return { ok: true, marketId: asHex(marketId), winningOutcome: after.winningOutcome, hash, url: txUrl(hash) };
}

/** Claim winnings after resolution. */
export async function redeem({ marketId, address }) {
  const wallet = walletClient();
  const who = getAddress(address ?? wallet.account.address);
  const market = await readMarket(marketId);
  if (!market) throw new Error(`market ${marketId} not found`);
  if (!market.resolved) throw new Error("market is not resolved yet — call resolve_market first");

  const before = await publicClient.readContract({
    address: getAddress(CONTRACTS.fxrp), abi: ERC20_ABI, functionName: "balanceOf", args: [who],
  });
  const hash = await wallet.writeContract({
    address: getAddress(CONTRACTS.escrow), abi: ESCROW_ABI, functionName: "redeem",
    args: [asHex(marketId), who], gas: GAS.fxrp,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(
      `redeem reverted on-chain — you may hold no winning position, or have ` +
        `already redeemed. See ${txUrl(hash)}`,
    );
  }
  const after = await publicClient.readContract({
    address: getAddress(CONTRACTS.fxrp), abi: ERC20_ABI, functionName: "balanceOf", args: [who],
  });
  return {
    ok: true,
    marketId: asHex(marketId),
    payoutFxrp: fmtFxrp(after - before),
    winningOutcome: market.winningOutcome,
    hash,
    url: txUrl(hash),
  };
}

export const TOOLS = {
  molfi_get_price: getPrice,
  molfi_list_markets: listMarkets,
  molfi_get_market: getMarket,
  molfi_get_wallet: getWallet,
  molfi_get_position: getPosition,
  molfi_place_bet: placeBet,
  molfi_resolve_market: resolveMarket,
  molfi_redeem: redeem,
};
