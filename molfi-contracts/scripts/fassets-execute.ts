/**
 * FAssets mint, step 3 of 3: prove the XRPL payment to Flare and mint FXRP.
 *
 *   npx hardhat run scripts/fassets-execute.ts --network coston2
 *
 * This is the step that makes FXRP a real claim rather than a faucet token. The
 * XRP is already sitting in the agent's XRPL account (step 2). Flare will not
 * take our word for that — the Flare Data Connector has its attestation
 * providers independently look the transaction up on the XRP Ledger, agree on
 * what they saw, and publish a Merkle root of the round. Only a payment that
 * survives that consensus can be turned into FXRP.
 *
 * So the flow here is: ask a verifier to encode the request → submit it to
 * FdcHub with the round fee → wait for the round to finalize → collect the
 * proof from the Data Availability layer → hand it to the asset manager.
 *
 * Env:
 *   FDC_API_KEY   verifier key (defaults to the public testnet one)
 *   DA_URL        Data Availability layer base URL
 */
import { ethers } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const RES_PATH = `${__dirname}/../deployments/fassets-reservation.json`;
const PAY_PATH = `${__dirname}/../deployments/fassets-payment.json`;
const REQ_PATH = `${__dirname}/../deployments/fassets-attestation.json`;
const OUT = `${__dirname}/../deployments/fassets-mint.json`;

const VERIFIER =
  process.env.FDC_VERIFIER ||
  "https://fdc-verifiers-testnet.flare.network/verifier/xrp/Payment/prepareRequest";
// Flare publishes this key in its own developer docs for the testnet verifier.
const API_KEY = process.env.FDC_API_KEY || "00000000-0000-0000-0000-000000000000";
const DA_URL = process.env.DA_URL || "https://ctn2-data-availability.flare.network";

/** bytes32 of a UTF-8 string, right-zero-padded — how FDC names types. */
const b32 = (s: string) => ethers.zeroPadBytes(ethers.toUtf8Bytes(s), 32);

const REG_ABI = ["function getContractAddressByName(string) view returns (address)"];
const HUB_ABI = ["function requestAttestation(bytes _data) external payable"];
const FEE_ABI = ["function getRequestFee(bytes _data) view returns (uint256)"];
const FSM_ABI = [
  "function firstVotingRoundStartTs() view returns (uint64)",
  "function votingEpochDurationSeconds() view returns (uint64)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const res = JSON.parse(readFileSync(RES_PATH, "utf8"));
  const pay = JSON.parse(readFileSync(PAY_PATH, "utf8"));
  if (pay.collateralReservationId !== res.collateralReservationId) {
    throw new Error(
      `payment is for reservation ${pay.collateralReservationId}, not ${res.collateralReservationId}`,
    );
  }

  const [minter] = await ethers.getSigners();
  const reg = new ethers.Contract(REGISTRY, REG_ABI, minter);
  const [hubAddr, feeAddr, fsmAddr, amAddr] = await Promise.all([
    reg.getContractAddressByName("FdcHub"),
    reg.getContractAddressByName("FdcRequestFeeConfigurations"),
    reg.getContractAddressByName("FlareSystemsManager"),
    reg.getContractAddressByName("AssetManagerFXRP"),
  ]);

  console.log(`\n  FAssets step 3 — proving XRPL payment ${pay.xrplTxHash.slice(0, 18)}…\n`);
  console.log(`  FdcHub           ${hubAddr}`);
  console.log(`  AssetManagerFXRP ${amAddr}`);

  // --- 1. Encode the request ------------------------------------------------
  // The verifier does more than serialize: it looks the transaction up and
  // returns a message integrity code committing to what it found. A request it
  // will not confirm comes back INVALID here rather than failing a round later.
  const prep = await fetch(VERIFIER, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": API_KEY },
    body: JSON.stringify({
      attestationType: b32("Payment"),
      sourceId: b32("testXRP"),
      requestBody: {
        transactionId: `0x${String(pay.xrplTxHash).replace(/^0x/, "")}`,
        inUtxo: "0",
        utxo: "0",
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const prepared = (await prep.json()) as { status?: string; abiEncodedRequest?: string };
  if (!prep.ok || prepared.status !== "VALID" || !prepared.abiEncodedRequest) {
    throw new Error(`verifier: ${prep.status} ${JSON.stringify(prepared).slice(0, 300)}`);
  }
  console.log(`  ✓ verifier says VALID`);

  // --- 2. Submit it to the round -------------------------------------------
  // A previous run may have already got this far. Re-requesting works but costs
  // another round's wait for a proof that already exists, so reuse it.
  let round: number;
  let requestTx: string;
  const cached = existsSync(REQ_PATH) ? JSON.parse(readFileSync(REQ_PATH, "utf8")) : null;
  if (cached?.requestBytes === prepared.abiEncodedRequest) {
    ({ votingRoundId: round, txHash: requestTx } = cached);
    console.log(`  ✓ reusing attestation request from round ${round}`);
  } else {
    const fee = await new ethers.Contract(feeAddr, FEE_ABI, minter).getRequestFee(
      prepared.abiEncodedRequest,
    );
    const hub = new ethers.Contract(hubAddr, HUB_ABI, minter);
    const tx = await hub.requestAttestation(prepared.abiEncodedRequest, { value: fee });
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error(`requestAttestation reverted: ${tx.hash}`);

    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const fsm = new ethers.Contract(fsmAddr, FSM_ABI, minter);
    const [start, duration] = await Promise.all([
      fsm.firstVotingRoundStartTs(),
      fsm.votingEpochDurationSeconds(),
    ]);
    // The round is derived from the timestamp of the block the request landed
    // in, not from "now" — asking for the wrong round 404s forever.
    round = Math.floor((Number(block!.timestamp) - Number(start)) / Number(duration));
    requestTx = tx.hash;
    writeFileSync(
      REQ_PATH,
      `${JSON.stringify(
        { requestBytes: prepared.abiEncodedRequest, votingRoundId: round, txHash: tx.hash },
        null, 2,
      )}\n`,
    );
    console.log(`  ✓ requested · fee ${ethers.formatEther(fee)} C2FLR · round ${round}`);
    console.log(`    ${tx.hash}`);
  }

  // --- 3. Wait for the round, then collect the proof ------------------------
  // Rounds finalize a couple of rounds behind, so the endpoint 404s until the
  // providers have voted. Polling is the documented way to wait.
  const proofUrl = `${DA_URL}/api/v1/fdc/proof-by-request-round-raw`;
  let proof: { response_hex?: string; proof?: string[] } | null = null;
  process.stdout.write("  waiting for the round to finalize");
  for (let i = 0; i < 40; i++) {
    await sleep(15_000);
    process.stdout.write(".");
    const r = await fetch(proofUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": API_KEY },
      body: JSON.stringify({ votingRoundId: round, requestBytes: prepared.abiEncodedRequest }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) continue;
    const body = (await r.json()) as { response_hex?: string; proof?: string[] };
    if (body?.response_hex) {
      proof = body;
      break;
    }
  }
  console.log();
  if (!proof?.response_hex) {
    throw new Error(
      `no proof for round ${round} after 10 minutes.\n` +
        `  The request is on-chain (${requestTx}); retry the proof fetch with:\n` +
        `  curl -X POST ${proofUrl} -H 'content-type: application/json' \\\n` +
        `    -d '{"votingRoundId":${round},"requestBytes":"${prepared.abiEncodedRequest}"}'`,
    );
  }
  console.log(`  ✓ proof obtained · ${proof.proof?.length ?? 0} Merkle node(s)`);

  // --- 4. Mint --------------------------------------------------------------
  // `response_hex` is abi.encode of the attestation Response struct. Every
  // member is static, so it round-trips through the same type string the asset
  // manager declares — decode it and hand it straight back rather than
  // rebuilding it field by field from JSON, which is where a silent
  // field-order mistake would live.
  const RESPONSE =
    "tuple(bytes32 attestationType,bytes32 sourceId,uint64 votingRound,uint64 lowestUsedTimestamp," +
    "tuple(bytes32 transactionId,uint256 inUtxo,uint256 utxo) requestBody," +
    "tuple(uint64 blockNumber,uint64 blockTimestamp,bytes32 sourceAddressHash,bytes32 sourceAddressesRoot," +
    "bytes32 receivingAddressHash,bytes32 intendedReceivingAddressHash,int256 spentAmount," +
    "int256 intendedSpentAmount,int256 receivedAmount,int256 intendedReceivedAmount," +
    "bytes32 standardPaymentReference,bool oneToOne,uint8 status) responseBody)";
  const raw = ethers.AbiCoder.defaultAbiCoder().decode([RESPONSE], proof.response_hex)[0];
  // ethers `Result`s are frozen, and encoding a call argument mutates it in
  // place — passing the decoded value straight back throws "Cannot assign to
  // read only property". Deep-copy to plain arrays first.
  const plain = (v: unknown): unknown => (Array.isArray(v) ? v.map(plain) : v);
  const decoded = plain(raw) as any[];

  // Sanity: the attested payment must be the one this reservation asked for.
  // A mismatch here means we are about to mint against somebody else's payment.
  const attestedRef = raw[5][10];
  if (attestedRef.toLowerCase() !== String(res.paymentReference).toLowerCase()) {
    throw new Error(
      `attested reference ${attestedRef} != reservation reference ${res.paymentReference}`,
    );
  }
  console.log(`  ✓ attested reference matches the reservation`);

  const am = new ethers.Contract(
    amAddr,
    [`function executeMinting(tuple(bytes32[] merkleProof, ${RESPONSE} data) _payment, uint256 _collateralReservationId)`],
    minter,
  );
  const mintTx = await am.executeMinting(
    { merkleProof: proof.proof ?? [], data: decoded },
    res.collateralReservationId,
    { gasLimit: 3_000_000 },
  );
  const mintRc = await mintTx.wait();
  if (mintRc?.status !== 1) throw new Error(`executeMinting reverted: ${mintTx.hash}`);

  const fxrpAddr = await new ethers.Contract(
    amAddr, ["function fAsset() view returns (address)"], minter,
  ).fAsset();
  const balance = await new ethers.Contract(
    fxrpAddr, ["function balanceOf(address) view returns (uint256)"], minter,
  ).balanceOf(minter.address);

  console.log(`\n  ✅ minted · ${mintTx.hash}`);
  console.log(`     FXRP balance ${ethers.formatUnits(balance, 6)}`);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        collateralReservationId: res.collateralReservationId,
        xrplTxHash: pay.xrplTxHash,
        attestationRequestTx: requestTx,
        votingRoundId: round,
        executeMintingTx: mintTx.hash,
        fxrp: fxrpAddr,
        minter: minter.address,
        balance: balance.toString(),
        mintedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  wrote deployments/fassets-mint.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
