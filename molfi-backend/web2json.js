/**
 * Web2Json feeds — settlement values from public JSON APIs, proved by the FDC.
 *
 * Ported from _references/flare-prediction-market, which used this to settle
 * weather markets. The capability is what matters, not the weather: FTSO carries
 * a few dozen crypto pairs, and until now any market outside that set could only
 * be resolved by an admin typing in the answer.
 *
 * The pipeline is four steps and none of them trust this process:
 *
 *   1. prepare  — a Flare verifier fetches the URL itself and returns an encoded
 *                 request committing to what it saw
 *   2. submit   — that request goes on-chain to FdcHub with the round fee
 *   3. wait     — the attestation providers independently fetch the same URL,
 *                 apply the same jq transform, and vote; the round's Merkle root
 *                 is published
 *   4. post     — anyone relays the proof to Web2JsonOracle, which re-verifies
 *                 the Merkle proof AND that the request matches what the feed
 *                 was registered against
 *
 * This module is the relayer for steps 1-4. It has no privileged position: a
 * stranger running the same code produces the same on-chain result, and if this
 * process lies at any step the contract rejects it.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  decodeAbiParameters,
  getAddress,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.MOLFI_RPC || "https://coston2-api.flare.network/ext/C/rpc";
const CHAIN_ID = Number(process.env.MOLFI_CHAIN_ID || 114);
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

/** Flare publishes this key in its own developer docs for the testnet verifier. */
const VERIFIER_BASE =
  process.env.FDC_VERIFIER_BASE || "https://fdc-verifiers-testnet.flare.network";
const FDC_API_KEY = process.env.FDC_API_KEY || "00000000-0000-0000-0000-000000000000";
const DA_URL = process.env.DA_URL || "https://ctn2-data-availability.flare.network";

/** bytes32 of a UTF-8 string, right-zero-padded — how FDC names types. */
const b32 = (s) => `0x${Buffer.from(s, "utf8").toString("hex").padEnd(64, "0")}`;
const ATTESTATION_TYPE = b32("Web2Json");
const SOURCE_ID = b32("PublicWeb2");

const chain = defineChain({
  id: CHAIN_ID,
  name: "Flare Testnet Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  testnet: true,
});
const pub = createPublicClient({ chain, transport: http(RPC) });

/**
 * The relaying key.
 *
 * Optional: without it the read paths still work and `attest()` reports that it
 * cannot broadcast, rather than pretending. Nothing here is privileged — the
 * contract accepts a proof from any address — so this is a convenience relayer,
 * not an authority.
 */
const KEEPER_KEY = process.env.MOLFI_KEEPER_KEY || "";
export const keeper = KEEPER_KEY ? privateKeyToAccount(KEEPER_KEY) : null;
const wallet = keeper
  ? createWalletClient({ account: keeper, chain, transport: http(RPC) })
  : null;

// --- ABI shapes -------------------------------------------------------------

/** IWeb2Json.RequestBody — the tuple Web2JsonOracle hashes to bind a feed. */
const REQUEST_BODY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "url", type: "string" },
      { name: "httpMethod", type: "string" },
      { name: "headers", type: "string" },
      { name: "queryParams", type: "string" },
      { name: "body", type: "string" },
      { name: "postProcessJq", type: "string" },
      { name: "abiSignature", type: "string" },
    ],
  },
];

/** IWeb2Json.Response, as the DA Layer's `response_hex` encodes it. */
const RESPONSE_ABI = [
  {
    type: "tuple",
    components: [
      { name: "attestationType", type: "bytes32" },
      { name: "sourceId", type: "bytes32" },
      { name: "votingRound", type: "uint64" },
      { name: "lowestUsedTimestamp", type: "uint64" },
      // Named: without it the decoded response carries the request body under no
      // key at all, and re-encoding it to check the binding silently reads
      // `undefined`.
      { name: "requestBody", ...REQUEST_BODY_ABI[0] },
      {
        name: "responseBody",
        type: "tuple",
        components: [{ name: "abiEncodedData", type: "bytes" }],
      },
    ],
  },
];

export const ORACLE_ABI = [
  {
    type: "function", name: "registerFeed", stateMutability: "nonpayable",
    inputs: [
      { name: "feedId", type: "bytes21" }, { name: "requestHash", type: "bytes32" },
      { name: "label", type: "string" }, { name: "valueDecimals", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "submitAttestation", stateMutability: "nonpayable",
    inputs: [
      { name: "feedId", type: "bytes21" },
      {
        name: "proof", type: "tuple",
        components: [{ name: "merkleProof", type: "bytes32[]" }, { name: "data", ...RESPONSE_ABI[0] }],
      },
    ],
    outputs: [],
  },
  {
    type: "function", name: "feedOf", stateMutability: "view",
    inputs: [{ type: "bytes21" }],
    outputs: [
      { name: "requestHash", type: "bytes32" }, { name: "label", type: "string" },
      { name: "valueDecimals", type: "uint8" }, { name: "exists", type: "bool" },
    ],
  },
  {
    type: "function", name: "latestObservation", stateMutability: "view",
    inputs: [{ type: "bytes21" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "value", type: "uint256" }, { name: "observedAt", type: "uint64" },
        { name: "votingRound", type: "uint64" }, { name: "exists", type: "bool" },
      ],
    }],
  },
  {
    type: "function", name: "requestHashOf", stateMutability: "pure",
    inputs: [{ name: "requestBody", ...REQUEST_BODY_ABI[0] }],
    outputs: [{ type: "bytes32" }],
  },
  { type: "function", name: "feedCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feedIds", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes21" }] },
];

// --- Feed catalogue ---------------------------------------------------------

/**
 * The feeds this deployment knows how to attest.
 *
 * `feedId` uses category byte 0x02 so a Web2 feed can never be confused with an
 * FTSO id (0x01). Everything else is the literal attestation request — change a
 * character of the jq and it is a different feed, by construction, because the
 * contract binds to the hash of all of it.
 *
 * A keyless API is a deliberate choice. The reference put an OpenWeatherMap API
 * key in `queryParams`, which means the key is part of the hash the feed is
 * bound to: rotating it silently orphans every market settling on that feed, and
 * the key itself ends up in on-chain calldata.
 */
export const FEEDS = [
  {
    feedId: `0x02${Buffer.from("EURUSD", "utf8").toString("hex")}${"00".repeat(14)}`,
    label: "EUR/USD (ECB reference rate, via FDC Web2Json)",
    valueDecimals: 6,
    request: {
      url: "https://api.frankfurter.dev/v1/latest",
      httpMethod: "GET",
      headers: "{}",
      queryParams: '{"base":"USD","symbols":"EUR"}',
      body: "{}",
      // Scale to an integer WITHOUT `round` or `floor`. Flare's verifier
      // rejects both outright — `INVALID JQ FILTER`, with no hint which token
      // it disliked. The half-add-then-truncate-the-string idiom below is what
      // it accepts, and it is the reason the reference project wrote its weather
      // filter this way; that looked like a stylistic quirk until the verifier
      // turned down the obvious version three times.
      //
      // Truncating rather than rounding also matters for consensus: every
      // attestation provider must land on the identical integer, and string
      // truncation has no float-boundary disagreement.
      postProcessJq:
        '{value: ((if (.rates.EUR*1000000) >= 0 then (.rates.EUR*1000000 + 0.5) else (.rates.EUR*1000000 - 0.5) end) | tostring | split(".")[0] | tonumber)}',
      abiSignature:
        '{"components":[{"internalType":"int256","name":"value","type":"int256"}],"name":"dto","type":"tuple"}',
    },
  },
];

export const feedById = (id) =>
  FEEDS.find((f) => f.feedId.toLowerCase() === String(id).toLowerCase()) ?? null;

const asTuple = (r) => ({
  url: r.url, httpMethod: r.httpMethod, headers: r.headers, queryParams: r.queryParams,
  body: r.body, postProcessJq: r.postProcessJq, abiSignature: r.abiSignature,
});

/**
 * The binding hash, computed exactly as Web2JsonOracle does.
 *
 * `requestHashOf` on the contract is the authority; this is the local mirror so
 * registration does not need a round trip. `verifyFeedBindings` below proves
 * they agree against the deployed contract rather than assuming it.
 */
export function requestHash(request) {
  return keccak256(encodeAbiParameters(REQUEST_BODY_ABI, [asTuple(request)]));
}

// --- The pipeline -----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Step 1: ask a Flare verifier to encode (and confirm) the request. */
export async function prepareRequest(request) {
  const url = `${VERIFIER_BASE.replace(/\/$/, "")}/verifier/web2/Web2Json/prepareRequest`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": FDC_API_KEY },
    body: JSON.stringify({
      attestationType: ATTESTATION_TYPE,
      sourceId: SOURCE_ID,
      requestBody: asTuple(request),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status !== "VALID" || !json.abiEncodedRequest) {
    throw new Error(
      `verifier ${res.status}: ${json.status ?? JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return json.abiEncodedRequest;
}

async function registryAddress(name) {
  return pub.readContract({
    address: getAddress(REGISTRY),
    abi: [{
      type: "function", name: "getContractAddressByName", stateMutability: "view",
      inputs: [{ type: "string" }], outputs: [{ type: "address" }],
    }],
    functionName: "getContractAddressByName",
    args: [name],
  });
}

/** Step 2: put the request on-chain with the round fee, and work out its round. */
export async function submitRequest(abiEncodedRequest) {
  if (!wallet) throw new Error("MOLFI_KEEPER_KEY not configured — cannot broadcast");
  const [hub, feeCfg, fsm] = await Promise.all([
    registryAddress("FdcHub"),
    registryAddress("FdcRequestFeeConfigurations"),
    registryAddress("FlareSystemsManager"),
  ]);

  const fee = await pub.readContract({
    address: feeCfg,
    abi: [{ type: "function", name: "getRequestFee", stateMutability: "view", inputs: [{ type: "bytes" }], outputs: [{ type: "uint256" }] }],
    functionName: "getRequestFee",
    args: [abiEncodedRequest],
  });

  const hash = await wallet.writeContract({
    address: hub,
    abi: [{ type: "function", name: "requestAttestation", stateMutability: "payable", inputs: [{ type: "bytes" }], outputs: [] }],
    functionName: "requestAttestation",
    args: [abiEncodedRequest],
    value: fee,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`requestAttestation reverted: ${hash}`);

  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  const fsmAbi = [
    { type: "function", name: "firstVotingRoundStartTs", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
    { type: "function", name: "votingEpochDurationSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  ];
  const [start, duration] = await Promise.all([
    pub.readContract({ address: fsm, abi: fsmAbi, functionName: "firstVotingRoundStartTs" }),
    pub.readContract({ address: fsm, abi: fsmAbi, functionName: "votingEpochDurationSeconds" }),
  ]);
  // Derived from the block the request landed in, not from "now" — the DA Layer
  // 404s forever on the wrong round.
  const votingRound = Number((block.timestamp - start) / duration);
  return { txHash: hash, votingRound, fee: fee.toString() };
}

/** Step 3: wait for the round, then pull the Merkle proof. */
export async function fetchProof(votingRound, abiEncodedRequest, { attempts = 40, intervalMs = 15_000 } = {}) {
  const url = `${DA_URL.replace(/\/$/, "")}/api/v1/fdc/proof-by-request-round-raw`;
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": FDC_API_KEY },
      body: JSON.stringify({ votingRoundId: votingRound, requestBytes: abiEncodedRequest }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!res?.ok) continue;
    const body = await res.json().catch(() => ({}));
    if (!body?.response_hex) continue;

    const [data] = decodeAbiParameters(RESPONSE_ABI, body.response_hex);
    return { merkleProof: body.proof ?? [], data };
  }
  throw new Error(`no FDC proof for round ${votingRound} after ${attempts} attempts`);
}

/** Step 4: relay it to the oracle. Permissionless — anyone can do this. */
export async function postToOracle(oracleAddress, feedId, proof) {
  if (!wallet) throw new Error("MOLFI_KEEPER_KEY not configured — cannot broadcast");
  const hash = await wallet.writeContract({
    address: getAddress(oracleAddress),
    abi: ORACLE_ABI,
    functionName: "submitAttestation",
    args: [feedId, proof],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`submitAttestation reverted: ${hash}`);
  return hash;
}

/** The whole thing, for one feed. Returns what landed on-chain. */
export async function attest(oracleAddress, feed, { onStep } = {}) {
  const step = (s, detail) => onStep?.(s, detail);

  step("prepare");
  const abiEncodedRequest = await prepareRequest(feed.request);

  step("submit");
  const { txHash: requestTx, votingRound, fee } = await submitRequest(abiEncodedRequest);

  step("wait", { votingRound });
  const proof = await fetchProof(votingRound, abiEncodedRequest);

  // Refuse to spend gas on a proof that answers a different question than the
  // feed is bound to — the contract would revert, but the error is clearer here.
  const bound = requestHash(feed.request);
  const got = keccak256(encodeAbiParameters(REQUEST_BODY_ABI, [proof.data.requestBody]));
  if (bound.toLowerCase() !== got.toLowerCase()) {
    throw new Error(`proof request mismatch: feed binds ${bound}, proof carries ${got}`);
  }

  step("post");
  const submitTx = await postToOracle(oracleAddress, feed.feedId, proof);

  const [value] = decodeAbiParameters(
    [{ type: "tuple", components: [{ name: "value", type: "int256" }] }],
    proof.data.responseBody.abiEncodedData,
  );
  return {
    feedId: feed.feedId,
    label: feed.label,
    rawValue: value.value.toString(),
    valueDecimals: feed.valueDecimals,
    votingRound,
    lowestUsedTimestamp: Number(proof.data.lowestUsedTimestamp),
    requestTx,
    submitTx,
    fee,
    attestedAt: Date.now(),
  };
}

// --- Reads ------------------------------------------------------------------

export async function readFeed(oracleAddress, feedId) {
  const address = getAddress(oracleAddress);
  const [meta, obs] = await Promise.all([
    pub.readContract({ address, abi: ORACLE_ABI, functionName: "feedOf", args: [feedId] }),
    pub.readContract({ address, abi: ORACLE_ABI, functionName: "latestObservation", args: [feedId] }),
  ]);
  const [requestHashOnChain, label, valueDecimals, exists] = meta;
  return {
    feedId,
    registered: exists,
    requestHash: requestHashOnChain,
    label,
    valueDecimals: Number(valueDecimals),
    observation: obs.exists
      ? {
          value18: obs.value.toString(),
          value: Number(obs.value) / 1e18,
          observedAt: Number(obs.observedAt),
          votingRound: Number(obs.votingRound),
        }
      : null,
  };
}

/**
 * Prove the local binding matches the deployed contract's, for every feed.
 *
 * A silent divergence here is the worst failure mode this module has: the feed
 * registers against a hash no real proof can ever match, and nothing complains
 * until a market cannot be settled. Cheap to check, so it is checked at startup.
 */
export async function verifyFeedBindings(oracleAddress) {
  const address = getAddress(oracleAddress);
  const out = [];
  for (const feed of FEEDS) {
    const onChain = await pub.readContract({
      address, abi: ORACLE_ABI, functionName: "requestHashOf", args: [asTuple(feed.request)],
    });
    const local = requestHash(feed.request);
    out.push({ feedId: feed.feedId, agrees: onChain.toLowerCase() === local.toLowerCase(), local, onChain });
  }
  return out;
}

export const publicClient = pub;
