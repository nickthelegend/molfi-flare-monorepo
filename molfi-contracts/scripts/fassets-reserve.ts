/**
 * FAssets mint, step 1 of 3: reserve collateral with an agent.
 *
 *   LOTS=1 npx hardhat run scripts/fassets-reserve.ts --network coston2
 *
 * FXRP is not a faucet token — it is a real over-collateralized claim on XRP.
 * Minting it means paying actual XRP on the XRP Ledger and proving that payment
 * to Flare. That is the whole point of FAssets, and it is why the Coston2
 * faucet's rate limit is not the only way to get FXRP.
 *
 * This step picks an agent with free capacity, pays the collateral reservation
 * fee in C2FLR, and records the payment instructions the agent hands back:
 * where to send XRP, how much, and the reference that ties the payment to this
 * reservation. Step 2 pays it on the XRPL; step 3 proves it via the Flare Data
 * Connector and mints.
 *
 * The reservation EXPIRES (`lastUnderlyingBlock`/`lastUnderlyingTimestamp`). Miss
 * the window and the fee is forfeit to the agent, so step 2 should follow
 * promptly.
 */
import { ethers } from "hardhat";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const OUT = `${__dirname}/../deployments/fassets-reservation.json`;

const REG_ABI = [
  "function getContractAddressByName(string) view returns (address)",
];
const AM_ABI = [
  "function lotSize() view returns (uint256)",
  "function getAvailableAgentsDetailedList(uint256,uint256) view returns (tuple(address agentVault,address ownerManagementAddress,uint256 feeBIPS,uint256 mintingVaultCollateralRatioBIPS,uint256 mintingPoolCollateralRatioBIPS,uint256 freeCollateralLots,uint8 status)[],uint256)",
  "function collateralReservationFee(uint256) view returns (uint256)",
  "function reserveCollateral(address,uint256,uint256,address) payable returns (uint256)",
  "event CollateralReserved(address indexed agentVault,address indexed minter,uint256 indexed collateralReservationId,uint256 valueUBA,uint256 feeUBA,uint256 firstUnderlyingBlock,uint256 lastUnderlyingBlock,uint256 lastUnderlyingTimestamp,string paymentAddress,bytes32 paymentReference,address executor,uint256 executorFeeNatWei)",
];

async function main() {
  const [minter] = await ethers.getSigners();
  const lots = BigInt(process.env.LOTS || 1);

  const reg = new ethers.Contract(REGISTRY, REG_ABI, minter);
  const amAddr = await reg.getContractAddressByName("AssetManagerFXRP");
  const am = new ethers.Contract(amAddr, AM_ABI, minter);
  console.log(`  AssetManagerFXRP ${amAddr}`);

  const lotSize = await am.lotSize();
  console.log(`  lot size ${Number(lotSize) / 1e6} FXRP · reserving ${lots} lot(s)\n`);

  // Pick the agent with the most headroom — least likely to be raced to zero
  // between reading the list and landing the reservation.
  const [agents] = await am.getAvailableAgentsDetailedList(0, 20);
  // ethers Result arrays are frozen — copy before sorting.
  const usable = [...agents]
    .filter((a: any) => a.freeCollateralLots >= lots)
    .sort((a: any, b: any) => Number(b.freeCollateralLots - a.freeCollateralLots));
  if (usable.length === 0) throw new Error(`no agent has ${lots} free lot(s)`);
  const agent = usable[0];
  console.log(`  agent ${agent.agentVault}`);
  console.log(`    free lots ${agent.freeCollateralLots} · fee ${Number(agent.feeBIPS) / 100}%`);

  const crFee = await am.collateralReservationFee(lots);
  const bal = await ethers.provider.getBalance(minter.address);
  console.log(`    reservation fee ${ethers.formatEther(crFee)} C2FLR (balance ${ethers.formatEther(bal)})`);
  if (bal < crFee) throw new Error("not enough C2FLR for the reservation fee");

  // maxMintingFeeBIPS = the agent's own published fee, so it cannot front-run
  // the reservation by raising it.
  const tx = await am.reserveCollateral(
    agent.agentVault,
    lots,
    agent.feeBIPS,
    ethers.ZeroAddress, // no executor — we execute the minting ourselves
    { value: crFee, gasLimit: 1_500_000 },
  );
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`reserveCollateral reverted: ${tx.hash}`);

  const parsed = receipt!.logs
    .map((l) => { try { return am.interface.parseLog(l as any); } catch { return null; } })
    .find((p) => p?.name === "CollateralReserved");
  if (!parsed) throw new Error("CollateralReserved not emitted");

  const a = parsed.args;
  const totalUBA = a.valueUBA + a.feeUBA;
  const reservation = {
    assetManager: amAddr,
    collateralReservationId: a.collateralReservationId.toString(),
    agentVault: a.agentVault,
    minter: a.minter,
    valueUBA: a.valueUBA.toString(),
    feeUBA: a.feeUBA.toString(),
    // What must actually land on the XRP Ledger, in drops.
    totalUBA: totalUBA.toString(),
    totalXRP: (Number(totalUBA) / 1e6).toString(),
    paymentAddress: a.paymentAddress,
    paymentReference: a.paymentReference,
    firstUnderlyingBlock: a.firstUnderlyingBlock.toString(),
    lastUnderlyingBlock: a.lastUnderlyingBlock.toString(),
    lastUnderlyingTimestamp: a.lastUnderlyingTimestamp.toString(),
    reservedAt: new Date().toISOString(),
    txHash: tx.hash,
  };

  console.log(`\n  ✅ reserved · id ${reservation.collateralReservationId}`);
  console.log(`     pay ${reservation.totalXRP} XRP  (${totalUBA} drops)`);
  console.log(`     to  ${reservation.paymentAddress}   [XRPL TESTNET]`);
  console.log(`     ref ${reservation.paymentReference}`);
  console.log(`     before underlying block ${reservation.lastUnderlyingBlock}`);

  writeFileSync(OUT, `${JSON.stringify(reservation, null, 2)}\n`);
  console.log(`\n  wrote deployments/fassets-reservation.json`);
  console.log(`  next: node scripts/fassets-pay-xrpl.mjs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
