import { defineChain } from "viem";
import { moneyFromUnits, parseMoney, type Money } from "../../domain/money";

export const ARC_TESTNET_CHAIN_ID = 5042002 as const;
export const ARC_TESTNET_NAME = "Arc Testnet" as const;
export const ARC_TESTNET_CHAIN_ENUM = "Arc_Testnet" as const;

export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network/" as const;
export const ARC_TESTNET_EXPLORER_URL = "https://testnet.arcscan.app" as const;
export const ARC_TESTNET_EXPLORER_API_URL =
  process.env.ARC_TESTNET_FALLBACK_API_URL || "https://testnet.arcscan.app/api";
export const ARC_TESTNET_FALLBACK_RPC_URL =
  process.env.ARC_TESTNET_RPC_FALLBACK_URL || undefined;
export const ARC_TESTNET_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;
export const ARC_TESTNET_USDC_DECIMALS = 6 as const;
export const ARC_TESTNET_USDC_SYMBOL = "USDC" as const;

export const ARC_TESTNET_GATEWAY_DOMAIN = 26 as const;
export const ARC_TESTNET_GATEWAY_WALLET_CONTRACT =
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;
export const ARC_TESTNET_GATEWAY_MINTER_CONTRACT =
  "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as const;

/**
 * Standard ERC-20 ABI for USDC operations on Arc Testnet.
 * Application-level USDC accounting strictly uses 6 decimals.
 */
export const ERC20_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * Viem Chain definition for Arc Testnet.
 * Note: Arc native gas token is also denominated in USDC with 18 decimals,
 * but application-level USDC ERC-20 contract is strictly 6 decimals.
 */
export const arcTestnetChain = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: ARC_TESTNET_NAME,
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [ARC_TESTNET_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: ARC_TESTNET_EXPLORER_URL,
    },
  },
  testnet: true,
});

/**
 * Canonical alias for Arc Testnet viem chain definition.
 */
export const arcTestnet = arcTestnetChain;

/**
 * Validates that a chain ID or hex string matches Arc Testnet.
 */
export function isArcTestnetChainId(
  chainId: number | string | bigint | undefined,
): boolean {
  if (chainId === undefined || chainId === null) return false;
  if (typeof chainId === "number") return chainId === ARC_TESTNET_CHAIN_ID;
  if (typeof chainId === "bigint")
    return chainId === BigInt(ARC_TESTNET_CHAIN_ID);
  if (typeof chainId === "string") {
    const trimmed = chainId.trim();
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      return parseInt(trimmed, 16) === ARC_TESTNET_CHAIN_ID;
    }
    return parseInt(trimmed, 10) === ARC_TESTNET_CHAIN_ID;
  }
  return false;
}

/**
 * Parse a human-readable decimal USDC string into 6-decimal atomic units.
 * Never uses JS float math.
 */
export function parseUsdcUnits(amount: string): bigint {
  const money = parseMoney(amount, ARC_TESTNET_USDC_SYMBOL, ARC_TESTNET_USDC_DECIMALS);
  return money.units;
}

/**
 * Format 6-decimal USDC atomic units into a human-readable decimal string.
 * Never uses JS float math.
 */
export function formatUsdcUnits(units: bigint): string {
  const money = moneyFromUnits(units, ARC_TESTNET_USDC_SYMBOL, ARC_TESTNET_USDC_DECIMALS);
  const raw = money.units.toString().padStart(ARC_TESTNET_USDC_DECIMALS + 1, "0");
  const splitIndex = raw.length - ARC_TESTNET_USDC_DECIMALS;
  const whole = raw.slice(0, splitIndex);
  let fractional = raw.slice(splitIndex);
  while (fractional.endsWith("0") && fractional.length > 2) {
    fractional = fractional.slice(0, -1);
  }
  return `${whole}.${fractional}`;
}

/**
 * Create a Money value for USDC on Arc Testnet.
 */
export function usdcMoney(units: bigint): Money {
  return moneyFromUnits(units, ARC_TESTNET_USDC_SYMBOL, ARC_TESTNET_USDC_DECIMALS);
}

/**
 * Validates the Arc Testnet configuration constants.
 */
export function validateArcTestnetConfig(): void {
  if (ARC_TESTNET_CHAIN_ID !== 5042002) {
    throw new Error(`Invalid Arc Testnet Chain ID: ${ARC_TESTNET_CHAIN_ID}`);
  }
  if (
    ARC_TESTNET_USDC_ADDRESS.toLowerCase() !==
    "0x3600000000000000000000000000000000000000"
  ) {
    throw new Error(
      `Invalid Arc Testnet USDC contract: ${ARC_TESTNET_USDC_ADDRESS}`,
    );
  }
  if (ARC_TESTNET_USDC_DECIMALS !== 6) {
    throw new Error(
      `Invalid Arc Testnet USDC decimals: ${ARC_TESTNET_USDC_DECIMALS}`,
    );
  }
  if (ARC_TESTNET_GATEWAY_DOMAIN !== 26) {
    throw new Error(
      `Invalid Arc Testnet Gateway domain: ${ARC_TESTNET_GATEWAY_DOMAIN}`,
    );
  }
}
