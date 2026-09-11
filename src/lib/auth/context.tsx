"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  PrivyProvider,
  useCreateWallet,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import {
  PRIVY_DEFAULT_CHAIN,
  PRIVY_SUPPORTED_CHAINS,
  getPrivyAppId,
} from "./config";
import type { EIP1193Provider } from "viem";
import type {
  ConnectedExternalWalletMetadata,
  ExecutionWalletMetadata,
  UserAuthIdentity,
} from "./types";

const AuthContext = createContext<UserAuthIdentity | null>(null);

export function useAuth(): UserAuthIdentity {
  const context = useContext(AuthContext);
  if (!context) {
    return {
      configured: false,
      ready: true,
      authenticated: false,
      connectedExternalWallets: [],
      getAccessToken: async () => null,
      login: () => {},
      logout: async () => {},
      getEthereumProvider: async () => null,
    };
  }
  return context;
}

export const MOCK_AUTH_STORAGE_KEY = "useomnis:test:auth";

type MockAuthState = {
  authenticated: boolean;
  subject?: string;
  walletAddress?: string;
  chainId?: number;
  externalWallets?: Array<{ address: string; walletClientType: string }>;
};

function readMockState(): MockAuthState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MOCK_AUTH_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MockAuthState;
  } catch {
    return null;
  }
}

type MockAuthTestWindow = Window & {
  __OMNIS_TEST_AUTH_DELAY_MS?: number;
  __OMNIS_TEST_AUTH_READY?: boolean;
};

function readTestAuthDelay(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const testWindow = window as MockAuthTestWindow;
  const delay = testWindow.__OMNIS_TEST_AUTH_DELAY_MS;
  return typeof delay === "number" && Number.isFinite(delay) && delay > 0
    ? delay
    : undefined;
}

function MockAuthBridge({
  children,
  mockState,
  onStateChange,
}: {
  children: React.ReactNode;
  mockState: MockAuthState;
  onStateChange: (state: MockAuthState) => void;
}) {
  const [bridgeReady, setBridgeReady] = useState(false);

  useEffect(() => {
    const delay = readTestAuthDelay();
    const timeout = window.setTimeout(() => setBridgeReady(true), delay ?? 0);
    return () => window.clearTimeout(timeout);
  }, []);
  useEffect(() => {
    const testWindow = window as MockAuthTestWindow;
    testWindow.__OMNIS_TEST_AUTH_READY = bridgeReady;
  }, [bridgeReady]);
  const primaryExecutionWallet: ExecutionWalletMetadata | undefined =
    useMemo(() => {
      if (
        !bridgeReady ||
        !mockState.authenticated ||
        !mockState.walletAddress
      ) {
        return undefined;
      }
      return {
        address: mockState.walletAddress,
        walletClientType: "privy",
        chainType: "ethereum",
        role: "primaryExecutionWallet",
        ready: true,
        chainId: mockState.chainId ?? 5042002,
      };
    }, [
      bridgeReady,
      mockState.authenticated,
      mockState.walletAddress,
      mockState.chainId,
    ]);

  const connectedExternalWallets: readonly ConnectedExternalWalletMetadata[] =
    useMemo(() => {
      if (!bridgeReady || !mockState.externalWallets) return [];
      return mockState.externalWallets.map((ext) => ({
        address: ext.address,
        walletClientType: ext.walletClientType,
        chainType: "ethereum",
        role: "connectedExternalWallet" as const,
        ready: true,
      }));
    }, [bridgeReady, mockState.externalWallets]);

  const login = useCallback(() => {
    const next: MockAuthState = {
      authenticated: true,
      subject: mockState.subject || "did:privy:test-user",
      walletAddress:
        mockState.walletAddress || "0x1234567890abcdef1234567890abcdef12345678",
      externalWallets: mockState.externalWallets,
    };
    try {
      window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    onStateChange(next);
  }, [mockState, onStateChange]);

  const logout = useCallback(async () => {
    const next: MockAuthState = { authenticated: false };
    try {
      window.localStorage.removeItem(MOCK_AUTH_STORAGE_KEY);
    } catch {
      // ignore
    }
    onStateChange(next);
  }, [onStateChange]);

  const getAccessToken = useCallback(async () => {
    if (!mockState.authenticated || !mockState.subject) return null;
    return `mock-token:${mockState.subject}`;
  }, [mockState.authenticated, mockState.subject]);

  const getEthereumProvider =
    useCallback(async (): Promise<EIP1193Provider | null> => {
      if (typeof window !== "undefined") {
        const win = window as unknown as {
          __mockEip1193Provider?: EIP1193Provider;
        };
        if (win.__mockEip1193Provider) return win.__mockEip1193Provider;
      }
      if (!mockState.authenticated || !mockState.walletAddress) return null;
      const chainHex = `0x${(mockState.chainId ?? 5042002).toString(16)}`;
      return {
        request: async ({ method }: { method: string }) => {
          if (method === "eth_accounts") return [mockState.walletAddress];
          if (method === "eth_chainId") return chainHex;
          if (method === "wallet_switchEthereumChain") return null;
          if (method === "eth_sendTransaction") {
            return `0xmock${Date.now().toString(16)}00000000000000000000000000000000000000000000000000000000`;
          }
          return null;
        },
      } as unknown as EIP1193Provider;
    }, [mockState.authenticated, mockState.walletAddress, mockState.chainId]);

  const switchExecutionWalletChain = useCallback(
    async (
      targetChainId: number | `0x${string}`,
    ): Promise<EIP1193Provider | null> => {
      const targetNumeric =
        typeof targetChainId === "string"
          ? parseInt(targetChainId, 16)
          : targetChainId;
      const targetHex = `0x${targetNumeric.toString(16)}`;

      if (typeof window !== "undefined") {
        const win = window as unknown as {
          __mockPrivyWallet?: {
            switchChain: (id: number) => Promise<void>;
            getEthereumProvider: () => Promise<EIP1193Provider>;
          };
        };
        if (win.__mockPrivyWallet) {
          await win.__mockPrivyWallet.switchChain(targetNumeric);
          return (await win.__mockPrivyWallet.getEthereumProvider()) as unknown as EIP1193Provider;
        }
      }

      const updatedState: MockAuthState = {
        ...mockState,
        chainId: targetNumeric,
      };
      try {
        window.localStorage.setItem(
          MOCK_AUTH_STORAGE_KEY,
          JSON.stringify(updatedState),
        );
      } catch {
        // ignore
      }
      onStateChange(updatedState);

      return {
        request: async ({ method }: { method: string }) => {
          if (method === "eth_accounts") return [mockState.walletAddress];
          if (method === "eth_chainId") return targetHex;
          if (method === "wallet_switchEthereumChain") return null;
          if (method === "eth_sendTransaction") {
            return `0xmock${Date.now().toString(16)}00000000000000000000000000000000000000000000000000000000`;
          }
          return null;
        },
      } as unknown as EIP1193Provider;
    },
    [mockState, onStateChange],
  );

  const identity: UserAuthIdentity = useMemo(
    () => ({
      configured: true,
      ready: bridgeReady,
      authenticated: bridgeReady && mockState.authenticated,
      ownerSubject:
        bridgeReady && mockState.authenticated ? mockState.subject : undefined,
      primaryExecutionWallet,
      connectedExternalWallets,
      getAccessToken,
      login,
      logout,
      getEthereumProvider,
      switchExecutionWalletChain,
    }),
    [
      bridgeReady,
      mockState.authenticated,
      mockState.subject,
      primaryExecutionWallet,
      connectedExternalWallets,
      getAccessToken,
      login,
      logout,
      getEthereumProvider,
      switchExecutionWalletChain,
    ],
  );

  return (
    <AuthContext.Provider value={identity}>{children}</AuthContext.Provider>
  );
}

function PrivyBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();

  // Explicitly identify embedded EVM wallet as primary execution wallet.
  // Never silently substitute an external wallet for the embedded wallet.
  const { primaryExecutionWallet, connectedExternalWallets } = useMemo(() => {
    if (!authenticated || !user) {
      return {
        primaryExecutionWallet: undefined,
        connectedExternalWallets: [] as ConnectedExternalWalletMetadata[],
      };
    }

    // Find linked or connected embedded privy wallet
    const embeddedFromWallets = wallets.find(
      (w) =>
        w.walletClientType === "privy" ||
        (w as unknown as { connectorType?: string }).connectorType ===
          "embedded",
    );

    const embeddedFromLinked = user.linkedAccounts?.find(
      (account) =>
        account.type === "wallet" &&
        (account.walletClientType === "privy" ||
          (account as unknown as { connectorType?: string }).connectorType ===
            "embedded") &&
        (account.chainType === "ethereum" || !account.chainType),
    );

    const embeddedAddress =
      embeddedFromWallets?.address ??
      (embeddedFromLinked && "address" in embeddedFromLinked
        ? (embeddedFromLinked.address as string)
        : undefined);

    let parsedChainId: number | undefined;
    if (
      embeddedFromWallets &&
      "chainId" in embeddedFromWallets &&
      embeddedFromWallets.chainId
    ) {
      const raw = String(embeddedFromWallets.chainId);
      const match = raw.match(/\d+/);
      if (match) parsedChainId = parseInt(match[0], 10);
    }

    const primary: ExecutionWalletMetadata | undefined = embeddedAddress
      ? {
          address: embeddedAddress,
          walletClientType: "privy",
          chainType: "ethereum",
          role: "primaryExecutionWallet",
          ready: embeddedFromWallets
            ? walletsReady
            : Boolean(embeddedFromLinked),
          chainId: parsedChainId,
        }
      : undefined;

    // Collect external wallets (deduplicated by address)
    const externalList: ConnectedExternalWalletMetadata[] = [];
    const seenAddresses = new Set<string>();
    if (embeddedAddress) {
      seenAddresses.add(embeddedAddress.toLowerCase());
    }
    for (const w of wallets) {
      if (
        w.walletClientType !== "privy" &&
        (w as unknown as { connectorType?: string }).connectorType !==
          "embedded"
      ) {
        const addrLower = w.address.toLowerCase();
        if (!seenAddresses.has(addrLower)) {
          seenAddresses.add(addrLower);
          externalList.push({
            address: w.address,
            walletClientType: w.walletClientType || "external",
            chainType: "ethereum",
            role: "connectedExternalWallet",
            ready: walletsReady,
          });
        }
      }
    }
    // Also check linked accounts for external wallets not currently in connected wallets
    if (user.linkedAccounts) {
      for (const acc of user.linkedAccounts) {
        if (
          acc.type === "wallet" &&
          acc.walletClientType !== "privy" &&
          (acc as unknown as { connectorType?: string }).connectorType !==
            "embedded" &&
          "address" in acc &&
          typeof acc.address === "string"
        ) {
          const addrLower = acc.address.toLowerCase();
          if (!seenAddresses.has(addrLower)) {
            seenAddresses.add(addrLower);
            externalList.push({
              address: acc.address,
              walletClientType: acc.walletClientType || "external",
              chainType: acc.chainType || "ethereum",
              role: "connectedExternalWallet",
              ready: false,
            });
          }
        }
      }
    }

    return {
      primaryExecutionWallet: primary,
      connectedExternalWallets: externalList,
    };
  }, [authenticated, user, wallets, walletsReady]);

  const handleCreateWallet = useCallback(async () => {
    if (createWallet) {
      await createWallet();
    }
  }, [createWallet]);

  const getEthereumProvider =
    useCallback(async (): Promise<EIP1193Provider | null> => {
      const embedded = wallets.find(
        (w) =>
          w.walletClientType === "privy" ||
          (w as unknown as { connectorType?: string }).connectorType ===
            "embedded",
      );
      if (!embedded) return null;
      return (await embedded.getEthereumProvider()) as unknown as EIP1193Provider;
    }, [wallets]);

  const switchExecutionWalletChain = useCallback(
    async (
      targetChainId: number | `0x${string}`,
    ): Promise<EIP1193Provider | null> => {
      const embedded = wallets.find(
        (w) =>
          w.walletClientType === "privy" ||
          (w as unknown as { connectorType?: string }).connectorType ===
            "embedded",
      );
      if (!embedded) {
        throw new Error(
          "Primary execution wallet not found. Ensure an embedded Privy wallet is created.",
        );
      }

      const targetNumeric =
        typeof targetChainId === "string"
          ? parseInt(targetChainId, 16)
          : targetChainId;

      // Read current chain ID from embedded wallet if present
      let currentChainId: number | undefined;
      if ("chainId" in embedded && embedded.chainId) {
        const raw = String(embedded.chainId);
        const match = raw.match(/\d+/);
        if (match) currentChainId = parseInt(match[0], 10);
      }

      if (currentChainId !== targetNumeric) {
        await embedded.switchChain(targetNumeric);
      }

      // Obtain a fresh EIP-1193 provider AFTER switching
      const freshProvider =
        (await embedded.getEthereumProvider()) as unknown as EIP1193Provider;

      // Verify eth_chainId matches targetNumeric
      const postSwitchChainHex = (await freshProvider.request({
        method: "eth_chainId",
      })) as string;
      const postSwitchNum =
        typeof postSwitchChainHex === "string"
          ? postSwitchChainHex.startsWith("0x") ||
            postSwitchChainHex.startsWith("0X")
            ? parseInt(postSwitchChainHex, 16)
            : parseInt(postSwitchChainHex, 10)
          : Number(postSwitchChainHex);

      if (postSwitchNum !== targetNumeric) {
        throw new Error(
          `Chain switch verification failed: requested chain ${targetNumeric}, but active provider chain is ${postSwitchChainHex} (${postSwitchNum})`,
        );
      }

      return freshProvider;
    },
    [wallets],
  );

  const identity: UserAuthIdentity = useMemo(
    () => ({
      configured: true,
      ready,
      authenticated: Boolean(authenticated && user),
      ownerSubject: user?.id,
      primaryExecutionWallet,
      connectedExternalWallets,
      getAccessToken,
      login,
      logout,
      createWallet: handleCreateWallet,
      getEthereumProvider,
      switchExecutionWalletChain,
    }),
    [
      ready,
      authenticated,
      user,
      primaryExecutionWallet,
      connectedExternalWallets,
      getAccessToken,
      login,
      logout,
      handleCreateWallet,
      getEthereumProvider,
      switchExecutionWalletChain,
    ],
  );

  return (
    <AuthContext.Provider value={identity}>{children}</AuthContext.Provider>
  );
}

function UnconfiguredBridge({ children }: { children: React.ReactNode }) {
  const identity: UserAuthIdentity = useMemo(
    () => ({
      configured: false,
      ready: true,
      authenticated: false,
      connectedExternalWallets: [],
      getAccessToken: async () => null,
      login: () => {
        alert(
          "Privy is not configured. Set NEXT_PUBLIC_PRIVY_APP_ID in your environment.",
        );
      },
      logout: async () => {},
      getEthereumProvider: async () => null,
      switchExecutionWalletChain: async () => null,
    }),
    [],
  );

  return (
    <AuthContext.Provider value={identity}>{children}</AuthContext.Provider>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const appId = getPrivyAppId();
  const [mockState, setMockState] = useState<MockAuthState | null>(
    readMockState,
  );

  // Listen for mock auth state updates across tabs or from test scripts
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === MOCK_AUTH_STORAGE_KEY) {
        setMockState(readMockState());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // If a mock auth state is active in tests / local preview
  if (mockState) {
    return (
      <MockAuthBridge
        mockState={mockState}
        onStateChange={(next) => setMockState(next)}
      >
        {children}
      </MockAuthBridge>
    );
  }

  // If Privy is configured with real App ID
  if (appId) {
    return (
      <PrivyProvider
        appId={appId}
        config={{
          appearance: {
            theme: "dark",
            accentColor: "#7B3FF2",
            logo: "/brand/useomnis-circular-mark-light.png",
          },
          supportedChains: [...PRIVY_SUPPORTED_CHAINS],
          defaultChain: PRIVY_DEFAULT_CHAIN,
          embeddedWallets: {
            ethereum: {
              createOnLogin: "users-without-wallets",
            },
          },
        }}
      >
        <PrivyBridge>{children}</PrivyBridge>
      </PrivyProvider>
    );
  }

  // Unconfigured fallback
  return <UnconfiguredBridge>{children}</UnconfiguredBridge>;
}
