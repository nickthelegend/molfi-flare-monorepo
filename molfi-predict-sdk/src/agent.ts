/**
 * MolfiAgent — the one-class API for an autonomous trader on Flare Coston2.
 *
 *   const agent = MolfiAgent.create();          // fresh EVM wallet
 *   await agent.onboard({ funderKey });          // fund C2FLR gas + report FXRP
 *   const markets = await agent.markets();       // live order book / odds
 *   await agent.bet(onChainMarketId, 0, 100);    // escrow 100 FXRP on YES
 *   await agent.redeem(onChainMarketId);         // claim winnings after resolution
 *
 * Data (markets, odds, leaderboard, vaults) comes from the Molfi market engine;
 * money movement (bet, redeem) is real on-chain, signed by the agent's own
 * secp256k1 key via viem. FXRP itself cannot be minted — it is FAssets-wrapped
 * real XRP — so bankroll comes from https://faucet.flare.network/coston2.
 */
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TESTNET, fromBaseUnits, type MolfiConfig } from "./config.js";
import { generateWallet, walletFromSecret, type MolfiWallet } from "./wallet.js";
import { MolfiChain, type Groth16Proof } from "./chain.js";
import {
  fetchMarkets,
  fetchMarket,
  fetchOrderBook,
  fetchPrices,
  fetchLeaderboard,
  fetchVaults,
  fetchOnChainMarkets,
} from "./data.js";

/** Gas amount sent to a fresh agent wallet when `onboard({ funderKey })` is used. */
const GAS_FUNDING_C2FLR = "0.05";

export interface OnboardResult {
  address: string;
  /**
   * True only when `onboard()` was called with `funderKey` and the C2FLR
   * gas-funding transaction was sent and confirmed. If false, this wallet
   * has NOT been given gas by `onboard()` — the caller is responsible for
   * ensuring `address` holds C2FLR before submitting any on-chain write
   * (bet/redeem/etc.), or that write will revert for insufficient gas.
   */
  gasFunded: boolean;
  fxrp: number;
  /**
   * Present only when the wallet holds 0 FXRP: how to fund it.
   *
   * Reported as data rather than thrown. An unfunded bankroll is the expected
   * state of a wallet that was created two lines ago, and throwing there would
   * discard the gas-funding result the caller just paid for.
   */
  note?: string;
}

export class MolfiAgent {
  readonly config: MolfiConfig;
  readonly wallet: MolfiWallet;
  readonly chain: MolfiChain;

  constructor(secret: string, config: MolfiConfig = TESTNET) {
    this.config = config;
    this.wallet = walletFromSecret(secret);
    this.chain = new MolfiChain({ config, privateKey: this.wallet.privateKey });
  }

  /** Spin up an agent with a brand-new wallet. Save `agent.wallet.secret`. */
  static create(config: MolfiConfig = TESTNET): MolfiAgent {
    return new MolfiAgent(generateWallet().secret, config);
  }

  get address(): string {
    return this.wallet.address;
  }

  /**
   * Onboard a fresh agent wallet: optionally fund it with C2FLR gas, then
   * report its FXRP balance.
   *
   * Pass `funderKey` (a funded `0x…` EVM private key) to actually send this
   * wallet gas — WITHOUT it, `onboard()` does NOT fund gas, and this wallet's
   * first on-chain write (bet/redeem/etc.) WILL REVERT unless `address`
   * already holds C2FLR from some other source.
   *
   * FXRP cannot be minted: it is the FAssets representation of real XRP, so no
   * call creates it. A zero balance comes back as `note`, not an exception —
   * fund it at https://faucet.flare.network/coston2.
   */
  async onboard(opts?: { funderKey?: Hex | string }): Promise<OnboardResult> {
    let gasFunded = false;
    if (opts?.funderKey) {
      const key = (opts.funderKey.startsWith("0x") ? opts.funderKey : `0x${opts.funderKey}`) as Hex;
      const funder = privateKeyToAccount(key);
      const funderClient = createWalletClient({
        account: funder,
        chain: this.chain.chain,
        transport: http(this.config.rpcUrl),
      });
      const hash = await funderClient.sendTransaction({
        to: this.address as Hex,
        value: parseEther(GAS_FUNDING_C2FLR),
      });
      await this.chain.pub.waitForTransactionReceipt({ hash });
      gasFunded = true;
    }
    const fxrp = await this.fxrp();
    return {
      address: this.address,
      gasFunded,
      fxrp,
      ...(fxrp === 0
        ? {
            note:
              `0 FXRP — this wallet cannot bet yet. FXRP is FAssets-wrapped real ` +
              `XRP and has no mint(); fund ${this.address} at ` +
              `https://faucet.flare.network/coston2, then re-check with agent.fxrp().`,
          }
        : {}),
    };
  }

  // ── Market data ──────────────────────────────────────────────────────────
  markets(status: "open" | "closed" = "open") {
    return fetchMarkets(this.config, status);
  }
  market(id: string) {
    return fetchMarket(id, this.config);
  }
  orderBook(id: string) {
    return fetchOrderBook(id, this.config);
  }
  prices(symbol: string, limit = 120) {
    return fetchPrices(symbol, limit, this.config);
  }
  leaderboard() {
    return fetchLeaderboard(this.config);
  }
  vaults() {
    return fetchVaults(this.config);
  }
  /** On-chain market ids (32-byte hex) the agent can actually bet on. */
  onChainMarkets() {
    return fetchOnChainMarkets(this.config);
  }

  // ── Trading (real on-chain FXRP) ─────────────────────────────────────────
  /** FXRP balance as a human number. */
  async fxrp(): Promise<number> {
    return fromBaseUnits(await this.chain.fxrpBalance(), this.config.decimals);
  }
  /** Escrow `amount` FXRP on an outcome (0=YES, 1=NO) of an on-chain market. */
  bet(marketId: string, outcome: number, amount: number) {
    return this.chain.bet(marketId, outcome, amount);
  }
  /** Privacy bet gated by a Groth16 proof verified on-chain (BN254). */
  betZk(
    marketId: string,
    outcome: number,
    amount: number,
    proof: Groth16Proof,
    publicInputs: (string | bigint)[],
  ) {
    return this.chain.betZk(marketId, outcome, amount, proof, publicInputs);
  }
  /** Claim winnings after the market resolves. */
  redeem(marketId: string) {
    return this.chain.redeem(marketId);
  }
  winningOutcome(marketId: string) {
    return this.chain.winningOutcome(marketId);
  }
  isResolved(marketId: string) {
    return this.chain.isResolved(marketId);
  }
}
