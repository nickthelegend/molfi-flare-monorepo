import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/**
 * Flare Coston2 testnet (chainId 114).
 *
 * Coston2 is where FAssets exposes FTestXRP — an ERC-20 FXRP the faucet hands
 * out directly, so markets can be collateralized in FXRP without running the
 * full FDC mint flow. Settlement prices come from FTSOv2 via ContractRegistry.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // FTSO/FAssets periphery interfaces push the stack; via-IR keeps the
      // settlement path compiling without splitting it into helper structs.
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    coston2: {
      url: process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc",
      accounts,
      chainId: 114,
    },
    flare: {
      url: process.env.FLARE_RPC ?? "https://flare-api.flare.network/ext/C/rpc",
      accounts,
      chainId: 14,
    },
  },
  etherscan: {
    // Coston2 verification goes through the Blockscout-compatible explorer.
    apiKey: {
      coston2: "coston2", // Blockscout ignores the key but hardhat-verify requires one
    },
    customChains: [
      {
        network: "coston2",
        chainId: 114,
        urls: {
          apiURL: "https://coston2-explorer.flare.network/api",
          browserURL: "https://coston2-explorer.flare.network",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  gasReporter: { enabled: process.env.REPORT_GAS === "true" },
  mocha: { timeout: 120_000 },
};

export default config;
