/**
 * FAssets mint, step 2 of 3: pay the reserved XRP on the XRP Ledger testnet.
 *
 *   node scripts/fassets-pay-xrpl.mjs
 *
 * Reads the reservation from step 1 and sends the agent exactly the amount it
 * asked for, carrying the payment reference as a memo. That reference is what
 * ties this XRPL transaction to the reservation on Flare — without it the agent
 * cannot be made to mint, and the collateral fee is simply forfeit.
 *
 * XRP comes from the XRPL testnet faucet, which is separate from Coston2's and
 * not rate-limited the same way. Set XRPL_SEED to reuse a funded account across
 * runs; otherwise a fresh one is created and funded automatically.
 */
import { Client, Wallet } from "xrpl";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RES_PATH = `${HERE}../deployments/fassets-reservation.json`;
const OUT = `${HERE}../deployments/fassets-payment.json`;
/** Public testnet nodes routinely answer `notSynced`; try more than one. */
const XRPL_ENDPOINTS = process.env.XRPL_WS
  ? [process.env.XRPL_WS]
  : ["wss://s.altnet.rippletest.net:51233", "wss://testnet.xrpl-labs.com"];

const res = JSON.parse(readFileSync(RES_PATH, "utf8"));
console.log(`\n  FAssets step 2 — paying ${res.totalXRP} XRP on the XRPL testnet\n`);
console.log(`  reservation ${res.collateralReservationId}`);
console.log(`  to          ${res.paymentAddress}`);
console.log(`  reference   ${res.paymentReference}`);

/** Connect to whichever endpoint is actually synced right now. */
async function connectSynced() {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of XRPL_ENDPOINTS) {
      const c = new Client(url, { timeout: 30_000 });
      try {
        await c.connect();
        // A node can accept the socket and still be behind; prove it can serve
        // a validated ledger before trusting it with a payment.
        await c.request({ command: "ledger", ledger_index: "validated" });
        console.log(`  xrpl node ${url}`);
        return c;
      } catch (e) {
        lastErr = e;
        await c.disconnect().catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`no synced XRPL testnet node: ${lastErr?.message ?? lastErr}`);
}

const client = await connectSynced();

try {
  let wallet;
  if (process.env.XRPL_SEED) {
    wallet = Wallet.fromSeed(process.env.XRPL_SEED);
    console.log(`\n  using account ${wallet.address}`);
  } else {
    // The library's fundWallet gives up after 20s and the testnet faucet is
    // routinely slower than that, so call it directly and wait properly.
    // Note the seed comes back at the TOP level, not inside `account`.
    console.log(`\n  funding a fresh testnet account…`);
    const r = await fetch("https://faucet.altnet.rippletest.net/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) throw new Error(`XRPL faucet ${r.status}`);
    const funded = await r.json();
    if (!funded.seed) throw new Error(`faucet returned no seed: ${JSON.stringify(funded).slice(0, 200)}`);
    wallet = Wallet.fromSeed(funded.seed);
    console.log(`  account ${wallet.address} · ${funded.amount} XRP`);
    console.log(`  SEED (save as XRPL_SEED to reuse): ${funded.seed}`);
    // The faucet payment needs a ledger to close before the account is usable.
    await new Promise((res) => setTimeout(res, 5000));
  }

  const bal = await client.getXrpBalance(wallet.address);
  const need = Number(res.totalXRP);
  console.log(`  balance ${bal} XRP, need ${need}`);
  if (Number(bal) < need + 1) {
    throw new Error(`not enough XRP: have ${bal}, need ~${need + 1} (incl. reserve + fee)`);
  }

  // The payment reference goes in a memo. FAssets looks for it there when the
  // FDC attestation is verified, and a payment without it cannot be matched to
  // this reservation.
  const prepared = await client.autofill({
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: res.paymentAddress,
    // Drops, as an integer string — this must equal totalUBA exactly. Underpay
    // and the agent can reject; overpay and the excess is not credited.
    Amount: String(res.totalUBA),
    Memos: [
      {
        Memo: {
          MemoData: res.paymentReference.replace(/^0x/, "").toUpperCase(),
        },
      },
    ],
  });

  const signed = wallet.sign(prepared);
  console.log(`\n  submitting ${signed.hash}…`);
  const result = await client.submitAndWait(signed.tx_blob);
  const code = result.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`XRPL rejected the payment: ${code}`);

  const payment = {
    collateralReservationId: res.collateralReservationId,
    xrplTxHash: signed.hash,
    xrplAccount: wallet.address,
    destination: res.paymentAddress,
    amountDrops: String(res.totalUBA),
    paymentReference: res.paymentReference,
    ledgerIndex: result.result.ledger_index,
    paidAt: new Date().toISOString(),
  };
  writeFileSync(OUT, `${JSON.stringify(payment, null, 2)}\n`);

  console.log(`\n  ✅ paid · ledger ${payment.ledgerIndex}`);
  console.log(`     https://testnet.xrpl.org/transactions/${signed.hash}`);
  console.log(`\n  wrote deployments/fassets-payment.json`);
  console.log(`  next: npx hardhat run scripts/fassets-execute.ts --network coston2`);
} finally {
  await client.disconnect();
}
