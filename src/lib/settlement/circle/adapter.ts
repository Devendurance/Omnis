import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  type EIP1193Provider,
  type Hash,
  type PublicClient,
} from "viem";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import type { UserAuthIdentity } from "../../auth/types";
import { isChainSupportedByPrivy } from "../../auth/config";
import {
  compareMoney,
  formatMoney,
  moneyFromUnits,
  moneyZero,
  parseMoney,
  type Money,
} from "../../domain/money";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ENUM,
  ARC_TESTNET_NAME,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_RPC_URL,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_TESTNET_USDC_DECIMALS,
  ARC_TESTNET_USDC_SYMBOL,
  ERC20_ABI,
  arcTestnetChain,
  isArcTestnetChainId,
} from "../arc/config";
import type {
  CircleArcPreflightReport,
  CircleSettlementEvidence,
  CircleSettlementOperationType,
  DestinationConfiguration,
  SettlementConfirmationParams,
} from "./types";

/**
 * Validates that the authenticated identity has a ready primary execution wallet.
 * Strictly prevents external connected wallets from replacing the embedded execution wallet.
 */
export function validatePrimaryExecutionWallet(
  authIdentity: UserAuthIdentity,
): {
  ownerSubject: string;
  executionWalletAddress: `0x${string}`;
} {
  if (!authIdentity.authenticated || !authIdentity.ownerSubject) {
    throw new Error("Authentication required: user is not authenticated");
  }

  const primaryWallet = authIdentity.primaryExecutionWallet;
  if (!primaryWallet) {
    throw new Error(
      "Primary execution wallet not found. Ensure an embedded Privy wallet is created.",
    );
  }

  if (primaryWallet.role !== "primaryExecutionWallet") {
    throw new Error(
      "Security violation: only primaryExecutionWallet can execute settlements",
    );
  }

  if (!primaryWallet.address || !primaryWallet.address.startsWith("0x")) {
    throw new Error(
      `Invalid primary execution wallet address: ${primaryWallet.address}`,
    );
  }

  return {
    ownerSubject: authIdentity.ownerSubject,
    executionWalletAddress: primaryWallet.address as `0x${string}`,
  };
}

/**
 * Creates or returns a Viem PublicClient for Arc Testnet.
 */
export function getArcPublicClient(
  overrideClient?: PublicClient,
): PublicClient {
  if (overrideClient) return overrideClient;
  if (typeof window !== "undefined") {
    const win = window as unknown as { __mockPublicClient?: PublicClient };
    if (win.__mockPublicClient) return win.__mockPublicClient;
  }
  return createPublicClient({
    chain: arcTestnetChain,
    transport: http(ARC_TESTNET_RPC_URL, {
      timeout: 15_000,
    }),
  });
}

/**
 * Read standard 6-decimal ERC-20 USDC balance for an address on Arc Testnet.
 * Application-level USDC accounting strictly uses 6 decimals and bigint arithmetic.
 */
export async function getArcUsdcBalance(
  address: `0x${string}`,
  publicClient?: PublicClient,
): Promise<Money> {
  const client = getArcPublicClient(publicClient);
  try {
    const rawBalance = (await client.readContract({
      address: ARC_TESTNET_USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;

    return moneyFromUnits(
      rawBalance,
      ARC_TESTNET_USDC_SYMBOL,
      ARC_TESTNET_USDC_DECIMALS,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to query Arc USDC balance: ${msg}`);
  }
}

/**
 * Read Circle Unified Balance for an address on Arc Testnet via Circle AppKit.
 * Safely parses the confirmed balance into 6-decimal Money.
 */
export async function getCircleUnifiedBalance(
  address: `0x${string}`,
  appKitInstance?: AppKit,
): Promise<Money> {
  const appKit = appKitInstance ?? new AppKit();
  try {
    const res = await appKit.unifiedBalance.getBalances({
      token: "USDC",
      sources: {
        address,
        chains: [ARC_TESTNET_CHAIN_ENUM],
      },
      networkType: "testnet",
    });

    const confirmedStr = res.totalConfirmedBalance || "0";
    return parseMoney(
      confirmedStr,
      ARC_TESTNET_USDC_SYMBOL,
      ARC_TESTNET_USDC_DECIMALS,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to query Circle Unified Balance: ${msg}`);
  }
}

/**
 * Validates the provider's active chain and switches to Arc Testnet if needed.
 */
export async function ensureArcTestnetChain(
  provider: EIP1193Provider,
): Promise<void> {
  let chainIdHex: string;
  try {
    chainIdHex = (await provider.request({
      method: "eth_chainId",
    })) as string;
  } catch (err) {
    throw new Error(
      `Network guard error: failed to query active chainId from provider: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isArcTestnetChainId(chainIdHex)) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${ARC_TESTNET_CHAIN_ID.toString(16)}` }],
      });
    } catch (switchErr) {
      throw new Error(
        `Wallet is on chain ${chainIdHex}, not Arc Testnet (${ARC_TESTNET_CHAIN_ID}). Failed to switch: ${switchErr instanceof Error ? switchErr.message : String(switchErr)}`,
      );
    }

    // Re-read and verify chain after switching (fail-closed)
    let postSwitchChainIdHex: string;
    try {
      postSwitchChainIdHex = (await provider.request({
        method: "eth_chainId",
      })) as string;
    } catch (err) {
      throw new Error(
        `Network guard error: failed to verify chainId after switch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!isArcTestnetChainId(postSwitchChainIdHex)) {
      throw new Error(
        `Network guard security failure: chain switch requested Arc Testnet (${ARC_TESTNET_CHAIN_ID}), but active chain remains ${postSwitchChainIdHex}`,
      );
    }
  }
}

/**
 * Creates a Circle ViemAdapter from an EIP-1193 provider.
 */
export async function createCircleAdapter(
  provider: EIP1193Provider,
) {
  return createViemAdapterFromProvider({ provider });
}

export type RunPreflightParams = Readonly<{
  authIdentity: UserAuthIdentity;
  requestedAmount: Money;
  destination: DestinationConfiguration;
  provider?: EIP1193Provider;
  publicClient?: PublicClient;
  appKit?: AppKit;
  now?: string;
}>;

/**
 * Deterministic read-only preflight.
 * Never signs, approves, deposits, bridges, spends, or sends a transaction.
 */
export async function runCircleArcPreflight(
  params: RunPreflightParams,
): Promise<CircleArcPreflightReport> {
  const now = params.now ?? new Date().toISOString();
  const blockers: string[] = [];

  let authenticatedSubject: string | undefined;
  let executionWalletAddress: `0x${string}` | undefined;
  let walletReady = false;

  try {
    const walletInfo = validatePrimaryExecutionWallet(params.authIdentity);
    authenticatedSubject = walletInfo.ownerSubject;
    executionWalletAddress = walletInfo.executionWalletAddress;
    walletReady = Boolean(params.authIdentity.primaryExecutionWallet?.ready);
  } catch (err) {
    blockers.push(err instanceof Error ? err.message : String(err));
  }

  // Resolve current wallet chain and Privy support status
  const targetChain = ARC_TESTNET_CHAIN_ID;
  const chainSupportedByPrivy = isChainSupportedByPrivy(targetChain);
  let currentWalletChain: number | undefined =
    params.authIdentity.primaryExecutionWallet?.chainId;

  try {
    const effectiveProvider =
      params.provider ??
      (params.authIdentity.getEthereumProvider
        ? await params.authIdentity.getEthereumProvider()
        : null);
    if (effectiveProvider) {
      const hex = (await effectiveProvider.request({
        method: "eth_chainId",
      })) as string | number;
      if (typeof hex === "string") {
        const trimmed = hex.trim();
        currentWalletChain =
          trimmed.startsWith("0x") || trimmed.startsWith("0X")
            ? parseInt(trimmed, 16)
            : parseInt(trimmed, 10);
      } else if (typeof hex === "number") {
        currentWalletChain = hex;
      }
    }
  } catch {
    // Retain whatever chain was extracted from metadata or undefined
  }

  if (!chainSupportedByPrivy) {
    blockers.push(
      `Target chain ${targetChain} (${ARC_TESTNET_NAME}) is not configured in Privy supported chains`,
    );
  }

  const switchRequired =
    currentWalletChain !== undefined ? currentWalletChain !== targetChain : true;
  // Read-only preflight never triggers a network switch; switchSucceeded is true only if already on target chain
  const switchSucceeded = currentWalletChain === targetChain;

  let arcTestnetReachable = false;
  let currentArcUsdcBalance = moneyZero(
    ARC_TESTNET_USDC_SYMBOL,
    ARC_TESTNET_USDC_DECIMALS,
  );
  let circleUnifiedBalance = moneyZero(
    ARC_TESTNET_USDC_SYMBOL,
    ARC_TESTNET_USDC_DECIMALS,
  );

  const client = getArcPublicClient(params.publicClient);

  try {
    const chainId = await client.getChainId();
    if (isArcTestnetChainId(chainId)) {
      arcTestnetReachable = true;
    } else {
      blockers.push(
        `Connected network chainId ${chainId} does not match Arc Testnet ${ARC_TESTNET_CHAIN_ID}`,
      );
    }
  } catch (err) {
    blockers.push(
      `Arc Testnet RPC unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (executionWalletAddress && arcTestnetReachable) {
    try {
      currentArcUsdcBalance = await getArcUsdcBalance(
        executionWalletAddress,
        client,
      );
    } catch (err) {
      blockers.push(
        `Failed to read wallet USDC balance: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      circleUnifiedBalance = await getCircleUnifiedBalance(
        executionWalletAddress,
        params.appKit,
      );
    } catch (err) {
      // Circle Unified Balance query failure is non-fatal for direct ERC20
      blockers.push(
        `Circle Unified Balance query issue: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!params.destination.recipient || !params.destination.recipient.startsWith("0x")) {
    blockers.push("Invalid destination recipient address");
  }

  if (params.requestedAmount.units <= BigInt(0)) {
    blockers.push("Requested amount must be greater than zero");
  }

  const sufficientWalletBalance =
    compareMoney(currentArcUsdcBalance, params.requestedAmount) >= 0;
  const sufficientUnifiedBalance =
    compareMoney(circleUnifiedBalance, params.requestedAmount) >= 0;

  // A Unified Balance deposit is required if the user wishes to spend via Unified Balance
  // but their available Unified Balance is less than requested amount.
  const requiresUnifiedBalanceDeposit = !sufficientUnifiedBalance;

  // For a direct test settlement on Arc Testnet, wallet balance must be sufficient.
  if (!sufficientWalletBalance) {
    blockers.push(
      `Insufficient Arc USDC wallet balance: available ${formatMoney(currentArcUsdcBalance)}, requested ${formatMoney(params.requestedAmount)}`,
    );
  }

  const readyForOneTestSettlement =
    blockers.length === 0 &&
    walletReady &&
    arcTestnetReachable &&
    sufficientWalletBalance;

  return {
    authenticatedSubject,
    executionWalletAddress,
    walletReady,
    arcTestnetReachable,
    currentWalletChain,
    targetChain,
    chainSupportedByPrivy,
    switchRequired,
    switchSucceeded,
    currentArcUsdcBalance,
    currentArcUsdcBalanceUnits: currentArcUsdcBalance.units.toString(),
    circleUnifiedBalance,
    circleUnifiedBalanceUnits: circleUnifiedBalance.units.toString(),
    destinationConfiguration: params.destination,
    requestedAmount: params.requestedAmount,
    sufficientWalletBalance,
    sufficientUnifiedBalance,
    requiresUnifiedBalanceDeposit,
    signing: false,
    transaction: "not_submitted",
    readyForOneTestSettlement,
    blockers,
    observedAt: now,
  };
}

/**
 * Prepares a deterministic settlement request from a verified preflight.
 * Never signs or submits.
 */
export function prepareSettlementRequest(
  preflight: CircleArcPreflightReport,
  operationType: CircleSettlementOperationType,
  maxFee = moneyZero(ARC_TESTNET_USDC_SYMBOL, ARC_TESTNET_USDC_DECIMALS),
): SettlementConfirmationParams {
  if (!preflight.readyForOneTestSettlement && operationType === "erc20_transfer") {
    throw new Error(
      `Cannot prepare settlement: ${preflight.blockers.join("; ")}`,
    );
  }

  if (!preflight.executionWalletAddress) {
    throw new Error("Missing execution wallet address");
  }

  return {
    sourceWallet: preflight.executionWalletAddress,
    recipient: preflight.destinationConfiguration.recipient,
    amount: preflight.requestedAmount,
    sourceChain: ARC_TESTNET_NAME,
    destinationChain: preflight.destinationConfiguration.chain,
    operationType,
    maxFee,
  };
}

export type ExecuteSettlementInput = Readonly<{
  params: SettlementConfirmationParams;
  provider: EIP1193Provider;
  publicClient?: PublicClient;
  appKit?: AppKit;
  onTxHashObserved?: (txHash: string) => void | Promise<void>;
  now?: string;
}>;

/**
 * Executes ONE manual testnet settlement after explicit human confirmation.
 * Returns normalized settlement evidence.
 */
export async function executeCircleSettlement(
  input: ExecuteSettlementInput,
): Promise<CircleSettlementEvidence> {
  const { params, provider } = input;
  const now = input.now ?? new Date().toISOString();

  // Validate provider active account matches source wallet
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];

  if (
    !accounts ||
    accounts.length === 0 ||
    accounts[0].toLowerCase() !== params.sourceWallet.toLowerCase()
  ) {
    throw new Error(
      `Active provider account (${accounts?.[0] ?? "none"}) does not match confirmed execution wallet (${params.sourceWallet})`,
    );
  }

  // Ensure on Arc Testnet
  await ensureArcTestnetChain(provider);

  const client = getArcPublicClient(input.publicClient);

  let txHash: string;

  if (params.operationType === "erc20_transfer") {
    // Direct standard ERC-20 transfer using the embedded wallet client
    const walletClient = createWalletClient({
      account: params.sourceWallet as `0x${string}`,
      chain: arcTestnetChain,
      transport: custom(provider),
    });

    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [params.recipient as `0x${string}`, params.amount.units],
    });

    txHash = await walletClient.sendTransaction({
      to: ARC_TESTNET_USDC_ADDRESS,
      data,
    });
  } else if (params.operationType === "unified_balance_deposit") {
    // Circle AppKit Unified Balance Deposit
    const appKit = input.appKit ?? new AppKit();
    const adapter = await createCircleAdapter(provider);

    // Format human-readable decimal amount for AppKit
    const amountStr = formatMoney(params.amount).replace(` ${params.amount.asset}`, "");

    const depositResult = await appKit.unifiedBalance.deposit({
      from: {
        adapter,
        chain: ARC_TESTNET_CHAIN_ENUM,
      },
      amount: amountStr,
      token: "USDC",
    });

    txHash = depositResult.txHash;
  } else if (params.operationType === "unified_balance_spend") {
    // Circle AppKit Unified Balance Spend
    const appKit = input.appKit ?? new AppKit();
    const adapter = await createCircleAdapter(provider);

    const amountStr = formatMoney(params.amount).replace(` ${params.amount.asset}`, "");

    const spendResult = await appKit.unifiedBalance.spend({
      from: {
        adapter,
        allocations: [
          {
            amount: amountStr,
            chain: ARC_TESTNET_CHAIN_ENUM,
          },
        ],
      },
      to: {
        adapter,
        chain: ARC_TESTNET_CHAIN_ENUM,
        recipientAddress: params.recipient,
      },
      amount: amountStr,
      token: "USDC",
    });

    txHash = spendResult.txHash;
  } else {
    throw new Error(`Unsupported operation type: ${String(params.operationType)}`);
  }

  // Persist tx hash immediately when known
  if (input.onTxHashObserved) {
    await input.onTxHashObserved(txHash);
  }

  // Wait for on-chain receipt confirmation
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash as Hash,
    timeout: 60_000,
  });

  const confirmedStatus = receipt.status === "success" ? "confirmed" : "reverted";

  return {
    executionWallet: params.sourceWallet,
    recipient: params.recipient,
    amount: params.amount,
    asset: "USDC",
    sourceChain: "Arc_Testnet",
    destinationChain: params.destinationChain,
    circleOperation: params.operationType,
    transactionHash: txHash,
    explorerUrl: `${ARC_TESTNET_EXPLORER_URL}/tx/${txHash}`,
    confirmedStatus,
    blockNumber: Number(receipt.blockNumber),
    timestamp: now,
    reconciliationSource: "onchain_receipt",
  };
}
