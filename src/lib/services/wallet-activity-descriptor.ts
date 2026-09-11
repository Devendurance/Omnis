import { createServiceDescriptor } from "../domain/services/factory";
import { money } from "../domain/money";
import type { ServiceDescriptor } from "../domain/types";

export const WALLET_ACTIVITY_SERVICE_ID = "useomnis-wallet-activity-x402" as const;
export const WALLET_ACTIVITY_SERVICE_PATH = "/api/services/wallet-activity" as const;
export const HEDERA_TESTNET_NETWORK = "hedera:testnet" as const;
export const HEDERA_TESTNET_USDC_ASSET = "0.0.429274" as const;
export const HEDERA_TESTNET_USDC_DECIMALS = 6 as const;
export const WALLET_ACTIVITY_PRICE = money(
  "0.003",
  "USDC",
  HEDERA_TESTNET_USDC_DECIMALS,
);
export const WALLET_ACTIVITY_QUOTE = money("0.003", "USD", 6);

export function createWalletActivityServiceDescriptor(
  status: ServiceDescriptor["status"] = "unavailable",
): ServiceDescriptor {
  return createServiceDescriptor({
    id: WALLET_ACTIVITY_SERVICE_ID,
    name: "Wallet activity check",
    capability: "wallet-activity",
    category: "wallet-risk",
    description:
      "Read-only Ethereum activity observations and clearly labeled heuristic flags for a wallet address.",
    endpoint: WALLET_ACTIVITY_SERVICE_PATH,
    price: WALLET_ACTIVITY_QUOTE,
    paymentAmount: WALLET_ACTIVITY_PRICE,
    network: HEDERA_TESTNET_NETWORK,
    paymentProtocol: "x402",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        wallet: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["observations", "heuristicFlags"],
    },
    status,
    environment: "testnet",
    catalogOnly: false,
  });
}
