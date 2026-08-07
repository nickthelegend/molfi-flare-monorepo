/**
 * Molfi's Flare Compute Extension — the HTTP surface FCC calls.
 *
 * Shape follows the FCE scaffold: `GET /state` for health/identity and
 * `POST /action` routed on an (opType, opCommand) pair. Flare's data providers
 * relay signed instructions here; the extension does the confidential work and
 * returns an ABI-encoded, signed result the chain can verify.
 *
 *   MOLFI / SEAL_KEY   → publish the enclave's public key so clients can seal to it
 *   MOLFI / OPEN_BOOK  → decrypt a closed market's bids, total the pools, sign
 *
 * The private half of the enclave keypair exists only in this process. In
 * production that process is a confidential VM; with SIMULATED_TEE it is a local
 * container, which is a development posture, not a security claim.
 */
import { createServer } from "node:http";
import { createPublicClient, defineChain, http as viemHttp, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { enclaveKeypair } from "./seal.mjs";
import { openBook, openDigest } from "./open-book.mjs";

const PORT = Number(process.env.PORT || 6674);
const RPC = process.env.CHAIN_URL || "https://coston2-api.flare.network/ext/C/rpc";
const CHAIN_ID = Number(process.env.CHAIN_ID || 114);
const BOOK = process.env.SEALED_BID_BOOK;

export const OP_TYPE = "MOLFI";
export const OP_SEAL_KEY = "SEAL_KEY";
export const OP_OPEN_BOOK = "OPEN_BOOK";

// A fixed key across restarts is required, not a nicety: bids already sealed to
// the previous key become permanently unopenable if this rotates mid-market.
const enclave = enclaveKeypair(process.env.ENCLAVE_PRIVATE_KEY);
// Separate key for SIGNING openings — the contract knows this address as
// `teeSigner`. Kept distinct from the sealing key so one can rotate without
// stranding sealed bids.
const signer = privateKeyToAccount(
  process.env.TEE_SIGNER_KEY || `0x${"11".repeat(32)}`,
);

const coston2 = defineChain({
  id: CHAIN_ID,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  testnet: true,
});
const pub = createPublicClient({ chain: coston2, transport: viemHttp(RPC) });

const BOOK_ABI = [
  { type: "function", name: "bidCount", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getBid", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] },
  { type: "function", name: "books", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
    { name: "totalEscrowed", type: "uint256" }, { name: "bidCount", type: "uint32" }, { name: "opened", type: "bool" },
    { name: "yesPool", type: "uint256" }, { name: "noPool", type: "uint256" }, { name: "openingsRoot", type: "bytes32" }] },
  { type: "function", name: "teeSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

/** Read the whole sealed book straight from chain. */
async function readBook(marketId) {
  if (!BOOK) throw new Error("SEALED_BID_BOOK not configured");
  const book = getAddress(BOOK);
  const n = await pub.readContract({ address: book, abi: BOOK_ABI, functionName: "bidCount", args: [marketId] });
  const bids = [];
  for (let i = 0n; i < n; i++) {
    const [bidder, amount, ciphertext] = await pub.readContract({
      address: book, abi: BOOK_ABI, functionName: "getBid", args: [marketId, i],
    });
    bids.push({ bidder, amount, ciphertext });
  }
  return bids;
}

/** The confidential computation. Everything secret lives and dies in here. */
export async function handleOpenBook({ marketId }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(marketId))) {
    throw new Error("marketId must be a 32-byte hex id");
  }
  const bids = await readBook(marketId);
  if (bids.length === 0) throw new Error("no sealed bids for this market");

  // Refuse to produce a signature the contract will not accept. The enclave's
  // signing key is generated in here, so a rebuild or an unpinned restart moves
  // it while the contract still trusts the old address — and nothing looks wrong
  // until close, when openMarket reverts with BadSignature and every stake in
  // the book is stuck. Catching it here costs one eth_call.
  const expected = await pub.readContract({
    address: getAddress(BOOK), abi: BOOK_ABI, functionName: "teeSigner",
  });
  if (expected.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `tee signer mismatch: the book accepts ${expected} but this enclave signs ` +
        `as ${signer.address} — run molfi-contracts/scripts/set-tee-signer.ts`,
    );
  }

  const result = openBook(enclave.privateKey, marketId, bids);
  const digest = openDigest({
    chainId: CHAIN_ID,
    book: getAddress(BOOK),
    marketId,
    yesPool: result.yesPool,
    noPool: result.noPool,
    bidCount: result.bidCount,
    openingsRoot: result.openingsRoot,
  });
  // Sign the digest itself — openDigest already applied the EIP-191 prefix, so
  // signMessage would prefix it twice and the contract would recover garbage.
  const signature = await signer.sign({ hash: digest });

  return {
    marketId,
    yesPool: result.yesPool.toString(),
    noPool: result.noPool.toString(),
    bidCount: result.bidCount,
    openingsRoot: result.openingsRoot,
    signature,
    teeSigner: signer.address,
    // Openings are published so bettors can build claim proofs. Safe now and
    // only now: the market is closed, so nothing here can be front-run.
    openings: result.openings.map((o) => ({
      index: o.index,
      side: o.side,
      amount: o.amount.toString(),
      bidder: o.bidder,
      malformed: o.malformed,
      proof: result.proofFor(o.index),
    })),
  };
}

/** Route an (opType, opCommand) pair, the way the FCE scaffold does. */
export async function dispatch(opType, opCommand, payload = {}) {
  if (opType !== OP_TYPE) {
    const e = new Error(`unsupported opType ${opType}`);
    e.status = 501;
    throw e;
  }
  switch (opCommand) {
    case OP_SEAL_KEY:
      // Public by design — clients need it to seal, and it reveals nothing.
      return { publicKey: enclave.publicKey, teeSigner: signer.address, chainId: CHAIN_ID };
    case OP_OPEN_BOOK:
      return handleOpenBook(payload);
    default: {
      const e = new Error(`unsupported opCommand ${opCommand}`);
      e.status = 501;
      throw e;
    }
  }
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

export function createExtensionServer() {
  return createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      });
      return res.end();
    }
    if (req.method === "GET" && req.url?.startsWith("/state")) {
      return json(res, 200, {
        ok: true,
        extension: "molfi-sealed-book",
        opType: OP_TYPE,
        commands: [OP_SEAL_KEY, OP_OPEN_BOOK],
        enclavePublicKey: enclave.publicKey,
        teeSigner: signer.address,
        book: BOOK ?? null,
        chainId: CHAIN_ID,
        simulated: process.env.SIMULATED_TEE === "true",
      });
    }
    if (req.method === "POST" && req.url?.startsWith("/action")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let p;
        try { p = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "bad JSON" }); }
        try {
          const out = await dispatch(p.opType, p.opCommand, p.payload ?? p);
          json(res, 200, { ok: true, result: out });
        } catch (e) {
          json(res, e.status ?? 400, { ok: false, error: e.message });
        }
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });
}

const isDirect = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isDirect) {
  createExtensionServer().listen(PORT, () => {
    console.log(`[molfi-fcc] extension on :${PORT}`);
    console.log(`[molfi-fcc] enclave pubkey ${enclave.publicKey}`);
    console.log(`[molfi-fcc] tee signer     ${signer.address}`);
    console.log(`[molfi-fcc] book           ${BOOK ?? "(unset)"}`);
    if (process.env.SIMULATED_TEE === "true") {
      console.log("[molfi-fcc] SIMULATED_TEE=true — confidentiality is a dev assumption");
    }
  });
}
