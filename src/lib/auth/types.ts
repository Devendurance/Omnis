import type { EIP1193Provider } from "viem";

export type ExecutionWalletRole = "primaryExecutionWallet";
export type ExternalWalletRole = "connectedExternalWallet";

export type ExecutionWalletMetadata = Readonly<{
  address: string;
  walletClientType: string;
  chainType: "ethereum";
  role: ExecutionWalletRole;
  ready: boolean;
  chainId?: number;
}>;

export type ConnectedExternalWalletMetadata = Readonly<{
  address: string;
  walletClientType: string;
  chainType: string;
  role: ExternalWalletRole;
  ready: boolean;
}>;

export type UserAuthIdentity = Readonly<{
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  ownerSubject?: string;
  primaryExecutionWallet?: ExecutionWalletMetadata;
  connectedExternalWallets: readonly ConnectedExternalWalletMetadata[];
  getAccessToken: () => Promise<string | null>;
  login: () => void | Promise<void>;
  logout: () => Promise<void>;
  createWallet?: () => Promise<void>;
  getEthereumProvider?: () => Promise<EIP1193Provider | null>;
  switchExecutionWalletChain?: (
    targetChainId: number | `0x${string}`,
  ) => Promise<EIP1193Provider | null>;
  error?: string;
}>;
