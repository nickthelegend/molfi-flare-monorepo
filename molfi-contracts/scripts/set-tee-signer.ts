/**
 * Point SealedBidBook at whichever key the enclave is ACTUALLY signing with.
 *
 *   npx hardhat run scripts/set-tee-signer.ts --network coston2
 *   TEE_SIGNER=0x… npx hardhat run scripts/set-tee-signer.ts --network coston2
 *
 * WHY THIS EXISTS. The enclave's signing key is generated inside the extension.
 * Rebuild the image, regenerate the env, restart without a pinned key — and the
 * enclave comes back with a new address while the contract still trusts the old
 * one. Nothing complains: sealing keeps working, bids keep landing, and the
 * failure only surfaces at close, when `openMarket` reverts with BadSignature
 * and every stake in the book is frozen behind an opening that cannot be
 * accepted. That is the worst possible moment to discover it.
 *
 * So this reads the live enclave's identity rather than taking an address on
 * faith, and refuses to rotate to a key nothing is running.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";

const DEPLOYMENTS = `${__dirname}/../deployments/coston2.json`;
const FCC_URL = process.env.MOLFI_FCC_URL || "http://localhost:6675";

const BOOK_ABI = [
  "function teeSigner() view returns (address)",
  "function admin() view returns (address)",
  "function setTeeSigner(address next) external",
];

/** Ask the running extension who it is. Never guess this. */
async function liveSigner(): Promise<string> {
  const res = await fetch(`${FCC_URL}/state`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${FCC_URL}/state → ${res.status}`);
  const body = (await res.json()) as { teeSigner?: string; state?: { teeSigner?: string } };
  // The standalone enclave answers flat; the FCC image wraps state per the
  // extension contract (§4.5). Accept either shape.
  const signer = body.teeSigner ?? body.state?.teeSigner;
  if (!signer) throw new Error(`no teeSigner in ${FCC_URL}/state`);
  return ethers.getAddress(signer);
}

async function main() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const [admin] = await ethers.getSigners();
  const book = new ethers.Contract(d.contracts.sealedBidBook, BOOK_ABI, admin);

  const next = process.env.TEE_SIGNER
    ? ethers.getAddress(process.env.TEE_SIGNER)
    : await liveSigner();
  const current = await book.teeSigner();
  const onChainAdmin = await book.admin();

  console.log(`  book       ${d.contracts.sealedBidBook}`);
  console.log(`  on-chain   ${current}`);
  console.log(`  enclave    ${next}${process.env.TEE_SIGNER ? " (from TEE_SIGNER)" : ` (from ${FCC_URL})`}`);

  if (ethers.getAddress(current) === next) {
    console.log(`\n  ✅ already in sync — nothing to do`);
    if (d.teeSigner !== next) {
      d.teeSigner = next;
      writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
      console.log(`  (deployments/coston2.json was stale — corrected)`);
    }
    return;
  }

  if (ethers.getAddress(onChainAdmin) !== ethers.getAddress(admin.address)) {
    throw new Error(
      `not the admin: book admin is ${onChainAdmin}, signer is ${admin.address}`,
    );
  }

  const tx = await book.setTeeSigner(next);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`setTeeSigner reverted: ${tx.hash}`);

  const after = ethers.getAddress(await book.teeSigner());
  if (after !== next) throw new Error(`rotation did not take: still ${after}`);

  console.log(`\n  ✅ teeSigner ${current} → ${after}`);
  console.log(`     tx ${tx.hash}`);

  d.teeSigner = after;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`  wrote deployments/coston2.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
