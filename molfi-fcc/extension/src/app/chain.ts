/**
 * Reading the sealed book from Coston2.
 *
 * The extension reads the chain directly rather than trusting anything in the
 * request. A caller supplies only a market id; the bids, their amounts and their
 * bidders all come from `SealedBidBook`. That matters because the bidder address
 * is authenticated data in every ciphertext — accepting a caller-supplied bidder
 * would let someone re-point a sealed bid at a different account.
 */
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { MolfiConfig } from "./config.js";
import type { SealedBid } from "./open-book.js";

/** Canonical Multicall3, deployed at the same address on Coston2. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const BOOK_ABI = [
  {
    type: "function", name: "bidCount", stateMutability: "view",
    inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "getBid", stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "uint256" }],
    outputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
  },
  {
    type: "function", name: "books", stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "totalEscrowed", type: "uint256" },
      { name: "bidCount", type: "uint32" },
      { name: "opened", type: "bool" },
      { name: "yesPool", type: "uint256" },
      { name: "noPool", type: "uint256" },
      { name: "openingsRoot", type: "bytes32" },
    ],
  },
  {
    type: "function", name: "teeSigner", stateMutability: "view",
    inputs: [], outputs: [{ type: "address" }],
  },
] as const;

export interface BookSummary {
  totalEscrowed: bigint;
  bidCount: number;
  opened: boolean;
}

export class BookReader {
  readonly book: Address;
  readonly chainId: number;
  private readonly chainUrl: string;
  private cached: Promise<PublicClient> | null = null;

  constructor(cfg: MolfiConfig) {
    if (!cfg.book) throw new Error("SEALED_BID_BOOK is not configured");
    this.book = getAddress(cfg.book);
    this.chainId = cfg.chainId;
    this.chainUrl = cfg.chainUrl;
  }

  private chain(multicall: boolean) {
    return defineChain({
      id: this.chainId,
      name: `chain-${this.chainId}`,
      nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
      rpcUrls: { default: { http: [this.chainUrl] } },
      ...(multicall ? { contracts: { multicall3: { address: MULTICALL3 } } } : {}),
      testnet: true,
    });
  }

  /**
   * One client, built once, batching only if the chain can.
   *
   * Bid reads are one call per bid, so a 50-bid book is 50 round trips from
   * inside the container without batching. Multicall3 sits at the same address
   * on Flare and most EVM chains — but not on a bare local devnet, where
   * assuming it turns every read into a call to an empty address. Probing once
   * costs a single `eth_getCode` and makes the extension correct on any chain
   * rather than only the one it was written against.
   */
  private client(): Promise<PublicClient> {
    if (this.cached) return this.cached;
    this.cached = (async () => {
      const probe = createPublicClient({
        chain: this.chain(false),
        transport: http(this.chainUrl),
      });
      let hasMulticall = false;
      try {
        const code = await probe.getCode({ address: MULTICALL3 });
        hasMulticall = !!code && code !== "0x";
      } catch {
        // A node that will not answer getCode will not answer aggregate3
        // either; stay unbatched rather than fail closed on a read path.
      }
      if (!hasMulticall) return probe as PublicClient;
      return createPublicClient({
        chain: this.chain(true),
        transport: http(this.chainUrl),
        batch: { multicall: { batchSize: 4096, wait: 16 } },
      }) as PublicClient;
    })();
    return this.cached;
  }

  async summary(marketId: Hex): Promise<BookSummary> {
    const client = await this.client();
    const [totalEscrowed, bidCount, opened] = (await client.readContract({
      address: this.book,
      abi: BOOK_ABI,
      functionName: "books",
      args: [marketId],
    })) as readonly [bigint, number, boolean, bigint, bigint, Hex];
    return { totalEscrowed, bidCount, opened };
  }

  /** The address the contract will accept an opening signature from. */
  async teeSigner(): Promise<Address> {
    const client = await this.client();
    return (await client.readContract({
      address: this.book,
      abi: BOOK_ABI,
      functionName: "teeSigner",
    })) as Address;
  }

  /** Every sealed bid, in index order — the order the Merkle leaves use. */
  async bids(marketId: Hex): Promise<SealedBid[]> {
    const client = await this.client();
    const n = (await client.readContract({
      address: this.book,
      abi: BOOK_ABI,
      functionName: "bidCount",
      args: [marketId],
    })) as bigint;

    const reads = Array.from({ length: Number(n) }, (_, i) =>
      client.readContract({
        address: this.book,
        abi: BOOK_ABI,
        functionName: "getBid",
        args: [marketId, BigInt(i)],
      }) as Promise<readonly [Address, bigint, Hex]>,
    );
    const rows = await Promise.all(reads);
    return rows.map(([bidder, amount, ciphertext]) => ({ bidder, amount, ciphertext }));
  }
}
