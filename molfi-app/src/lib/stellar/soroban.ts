/**
 * Molfi on-chain layer — **Flare Coston2** (viem).
 *
 * Reads go through a public client; writes are sent by a pluggable wallet client
 * (the browser's injected wallet — MetaMask etc. — in the app, or a private-key
 * signer in integration tests). Every export name is preserved so the premium
 * Molfi UI compiles unchanged across the chain migration.
 *
 * Contracts (Coston2): MolfiMarket (FTSOv2-resolved lifecycle), PredictEscrow
 * (FXRP-collateralized pari-mutuel + on-chain ZK-gated bets), ConfidentialBet
 * (hidden-side commitment notes + on-chain ZK claim), FXRP (FAssets-wrapped XRP).
 *
 * GAS: calls that move FXRP or read FTSO send an explicit gas limit. Coston2's
 * eth_estimateGas under-estimates both (FAssets does transfer-fee epoch
 * bookkeeping; FTSO cost depends on execution-time state), and the resulting
 * out-of-gas reverts carry EMPTY revert data — indistinguishable from a real
 * rejection. See molfi-contracts/scripts/fassets-gas.ts.
 */
import {
  createPublicClient,
  defineChain,
  http,
  getAddress,
  parseUnits,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  CONTRACTS,
  FLARE,
  MUSDC_UNIT,
  MUSDC_DECIMALS,
  CONF_TIERS_BASE,
  FAUCET_URL,
  txUrl,
} from "@/lib/stellar/contracts";

// ---------------------------------------------------------------------------
// Chain + clients
// ---------------------------------------------------------------------------

export const coston2Chain = defineChain({
  id: FLARE.chainId,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [FLARE.rpcUrl] } },
  blockExplorers: {
    default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" },
  },
  testnet: true,
});

/** Back-compat alias — some modules import `fujiChain`. */
export const fujiChain = coston2Chain;

/**
 * Explicit gas limits for calls Coston2 under-estimates.
 * FXRP transfers measured at 151,388 actual vs 130,981 estimated.
 */
export const FXRP_GAS = 900_000n;
export const TX_GAS = 1_500_000n;

export const publicClient: PublicClient = createPublicClient({
  chain: coston2Chain,
  transport: http(FLARE.rpcUrl),
});

/** The wallet client used to send writes. Set by the wallet layer on connect
 * (browser injected wallet) or by an integration test (private-key signer). */
let _wallet: WalletClient | null = null;
let _account: `0x${string}` | null = null;

export function setWalletClient(wc: WalletClient | null, account?: `0x${string}`): void {
  _wallet = wc;
  _account = account ?? (wc?.account?.address as `0x${string}` | undefined) ?? null;
}

function requireWallet(): { wallet: WalletClient; account: `0x${string}` } {
  if (!_wallet || !_account) throw new Error("Wallet not connected");
  return { wallet: _wallet, account: _account };
}

// ---------------------------------------------------------------------------
// ABIs (minimal — only what the app calls)
// ---------------------------------------------------------------------------

const MUSDC_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

const MARKET_ABI = [
  { type: "function", name: "markets", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }] },
  { type: "function", name: "getMarket", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "string" }, { type: "uint64" }, { type: "uint8" }, { type: "uint32" }] },
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
] as const satisfies Abi;

const ESCROW_ABI = [
  { type: "function", name: "bet", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "betZk", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "uint256" }, { type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }, { type: "uint256[4]" }], outputs: [] },
  { type: "function", name: "redeem", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pool", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "total", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

const CBET_ABI = [
  { type: "function", name: "commit", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }], outputs: [] },
  { type: "function", name: "commitBatch", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256[]" }, { type: "uint256[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "denoms", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "poolStatus", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
] as const satisfies Abi;

const SEALED_ABI = [
  { type: "function", name: "sealBid", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bookStatus", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bool" }] },
  { type: "function", name: "books", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
    { name: "totalEscrowed", type: "uint256" }, { name: "bidCount", type: "uint32" }, { name: "opened", type: "bool" },
    { name: "yesPool", type: "uint256" }, { name: "noPool", type: "uint256" }, { name: "openingsRoot", type: "bytes32" }] },
  { type: "function", name: "openMarket", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes" }], outputs: [] },
] as const satisfies Abi;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const asHex = (h: string): Hex => (h.startsWith("0x") ? (h as Hex) : (`0x${h}` as Hex));
const toBase = (amountUsdc: number): bigint => parseUnits(String(amountUsdc), MUSDC_DECIMALS);
// A bare hex digest (e.g. a sha256 commitment) → 0x-prefixed then BigInt.
const bigHex = (h: string): bigint => BigInt(asHex(h));
// A field element the backend emits as a DECIMAL string (snarkjs publicSignals:
// root, nullifierHash, proof coords). BigInt() parses decimal and 0x-hex alike —
// but must NOT be 0x-prefixed first, or the decimal would be reparsed as hex and
// overflow uint256. (This is why publicInputs/root/nullifierHash use bigField,
// NOT bigHex.)
const bigField = (n: string): bigint => BigInt(n);

/** Convert a proof (snarkjs pi_* form, or {a,b,c} as hex/decimal string arrays)
 * into the Solidity Groth16 calldata shape the on-chain verifier expects. */
type RawProof =
  | { pi_a: string[]; pi_b: string[][]; pi_c: string[] }
  | { a: string | string[]; b: string | string[][]; c: string | string[] };

function toSolProof(p: RawProof): {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
} {
  if ("pi_a" in p) {
    return {
      a: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
      // snarkjs G2 coordinates are swapped relative to the EVM verifier.
      b: [
        [BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])],
        [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])],
      ],
      c: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
    };
  }
  const a = Array.isArray(p.a) ? p.a : [];
  const b = Array.isArray(p.b) ? (p.b as string[][]) : [];
  const c = Array.isArray(p.c) ? p.c : [];
  return {
    a: [BigInt(a[0]), BigInt(a[1])],
    b: [
      [BigInt(b[0][0]), BigInt(b[0][1])],
      [BigInt(b[1][0]), BigInt(b[1][1])],
    ],
    c: [BigInt(c[0]), BigInt(c[1])],
  };
}

async function read<T>(address: string, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await publicClient.readContract({
    address: getAddress(address),
    abi,
    functionName,
    args: args as never,
  })) as T;
}

async function send(
  address: string,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  gas?: bigint,
): Promise<string> {
  const { wallet, account } = requireWallet();
  const hash = await wallet.writeContract({
    address: getAddress(address),
    abi,
    functionName,
    args: args as never,
    ...(gas ? { gas } : {}),
    // Use the client's configured account: a local key signs + broadcasts via
    // eth_sendRawTransaction (tests), an injected-wallet address signs via the
    // provider's eth_sendTransaction (browser).
    account: wallet.account ?? account,
    chain: coston2Chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // A mined transaction is not a successful one. Without this check the UI
  // showed a green "bet placed" toast — with an explorer link — for a bet that
  // reverted, so a user with insufficient FXRP believed they held a position
  // they did not. Reverts here are ordinary (not enough FXRP, allowance spent,
  // market closed between quote and send), so they must surface as failures.
  if (receipt.status !== "success") {
    throw new Error(
      `Transaction reverted on-chain (${functionName}). ` +
        `Check your FXRP balance and that the market is still open. ` +
        `Details: ${txUrl(hash)}`,
    );
  }
  return hash;
}

/** Approve `spender` to pull at least `amount` FXRP from `owner` (idempotent). */
async function ensureAllowance(owner: string, spender: string, amount: bigint): Promise<void> {
  const current = await read<bigint>(CONTRACTS.fxrp, MUSDC_ABI, "allowance", [getAddress(owner), getAddress(spender)]);
  if (current >= amount) return;
  await send(CONTRACTS.fxrp, MUSDC_ABI, "approve", [getAddress(spender), 2n ** 256n - 1n], 200_000n);
}

// ---------------------------------------------------------------------------
// Market contract (lifecycle + enumeration)
// ---------------------------------------------------------------------------

export interface OnChainMarket {
  id: string; // hex
  question: string;
  closeTs: number;
  status: number; // 0 Trading, 1 Resolving, 2 Resolved
  outcome: number; // 0 YES, 1 NO, 2 INVALID
}

/** Enumerate all markets and fetch each one's state. */
export async function listMarkets(): Promise<OnChainMarket[]> {
  const ids = await read<readonly Hex[]>(CONTRACTS.market, MARKET_ABI, "markets");
  const out: OnChainMarket[] = [];
  for (const id of ids ?? []) {
    const m = await getMarket(id).catch(() => null);
    if (m) out.push(m);
  }
  return out;
}

/** Fetch a single market's state by 32-byte hex id. */
export async function getMarket(idHex: string): Promise<OnChainMarket> {
  const [question, closeTs, status, outcome] = await read<[string, bigint, number, number]>(
    CONTRACTS.market,
    MARKET_ABI,
    "getMarket",
    [asHex(idHex)],
  );
  return {
    id: asHex(idHex),
    question,
    closeTs: Number(closeTs),
    status: Number(status),
    outcome: Number(outcome),
  };
}

export async function isResolved(idHex: string): Promise<boolean> {
  return read<boolean>(CONTRACTS.market, MARKET_ABI, "isResolved", [asHex(idHex)]);
}

/** Winning outcome (0 YES / 1 NO) for a resolved market. */
export async function winningOutcome(idHex: string): Promise<number> {
  return Number(await read<number>(CONTRACTS.market, MARKET_ABI, "winningOutcome", [asHex(idHex)]));
}

/** Permissionlessly settle an oracle market after close (reads FTSOv2 via FtsoOracle). */
export async function resolveFromOracle(walletAddress: string, idHex: string): Promise<string> {
  return send(CONTRACTS.market, MARKET_ABI, "resolveFromOracle", [asHex(idHex)], TX_GAS);
}

// ---------------------------------------------------------------------------
// FXRP (FAssets-wrapped XRP) — collateral
// ---------------------------------------------------------------------------

/**
 * FXRP cannot be minted by the app.
 *
 * This is the substantive difference from the mock token it replaces: FXRP is a
 * real, over-collateralized claim on XRP held by FAssets agents, so there is no
 * open `mint()` to call. Testnet FXRP comes from the Coston2 faucet (or from
 * the full FAssets mint flow against real XRPL funds). Throwing here — rather
 * than silently no-op'ing — keeps the UI honest about where value comes from.
 */
export const FAUCET_LINK = FAUCET_URL;

export function faucet(_to?: string): Promise<string> {
  return Promise.reject(
    new Error(
      `FXRP has no open faucet contract — it is real bridged XRP. ` +
        `Get testnet FXRP at ${FAUCET_URL}`,
    ),
  );
}

/** FXRP balance (base units) for an address. */
export async function fxrpBalance(addr: string): Promise<bigint> {
  return read<bigint>(CONTRACTS.fxrp, MUSDC_ABI, "balanceOf", [getAddress(addr)]);
}

/** Back-compat alias used across the premium UI. */
export const musdcBalance = fxrpBalance;

// ---------------------------------------------------------------------------
// PredictEscrow (real-FXRP pari-mutuel bet + payout)
// ---------------------------------------------------------------------------

/** Escrow `amountUsdc` FXRP on an outcome (0=YES, 1=NO) of an on-chain market. */
export async function escrowBet(
  walletAddress: string,
  marketIdHex: string,
  outcome: number,
  amountUsdc: number,
): Promise<string> {
  const amount = toBase(amountUsdc);
  await ensureAllowance(walletAddress, CONTRACTS.predictEscrow, amount);
  return send(CONTRACTS.predictEscrow, ESCROW_ABI, "bet", [asHex(marketIdHex), outcome, amount], FXRP_GAS);
}

/** Claim winnings on a resolved on-chain market. */
export async function escrowRedeem(walletAddress: string, marketIdHex: string): Promise<string> {
  return send(CONTRACTS.predictEscrow, ESCROW_ABI, "redeem", [asHex(marketIdHex), getAddress(walletAddress)], FXRP_GAS);
}

/** A wallet's escrowed stake (base units) on (market, outcome). */
export async function escrowPosition(marketIdHex: string, outcome: number, who: string): Promise<bigint> {
  return read<bigint>(CONTRACTS.predictEscrow, ESCROW_ABI, "position", [asHex(marketIdHex), outcome, getAddress(who)]);
}

/** Total FXRP (base units) escrowed across both sides of a market. */
export async function escrowTotal(marketIdHex: string): Promise<bigint> {
  return read<bigint>(CONTRACTS.predictEscrow, ESCROW_ABI, "total", [asHex(marketIdHex)]);
}

/** Total FXRP (base units) escrowed on one outcome (the real on-chain pool). */
export async function escrowPool(marketIdHex: string, outcome: number): Promise<bigint> {
  return read<bigint>(CONTRACTS.predictEscrow, ESCROW_ABI, "pool", [asHex(marketIdHex), outcome]);
}

/**
 * Privacy bet: escrow `amountUsdc` FXRP on `outcome`, gated by a Groth16 proof
 * the escrow verifies ON-CHAIN before accepting (its nullifier is burned,
 * single-use). Public signals `[root, nullifierHash, outcome, recipient]`.
 */
export async function escrowBetZk(
  walletAddress: string,
  marketIdHex: string,
  outcome: number,
  amountUsdc: number,
  proof: RawProof,
  publicInputs: string[],
  _domain: string,
): Promise<string> {
  if (!publicInputs || publicInputs.length < 4) throw new Error("bad public inputs");
  const amount = toBase(amountUsdc);
  await ensureAllowance(walletAddress, CONTRACTS.predictEscrow, amount);
  const { a, b, c } = toSolProof(proof);
  const pub = [bigField(publicInputs[0]), bigField(publicInputs[1]), bigField(publicInputs[2]), bigField(publicInputs[3])];
  return send(CONTRACTS.predictEscrow, ESCROW_ABI, "betZk", [asHex(marketIdHex), outcome, amount, a, b, c, pub], TX_GAS);
}

/** Deposit `amountUsdc` FXRP into the fee vault (funds the escrow's LP pot). */
export async function vaultDepositOnChain(walletAddress: string, amountUsdc: number): Promise<string> {
  const amount = toBase(amountUsdc);
  return send(CONTRACTS.fxrp, MUSDC_ABI, "transfer", [getAddress(CONTRACTS.vault), amount], FXRP_GAS);
}

// ---------------------------------------------------------------------------
// ConfidentialBet (hidden-side commitment notes + on-chain ZK claim)
// ---------------------------------------------------------------------------

/**
 * Escrow one fixed-denomination (1 FXRP) commitment note. The `commitment` is
 * a binding hash of an off-chain note (secret, nullifier, chosen side) — nothing
 * on-chain reveals which outcome it backs, and the uniform denom hides the amount.
 */
export async function confidentialCommit(
  walletAddress: string,
  marketIdHex: string,
  tier: number,
  commitmentHex: string,
): Promise<string> {
  // Approve exactly this tier's stake — the contract pulls denoms[tier] and
  // nothing more.
  const stake = CONF_TIERS_BASE[tier] ?? CONF_TIERS_BASE[0];
  await ensureAllowance(walletAddress, CONTRACTS.confidentialBet, stake);
  return send(
    CONTRACTS.confidentialBet,
    CBET_ABI,
    "commit",
    [asHex(marketIdHex), BigInt(tier), bigHex(commitmentHex)],
    FXRP_GAS,
  );
}

/**
 * Escrow an ARBITRARY stake as a batch of standard notes.
 *
 * The total moves in one transfer, so the deposit reads as a single amount
 * rather than a run of identical ones. Each note is claimed separately later.
 */
export async function confidentialCommitBatch(
  walletAddress: string,
  marketIdHex: string,
  tiers: readonly number[],
  commitmentHexes: readonly string[],
): Promise<string> {
  const total = tiers.reduce(
    (sum, t) => sum + (CONF_TIERS_BASE[t] ?? 0n),
    0n,
  );
  await ensureAllowance(walletAddress, CONTRACTS.confidentialBet, total);
  return send(
    CONTRACTS.confidentialBet,
    CBET_ABI,
    "commitBatch",
    [asHex(marketIdHex), tiers.map((t) => BigInt(t)), commitmentHexes.map(bigHex)],
    // Scales with note count — a 27-note batch is far past the single-note limit.
    TX_GAS + BigInt(tiers.length) * 120_000n,
  );
}

// ---------------------------------------------------------------------------
// SealedBidBook — the FCC-backed dark book
// ---------------------------------------------------------------------------

/** What the public can see while a market is live: size, never the split. */
export async function sealedBookStatus(marketId: string): Promise<{
  totalEscrowed: bigint; bidCount: number; opened: boolean;
  yesPool: bigint; noPool: bigint;
}> {
  const b = (await read(CONTRACTS.sealedBidBook, SEALED_ABI, "books", [asHex(marketId)])) as readonly [
    bigint, number, boolean, bigint, bigint, string,
  ];
  return { totalEscrowed: b[0], bidCount: Number(b[1]), opened: b[2], yesPool: b[3], noPool: b[4] };
}

/** Escrow FXRP against a bid whose side is encrypted to the enclave. */
export async function sealBid(
  walletAddress: string,
  marketId: string,
  amountFxrp: number,
  ciphertext: string,
): Promise<string> {
  const amt = toBase(amountFxrp);
  await ensureAllowance(walletAddress, CONTRACTS.sealedBidBook, amt);
  return send(
    CONTRACTS.sealedBidBook, SEALED_ABI, "sealBid",
    [asHex(marketId), amt, asHex(ciphertext)],
    FXRP_GAS,
  );
}

/** Relay the enclave's signed opening. Permissionless — the signature authorises it. */
export async function openSealedBook(
  marketId: string,
  yesPool: bigint,
  noPool: bigint,
  bidCount: number,
  openingsRoot: string,
  signature: string,
): Promise<string> {
  return send(
    CONTRACTS.sealedBidBook, SEALED_ABI, "openMarket",
    [asHex(marketId), yesPool, noPool, bidCount, asHex(openingsRoot), asHex(signature)],
    TX_GAS,
  );
}

/** Claim a winning sealed bid with the enclave's Merkle proof of your side. */
export async function claimSealedBid(
  marketId: string,
  bidIndex: number,
  side: number,
  proof: readonly string[],
): Promise<string> {
  return send(
    CONTRACTS.sealedBidBook, SEALED_ABI, "claim",
    [asHex(marketId), BigInt(bidIndex), side, proof.map(asHex)],
    FXRP_GAS,
  );
}

/** Collateral held and how many claims of `tier` it covers. */
export async function confidentialPoolStatus(tier: number): Promise<{ balance: bigint; claimsCovered: bigint }> {
  const [balance, claimsCovered] = (await read(
    CONTRACTS.confidentialBet, CBET_ABI, "poolStatus", [BigInt(tier)],
  )) as [bigint, bigint];
  return { balance, claimsCovered };
}

/**
 * Claim a winning confidential note. The proof is verified ON-CHAIN: the contract
 * injects the resolved winning outcome as a public input, so only a note that
 * backed the winner verifies. The nullifier is burned (single-use) and the payout
 * is paid to the wallet — unlinkable to the deposit.
 */
export async function confidentialClaim(
  walletAddress: string,
  marketIdHex: string,
  tier: number,
  proof: RawProof,
  nullifierHashHex: string,
  _recipientFieldHex: string,
  rootHex: string,
): Promise<string> {
  const { a, b, c } = toSolProof(proof);
  return send(CONTRACTS.confidentialBet, CBET_ABI, "claim", [
    asHex(marketIdHex),
    BigInt(tier),
    a,
    b,
    c,
    bigField(rootHex),
    bigField(nullifierHashHex),
    getAddress(walletAddress),
  ],
    TX_GAS,
  );
}

// ---------------------------------------------------------------------------
// Legacy clob aliases (retained for import compatibility; escrow is the single
// settlement contract on Coston2).
// ---------------------------------------------------------------------------

export const balance = (trader: string): Promise<bigint> => musdcBalance(trader);
export const position = (holder: string, marketHex: string, outcome: number): Promise<bigint> =>
  escrowPosition(marketHex, outcome, holder);
export const escrow = (marketHex: string): Promise<bigint> => escrowTotal(marketHex);
export const redeem = (holder: string, marketHex: string): Promise<string> => escrowRedeem(holder, marketHex);
