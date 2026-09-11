import { arcTestnetChain } from "../settlement/arc/config";

/**
 * Privy configuration reader for useOmnis.
 * Server credentials must NEVER be imported or exposed here.
 */

export function getPrivyAppId(): string | undefined {
  if (typeof window !== "undefined") {
    const win = window as unknown as { __OMNIS_PREVIEW_MODE?: boolean };
    if (win.__OMNIS_PREVIEW_MODE) return undefined;
  }
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  return appId || undefined;
}

export function isPrivyConfigured(): boolean {
  return Boolean(getPrivyAppId());
}

export function requirePrivyAppId(): string {
  const appId = getPrivyAppId();
  if (!appId) {
    throw new Error(
      "Privy is not configured: NEXT_PUBLIC_PRIVY_APP_ID environment variable is missing",
    );
  }
  return appId;
}

/**
 * Privy supported EVM chains for useOmnis.
 * Arc Testnet (5042002) is explicitly configured to enable programmatic
 * network switching and settlement verification on embedded wallets.
 */
export const PRIVY_SUPPORTED_CHAINS = [arcTestnetChain] as const;

/**
 * Default chain for Privy embedded wallets upon creation.
 */
export const PRIVY_DEFAULT_CHAIN = arcTestnetChain;

/**
 * Check whether a chain ID is in Privy's configured supported chains.
 */
export function isChainSupportedByPrivy(
  chainId: number | string | bigint | undefined,
): boolean {
  if (chainId === undefined || chainId === null) return false;
  return PRIVY_SUPPORTED_CHAINS.some((chain) => {
    if (typeof chainId === "number") return chain.id === chainId;
    if (typeof chainId === "bigint") return BigInt(chain.id) === chainId;
    if (typeof chainId === "string") {
      const trimmed = chainId.trim();
      const num =
        trimmed.startsWith("0x") || trimmed.startsWith("0X")
          ? parseInt(trimmed, 16)
          : parseInt(trimmed, 10);
      return chain.id === num;
    }
    return false;
  });
}
