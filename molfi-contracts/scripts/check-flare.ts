/**
 * Read-only Coston2 preflight — costs no gas, needs no funded deployer.
 *
 * Verifies the three external dependencies Molfi-on-Flare rests on before we
 * spend anything deploying against them:
 *   1. FTSOv2 resolves through ContractRegistry and returns a live XRP/USD price
 *   2. FAssets' AssetManagerFXRP resolves and exposes the FXRP token
 *   3. FXRP is a real ERC-20 with the decimals we assume (6)
 *
 * Run: npx hardhat run scripts/check-flare.ts --network coston2
 */
import { ethers } from "hardhat";

const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

const FEEDS: Record<string, string> = {
  "XRP/USD": "0x015852502f55534400000000000000000000000000",
  "FLR/USD": "0x01464c522f55534400000000000000000000000000",
  "BTC/USD": "0x014254432f55534400000000000000000000000000",
  "ETH/USD": "0x014554482f55534400000000000000000000000000",
};

const REGISTRY_ABI = [
  "function getContractAddressByName(string) view returns (address)",
];
const FTSO_ABI = [
  "function getFeedById(bytes21) view returns (uint256 value, int8 decimals, uint64 timestamp)",
  "function getFeedByIdInWei(bytes21) view returns (uint256 value, uint64 timestamp)",
];
const ASSET_MANAGER_ABI = ["function fAsset() view returns (address)"];
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

async function main() {
  const provider = ethers.provider;
  const net = await provider.getNetwork();
  console.log(`\nNetwork: chainId ${net.chainId}\n${"=".repeat(60)}`);

  const registry = new ethers.Contract(REGISTRY, REGISTRY_ABI, provider);

  // ── 1. FTSOv2 ────────────────────────────────────────────────────────────
  const ftsoAddr = await registry.getContractAddressByName("FtsoV2");
  console.log(`\n[1] FTSOv2 → ${ftsoAddr}`);
  if (ftsoAddr === ethers.ZeroAddress) throw new Error("FtsoV2 unresolved");

  const ftso = new ethers.Contract(ftsoAddr, FTSO_ABI, provider);
  for (const [name, id] of Object.entries(FEEDS)) {
    try {
      const [value, decimals, ts] = await ftso.getFeedById(id);
      const human = Number(value) / 10 ** Number(decimals);
      const age = Math.floor(Date.now() / 1000) - Number(ts);
      console.log(
        `    ${name.padEnd(8)} $${human.toFixed(6)}  (decimals ${decimals}, ${age}s ago)`,
      );
    } catch (e: any) {
      console.log(`    ${name.padEnd(8)} FAILED: ${e.shortMessage ?? e.message}`);
    }
  }

  // ── 2. FAssets → FXRP ────────────────────────────────────────────────────
  console.log(`\n[2] FAssets`);
  let fxrpAddr: string | undefined;
  try {
    const amAddr = await registry.getContractAddressByName("AssetManagerFXRP");
    console.log(`    AssetManagerFXRP → ${amAddr}`);
    if (amAddr !== ethers.ZeroAddress) {
      const am = new ethers.Contract(amAddr, ASSET_MANAGER_ABI, provider);
      fxrpAddr = await am.fAsset();
      console.log(`    fAsset()         → ${fxrpAddr}`);
    }
  } catch (e: any) {
    console.log(`    registry lookup failed: ${e.shortMessage ?? e.message}`);
  }

  // Fall back to the documented Coston2 FTestXRP address.
  const DOC_FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
  if (!fxrpAddr || fxrpAddr === ethers.ZeroAddress) {
    console.log(`    falling back to documented FTestXRP ${DOC_FXRP}`);
    fxrpAddr = DOC_FXRP;
  }

  // ── 3. FXRP token shape ──────────────────────────────────────────────────
  console.log(`\n[3] FXRP token @ ${fxrpAddr}`);
  const code = await provider.getCode(fxrpAddr);
  if (code === "0x") {
    console.log(`    ✗ no contract deployed at this address`);
  } else {
    const t = new ethers.Contract(fxrpAddr, ERC20_ABI, provider);
    const [name, symbol, decimals, supply] = await Promise.all([
      t.name(),
      t.symbol(),
      t.decimals(),
      t.totalSupply(),
    ]);
    console.log(`    name     ${name}`);
    console.log(`    symbol   ${symbol}`);
    console.log(`    decimals ${decimals}`);
    console.log(`    supply   ${ethers.formatUnits(supply, decimals)}`);
    if (Number(decimals) !== 6) {
      console.log(
        `    ⚠ expected 6 decimals (XRP drops) — update FXRP_DECIMALS if this is right`,
      );
    }
  }

  // ── 4. Deployer balance ──────────────────────────────────────────────────
  const [signer] = await ethers.getSigners().catch(() => [undefined as any]);
  if (signer) {
    const bal = await provider.getBalance(signer.address);
    console.log(`\n[4] Deployer ${signer.address}`);
    console.log(`    C2FLR ${ethers.formatEther(bal)}`);
    if (bal === 0n) {
      console.log(`    → fund at https://faucet.flare.network/coston2`);
    }
    if (fxrpAddr && code !== "0x") {
      const t = new ethers.Contract(
        fxrpAddr,
        ["function balanceOf(address) view returns (uint256)", ...ERC20_ABI],
        provider,
      );
      const fbal = await t.balanceOf(signer.address);
      const d = await t.decimals();
      console.log(`    FXRP  ${ethers.formatUnits(fbal, d)}`);
    }
  }

  console.log(`\n${"=".repeat(60)}\npreflight complete\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
