/**
 * The on-chain layer: real viem calls to Molfi's contracts on Flare Coston2,
 * signed by a local private-key account (so an autonomous agent can transact
 * without a browser wallet). Reads go through a public client; writes are sent
 * by a wallet client and awaited.
 *
 *   chain.faucet()                        → rejects; FXRP is bridged XRP, use the faucet
 *   chain.fxrpBalance()                  → read FXRP balance
 *   chain.bet(marketId, YES, 1000)        → escrow real FXRP on an outcome
 *   chain.betZk(...)                      → bet gated by an on-chain Groth16 proof
 *   chain.redeem(marketId)                → claim winnings after resolution
 *   chain.winningOutcome(marketId)        → read resolved outcome
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  parseUnits,
  type Abi,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { TESTNET, OUTCOME_YES, OUTCOME_NO, type MolfiConfig } from "./config.js";

/** Groth16 proof in Solidity-calldata shape (BN254). */
export interface Groth16Proof {
  a: [bigint, bigint] | [string, string];
  b: [[bigint, bigint], [bigint, bigint]] | [[string, string], [string, string]];
  c: [bigint, bigint] | [string, string];
}

export interface ChainOptions {
  config?: MolfiConfig;
  /** 0x… private key for signing writes. Omit for read-only. */
  privateKey?: Hex;
  /** Alias accepted for back-compat with older callers that passed `secret`. */
  secret?: Hex;
}

const asHex = (h: string): Hex => (h.startsWith("0x") ? (h as Hex) : (`0x${h}` as Hex));

const MUSDC_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

const MARKET_ABI = [
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "resolveFromOracle", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] },
  {
    type: "function", name: "getMarket", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "question", type: "string" }, { name: "closeTs", type: "uint64" },
      { name: "status", type: "uint8" }, { name: "outcome", type: "uint32" },
    ],
  },
] as const satisfies Abi;

const ESCROW_ABI = [
  { type: "function", name: "bet", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "betZk", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "uint256" }, { type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }, { type: "uint256[4]" }], outputs: [] },
  { type: "function", name: "redeem", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "total", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

const MAX_UINT = 2n ** 256n - 1n;

export class MolfiChain {
  readonly config: MolfiConfig;
  readonly chain: Chain;
  readonly pub: PublicClient;
  private readonly account?: PrivateKeyAccount;
  private readonly wallet?: WalletClient;

  constructor(opts: ChainOptions = {}) {
    this.config = opts.config ?? TESTNET;
    this.chain = defineChain({
      id: this.config.chainId,
      name: "Flare Coston2",
      nativeCurrency: { name: "Flare", symbol: "C2FLR", decimals: 18 },
      rpcUrls: { default: { http: [this.config.rpcUrl] } },
      blockExplorers: { default: { name: "Coston2 Explorer", url: this.config.explorer } },
      testnet: true,
    });
    this.pub = createPublicClient({ chain: this.chain, transport: http(this.config.rpcUrl) });
    const key = opts.privateKey ?? opts.secret;
    if (key) {
      this.account = privateKeyToAccount(asHex(key));
      this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport: http(this.config.rpcUrl) });
    }
  }

  /** The signer's address, or undefined if read-only. */
  get address(): string | undefined {
    return this.account?.address;
  }

  private requireSigner(): { account: PrivateKeyAccount; wallet: WalletClient } {
    if (!this.account || !this.wallet) {
      throw new Error("No signer — construct MolfiChain with { privateKey }");
    }
    return { account: this.account, wallet: this.wallet };
  }

  private async read<T>(address: string, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.pub.readContract({
      address: getAddress(address),
      abi,
      functionName,
      args: args as never,
    })) as T;
  }

  /**
   * Send a write and wait for it.
   *
   * `gas` is not optional in practice — Coston2's `eth_estimateGas` under-reports
   * FXRP transfers and FTSO-reading writes, and the resulting out-of-gas revert
   * carries EMPTY revert data, so it looks like a policy rejection rather than a
   * gas problem. Every call site passes a limit from `config.gas`.
   */
  private async send(address: string, abi: Abi, functionName: string, args: readonly unknown[], gas?: bigint): Promise<string> {
    const { account, wallet } = this.requireSigner();
    const hash = await wallet.writeContract({
      address: getAddress(address),
      abi,
      functionName,
      args: args as never,
      account,
      chain: this.chain,
      ...(gas ? { gas } : {}),
    });
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    // A reverted tx still returns a hash and a receipt. Without this check the
    // SDK hands the caller a "successful" hash for a transaction that did
    // nothing — the single most misleading failure mode there is.
    if (receipt.status !== "success") {
      throw new Error(
        `Transaction reverted on-chain (${functionName}): ${this.config.explorer}/tx/${hash}`,
      );
    }
    return hash;
  }

  /**
   * Reject a stake on a market that has already closed.
   *
   * Settlement reads the FTSO price at close, and that price is public the
   * instant close passes, while `resolveFromOracle` is permissionless and
   * unscheduled — so a market can sit closed-but-unresolved indefinitely and a
   * stake placed in that window is a risk-free claim on the pot. `PredictEscrow`
   * enforces this on-chain; checking here turns a wasted reverting transaction
   * into an immediate, explicable error.
   */
  private async requireOpen(marketId: string): Promise<void> {
    const [, closeTs] = await this.read<[string, bigint, number, number]>(
      this.config.contracts.market, MARKET_ABI, "getMarket", [asHex(marketId)],
    );
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now >= closeTs) {
      throw new Error(
        `market ${marketId} closed ${now - closeTs}s ago — no new stake is accepted ` +
          `after close. Call resolveFromOracle() to settle it.`,
      );
    }
  }

  private toBase(amount: number): bigint {
    return parseUnits(String(amount), this.config.decimals);
  }

  /** Approve the escrow to pull at least `amount` FXRP (idempotent). */
  private async ensureAllowance(spender: string, amount: bigint): Promise<void> {
    const { account } = this.requireSigner();
    const current = await this.read<bigint>(this.config.contracts.fxrp, MUSDC_ABI, "allowance", [account.address, getAddress(spender)]);
    if (current >= amount) return;
    await this.send(this.config.contracts.fxrp, MUSDC_ABI, "approve", [getAddress(spender), MAX_UINT], this.config.gas.approve);
  }

  // ── FXRP ──────────────────────────────────────────────────────────────────

  /**
   * FXRP cannot be minted.
   *
   * The Avalanche build collateralized markets in a mock token with an open
   * `mint()`, so an agent could fund itself in one call. FXRP is the FAssets
   * representation of real XRP — over-collateralized and redeemable back to the
   * XRP Ledger — so no contract call can create it. On Coston2 it comes from the
   * faucet; in production it comes from the FAssets mint flow against real XRP.
   *
   * This rejects rather than silently no-op'ing so an agent fails loudly at the
   * funding step instead of proceeding to a bet it cannot pay for.
   */
  faucet(_to?: string): Promise<string> {
    return Promise.reject(
      new Error(
        "FXRP has no mint function — it is real bridged XRP. Fund this wallet " +
          "from https://faucet.flare.network/coston2 (C2FLR for gas + FXRP), " +
          "then retry.",
      ),
    );
  }

  /** FXRP balance in base units (6 decimals — XRP drops; 1 FXRP = 1_000_000). */
  async fxrpBalance(who?: string): Promise<bigint> {
    const target = getAddress(who ?? this.address ?? "0x0000000000000000000000000000000000000000");
    return this.read<bigint>(this.config.contracts.fxrp, MUSDC_ABI, "balanceOf", [target]);
  }

  // ── Betting (predict-escrow) ─────────────────────────────────────────────────

  /** Escrow real FXRP on an outcome (0=YES, 1=NO). `amount` is human FXRP. */
  async bet(marketId: string, outcome: number, amount: number): Promise<string> {
    const amt = this.toBase(amount);
    await this.requireOpen(marketId);
    await this.ensureAllowance(this.config.contracts.predictEscrow, amt);
    return this.send(this.config.contracts.predictEscrow, ESCROW_ABI, "bet", [asHex(marketId), outcome, amt], this.config.gas.fxrp);
  }

  /**
   * Privacy bet: escrow gated by an on-chain Groth16 proof. The proof is
   * verified inside the transaction and its nullifier is burned (single-use).
   * Public signals order `[root, nullifierHash, outcome, recipient]`.
   */
  async betZk(
    marketId: string,
    outcome: number,
    amount: number,
    proof: Groth16Proof,
    publicInputs: (string | bigint)[],
  ): Promise<string> {
    const amt = this.toBase(amount);
    await this.requireOpen(marketId);
    await this.ensureAllowance(this.config.contracts.predictEscrow, amt);
    const a = [BigInt(proof.a[0]), BigInt(proof.a[1])] as const;
    const b = [
      [BigInt(proof.b[0][0]), BigInt(proof.b[0][1])],
      [BigInt(proof.b[1][0]), BigInt(proof.b[1][1])],
    ] as const;
    const c = [BigInt(proof.c[0]), BigInt(proof.c[1])] as const;
    const pub = publicInputs.slice(0, 4).map((x) => BigInt(x));
    // `tx` (1.5M), not `fxrp` (900k): betZk does an on-chain Groth16 BN254
    // pairing check and a nullifier write on top of the FXRP transferFrom.
    return this.send(this.config.contracts.predictEscrow, ESCROW_ABI, "betZk", [asHex(marketId), outcome, amt, a, b, c, pub], this.config.gas.tx);
  }

  /** Claim winnings after the market resolves. Returns tx hash. */
  redeem(marketId: string, to?: string): Promise<string> {
    const { account } = this.requireSigner();
    return this.send(this.config.contracts.predictEscrow, ESCROW_ABI, "redeem", [asHex(marketId), getAddress(to ?? account.address)], this.config.gas.fxrp);
  }

  async escrowTotal(marketId: string): Promise<bigint> {
    return this.read<bigint>(this.config.contracts.predictEscrow, ESCROW_ABI, "total", [asHex(marketId)]);
  }

  async escrowPosition(marketId: string, outcome: number, who?: string): Promise<bigint> {
    const target = getAddress(who ?? this.address ?? "0x0000000000000000000000000000000000000000");
    return this.read<bigint>(this.config.contracts.predictEscrow, ESCROW_ABI, "position", [asHex(marketId), outcome, target]);
  }

  // ── Market resolution (read) ─────────────────────────────────────────────────

  async isResolved(marketId: string): Promise<boolean> {
    return this.read<boolean>(this.config.contracts.market, MARKET_ABI, "isResolved", [asHex(marketId)]);
  }

  /** 0=YES, 1=NO, 2=INVALID. */
  async winningOutcome(marketId: string): Promise<number> {
    return Number(await this.read<number>(this.config.contracts.market, MARKET_ABI, "winningOutcome", [asHex(marketId)]));
  }

  /** Permissionlessly settle an oracle market after its close time. */
  resolveFromOracle(marketId: string): Promise<string> {
    return this.send(this.config.contracts.market, MARKET_ABI, "resolveFromOracle", [asHex(marketId)], this.config.gas.tx);
  }
}

export { OUTCOME_YES, OUTCOME_NO };
