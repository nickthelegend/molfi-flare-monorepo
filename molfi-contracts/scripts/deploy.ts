/**
 * Deploy the Molfi contract set to Flare Coston2.
 *
 *   npx hardhat run scripts/deploy.ts --network coston2
 *
 * Writes deployments/coston2.json, which every other package reads.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const REGISTRY_ABI = [
  "function getContractAddressByName(string) view returns (address)",
];
const ASSET_MANAGER_ABI = ["function fAsset() view returns (address)"];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

/** 1 FXRP per confidential note (FXRP has 6 decimals). */
const CONF_DENOM = 1_000_000n;

async function resolveFxrp(): Promise<string> {
  // Flare's guidance: never hardcode FAssets addresses — resolve through the
  // registry, which is the one address that is stable across upgrades.
  if ((await ethers.provider.getCode(REGISTRY)) === "0x") {
    throw new Error(
      `No FlareContractRegistry at ${REGISTRY}. This script only runs against ` +
        `a Flare network (coston2 / flare) — use --network coston2.`,
    );
  }
  const registry = new ethers.Contract(REGISTRY, REGISTRY_ABI, ethers.provider);
  const am = await registry.getContractAddressByName("AssetManagerFXRP");
  if (am === ethers.ZeroAddress) {
    throw new Error("AssetManagerFXRP unresolved — is this a Flare network?");
  }
  const fxrp = await new ethers.Contract(
    am,
    ASSET_MANAGER_ABI,
    ethers.provider,
  ).fAsset();
  if (fxrp === ethers.ZeroAddress) throw new Error("fAsset() returned zero");
  return fxrp;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\nDeploying Molfi → chainId ${net.chainId}`);
  console.log(`Deployer ${deployer.address}`);
  console.log(`Balance  ${ethers.formatEther(balance)} C2FLR\n`);

  if (balance === 0n) {
    throw new Error(
      `Deployer has no gas. Fund ${deployer.address} at ` +
        `https://faucet.flare.network/coston2 and re-run.`,
    );
  }

  // ── collateral ───────────────────────────────────────────────────────────
  const fxrpAddress = await resolveFxrp();
  const fxrp = new ethers.Contract(fxrpAddress, ERC20_ABI, ethers.provider);
  const [sym, dec] = await Promise.all([fxrp.symbol(), fxrp.decimals()]);
  console.log(`FXRP  ${fxrpAddress}  (${sym}, ${dec} decimals)`);
  if (Number(dec) !== 6) {
    console.log(`  ⚠ expected 6 decimals — check CONF_DENOM before continuing`);
  }

  // ── deploy ───────────────────────────────────────────────────────────────
  const deployed: Record<string, string> = {};
  const deploy = async (name: string, args: unknown[] = []) => {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...(args as []));
    await c.waitForDeployment();
    const addr = await c.getAddress();
    deployed[name] = addr;
    console.log(`${name.padEnd(24)} ${addr}`);
    return c;
  };

  console.log(`\n── deploying ──`);
  const oracle = await deploy("FtsoOracle");
  const verifier = await deploy("ConfidentialBetVerifier");
  const market = await deploy("MolfiMarket", [await oracle.getAddress()]);
  const escrow = await deploy("PredictEscrow", [
    fxrpAddress,
    await verifier.getAddress(),
    await market.getAddress(),
    deployer.address, // fee vault
  ]);
  const cbet = await deploy("ConfidentialBet", [
    fxrpAddress,
    await verifier.getAddress(),
    await market.getAddress(),
    CONF_DENOM,
  ]);

  // ── sanity: read a live price through the deployed oracle ────────────────
  console.log(`\n── verifying live FTSO read through deployed oracle ──`);
  const XRP_USD = "0x015852502f55534400000000000000000000000000";
  try {
    const [price, ts] = await (oracle as any).getPrice(XRP_USD);
    console.log(
      `XRP/USD $${ethers.formatUnits(price, 18)} @ ${new Date(
        Number(ts) * 1000,
      ).toISOString()}`,
    );
  } catch (e: any) {
    console.log(`⚠ FTSO read failed: ${e.shortMessage ?? e.message}`);
  }

  // ── artifact ─────────────────────────────────────────────────────────────
  const out = {
    network: network.name,
    chainId: Number(net.chainId),
    rpc: "https://coston2-api.flare.network/ext/C/rpc",
    explorer: "https://coston2-explorer.flare.network",
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    fxrp: fxrpAddress,
    fxrpDecimals: Number(dec),
    confDenom: CONF_DENOM.toString(),
    contracts: {
      ftsoOracle: deployed.FtsoOracle,
      confidentialBetVerifier: deployed.ConfidentialBetVerifier,
      molfiMarket: deployed.MolfiMarket,
      predictEscrow: deployed.PredictEscrow,
      confidentialBet: deployed.ConfidentialBet,
    },
    feeds: {
      "XRP/USD": "0x015852502f55534400000000000000000000000000",
      "FLR/USD": "0x01464c522f55534400000000000000000000000000",
      "BTC/USD": "0x014254432f55534400000000000000000000000000",
      "ETH/USD": "0x014554482f55534400000000000000000000000000",
    },
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote ${file}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
