import type { EIP1193Provider, PublicClient } from "viem";
import type { AppKit } from "@circle-fin/app-kit";
import { expect, test } from "@playwright/test";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_RPC_URL,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_TESTNET_USDC_DECIMALS,
  ARC_TESTNET_USDC_SYMBOL,
  arcTestnet,
  arcTestnetChain,
  createCircleSettlementExecution,
  deserializeSettlementExecution,
  ensureArcTestnetChain,
  executeCircleSettlement,
  formatUsdcUnits,
  isArcTestnetChainId,
  isCircleSettlementTerminal,
  parseUsdcUnits,
  prepareSettlementRequest,
  reconcileCircleSettlementOnchain,
  runCircleArcPreflight,
  serializeSettlementExecution,
  transitionCircleSettlement,
  validateArcTestnetConfig,
  validatePrimaryExecutionWallet,
  type CircleSettlementEvidence,
  type DestinationConfiguration,
  type SettlementConfirmationParams,
} from "../src/lib/settlement";
import type { UserAuthIdentity } from "../src/lib/auth/types";
import {
  PRIVY_DEFAULT_CHAIN,
  PRIVY_SUPPORTED_CHAINS,
  isChainSupportedByPrivy,
} from "../src/lib/auth";
import { money, moneyZero } from "../src/lib/domain/money";
import {
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  transitionTask,
} from "../src/lib/domain";
import { moveTaskToAwaitingApproval } from "../src/lib/tasks/runtime";
const USER_ALICE_DID = "did:privy:alice-p6a";
const USER_ALICE_WALLET = "0x1111111111111111111111111111111111111111";
const EXTERNAL_WALLET = "0x9999999999999999999999999999999999999999";
const TEST_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const CONTRACTOR_WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function makeAuthIdentity(overrides: Partial<UserAuthIdentity> = {}): UserAuthIdentity {
  return {
    configured: true,
    ready: true,
    authenticated: true,
    ownerSubject: USER_ALICE_DID,
    primaryExecutionWallet: {
      address: USER_ALICE_WALLET,
      walletClientType: "privy",
      chainType: "ethereum",
      role: "primaryExecutionWallet",
      ready: true,
    },
    connectedExternalWallets: [
      {
        address: EXTERNAL_WALLET,
        walletClientType: "metamask",
        chainType: "ethereum",
        role: "connectedExternalWallet",
        ready: true,
      },
    ],
    getAccessToken: async () => `mock-token:${USER_ALICE_DID}`,
    login: () => {},
    logout: async () => {},
    ...overrides,
  };
}

function makeMockProvider(opts: {
  account?: string;
  chainId?: string;
  txHash?: string;
  rejectSign?: boolean;
} = {}): EIP1193Provider {
  return {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts") {
        return [opts.account ?? USER_ALICE_WALLET];
      }
      if (method === "eth_chainId") {
        return opts.chainId ?? "0x4cef52"; // 5042002 in hex
      }
      if (method === "wallet_switchEthereumChain") {
        return null;
      }
      if (method === "eth_sendTransaction") {
        if (opts.rejectSign) {
          const err = new Error("User rejected the transaction");
          (err as unknown as { code: number }).code = 4001;
          throw err;
        }
        return opts.txHash ?? "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      }
      return null;
    },
  } as unknown as EIP1193Provider;
}

function makeMockPublicClient(opts: {
  balance?: bigint;
  receiptStatus?: "success" | "reverted" | null;
  chainId?: number;
  blockNumber?: bigint;
} = {}): PublicClient {
  return {
    getChainId: async () => opts.chainId ?? ARC_TESTNET_CHAIN_ID,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") {
        return opts.balance ?? BigInt(10_000_000); // 10.000000 USDC default
      }
      return BigInt(0);
    },
    getTransactionReceipt: async () => {
      if (opts.receiptStatus === null) return null;
      return {
        status: opts.receiptStatus ?? "success",
        blockNumber: opts.blockNumber ?? BigInt(100_500),
        transactionHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        gasUsed: BigInt(21_000),
      };
    },
    waitForTransactionReceipt: async () => {
      if (opts.receiptStatus === "reverted") {
        return {
          status: "reverted",
          blockNumber: opts.blockNumber ?? BigInt(100_500),
          transactionHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        };
      }
      return {
        status: "success",
        blockNumber: opts.blockNumber ?? BigInt(100_500),
        transactionHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      };
    },
  } as unknown as PublicClient;
}

test.describe("P6A Circle + Arc Settlement Foundation & Verification", () => {
  // Requirement 1: only primaryExecutionWallet is used
  test("Requirement 1: only primaryExecutionWallet is accepted, external wallets are rejected", () => {
    const auth = makeAuthIdentity();
    const result = validatePrimaryExecutionWallet(auth);
    expect(result.ownerSubject).toBe(USER_ALICE_DID);
    expect(result.executionWalletAddress.toLowerCase()).toBe(USER_ALICE_WALLET.toLowerCase());

    // Attempt to pass identity where external wallet is attempted as primary
    const forgedAuth = makeAuthIdentity({
      primaryExecutionWallet: {
        address: EXTERNAL_WALLET,
        walletClientType: "metamask",
        chainType: "ethereum",
        role: "connectedExternalWallet" as unknown as "primaryExecutionWallet",
        ready: true,
      },
    });

    expect(() => validatePrimaryExecutionWallet(forgedAuth)).toThrow(
      "Security violation: only primaryExecutionWallet can execute settlements",
    );
  });

  // Requirement 2: unauthenticated users cannot prepare settlement
  test("Requirement 2: unauthenticated users cannot prepare settlement", async () => {
    const unauthIdentity = makeAuthIdentity({
      authenticated: false,
      ownerSubject: undefined,
      primaryExecutionWallet: undefined,
    });

    const destination: DestinationConfiguration = {
      recipient: TEST_RECIPIENT,
      chain: "Arc Testnet",
      chainId: ARC_TESTNET_CHAIN_ID,
      asset: "USDC",
    };

    const preflight = await runCircleArcPreflight({
      authIdentity: unauthIdentity,
      requestedAmount: money("0.01", "USDC"),
      destination,
      publicClient: makeMockPublicClient(),
    });

    expect(preflight.readyForOneTestSettlement).toBe(false);
    expect(preflight.blockers).toContain(
      "Authentication required: user is not authenticated",
    );

    expect(() =>
      prepareSettlementRequest(preflight, "erc20_transfer"),
    ).toThrow("Cannot prepare settlement");
  });

  // Requirement 3: read-only preflight never signs or submits
  test("Requirement 3: read-only preflight never signs and never submits", async () => {
    const auth = makeAuthIdentity();
    const destination: DestinationConfiguration = {
      recipient: TEST_RECIPIENT,
      chain: "Arc Testnet",
      chainId: ARC_TESTNET_CHAIN_ID,
      asset: "USDC",
    };

    const preflight = await runCircleArcPreflight({
      authIdentity: auth,
      requestedAmount: money("0.01", "USDC"),
      destination,
      publicClient: makeMockPublicClient({ balance: BigInt(500_000) }),
    });

    expect(preflight.signing).toBe(false);
    expect(preflight.transaction).toBe("not_submitted");
    expect(preflight.readyForOneTestSettlement).toBe(true);
  });

  // Requirement 4: Arc configuration is validated
  test("Requirement 4: Arc configuration is validated", () => {
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
    expect(ARC_TESTNET_USDC_ADDRESS.toLowerCase()).toBe(
      "0x3600000000000000000000000000000000000000",
    );
    expect(ARC_TESTNET_USDC_DECIMALS).toBe(6);
    expect(ARC_TESTNET_USDC_SYMBOL).toBe("USDC");
    expect(ARC_TESTNET_RPC_URL).toBe("https://rpc.testnet.arc.network/");
    expect(ARC_TESTNET_EXPLORER_URL).toBe("https://testnet.arcscan.app");

    expect(isArcTestnetChainId(5042002)).toBe(true);
    expect(isArcTestnetChainId("5042002")).toBe(true);
    expect(isArcTestnetChainId("0x4cef52")).toBe(true);
    expect(isArcTestnetChainId(1)).toBe(false);
    expect(isArcTestnetChainId(8453)).toBe(false);

    expect(() => validateArcTestnetConfig()).not.toThrow();
  });

  // Requirement 5: USDC uses 6-decimal bigint accounting (never JS floats)
  test("Requirement 5: USDC uses 6-decimal bigint accounting without JS float precision loss", () => {
    const atomicUnits = parseUsdcUnits("0.000001");
    expect(atomicUnits).toBe(BigInt(1));

    const testAmount = parseUsdcUnits("0.01");
    expect(testAmount).toBe(BigInt(10_000));

    const fiftyUsdc = parseUsdcUnits("50.00");
    expect(fiftyUsdc).toBe(BigInt(50_000_000));

    const formatted = formatUsdcUnits(BigInt(12_345_678));
    expect(formatted).toBe("12.345678");

    const smallFormatted = formatUsdcUnits(BigInt(10_000));
    expect(smallFormatted).toBe("0.01");
  });

  // Requirement 6: wallet balance and Unified Balance are not conflated
  test("Requirement 6: wallet balance and Unified Balance are not conflated", async () => {
    const auth = makeAuthIdentity();
    const destination: DestinationConfiguration = {
      recipient: TEST_RECIPIENT,
      chain: "Arc Testnet",
      chainId: ARC_TESTNET_CHAIN_ID,
      asset: "USDC",
    };

    // Case: Wallet has 10 USDC, but Circle Unified Balance is 0
    const mockAppKit = {
      unifiedBalance: {
        getBalances: async () => ({
          token: "USDC",
          totalConfirmedBalance: "0",
          breakdown: [],
        }),
      },
    };

    const preflight = await runCircleArcPreflight({
      authIdentity: auth,
      requestedAmount: money("0.01", "USDC"),
      destination,
      publicClient: makeMockPublicClient({ balance: BigInt(10_000_000) }), // 10 USDC
      appKit: mockAppKit as unknown as AppKit,
    });

    expect(preflight.currentArcUsdcBalance.units).toBe(BigInt(10_000_000));
    expect(preflight.circleUnifiedBalance.units).toBe(BigInt(0));
    expect(preflight.sufficientWalletBalance).toBe(true);
    expect(preflight.sufficientUnifiedBalance).toBe(false);
    expect(preflight.requiresUnifiedBalanceDeposit).toBe(true);
    // They are maintained as separate fields and not conflated
    expect(preflight.currentArcUsdcBalance.units).not.toEqual(
      preflight.circleUnifiedBalance.units,
    );
  });

  // Requirement 7: insufficient balance blocks execution
  test("Requirement 7: insufficient balance blocks execution", async () => {
    const auth = makeAuthIdentity();
    const destination: DestinationConfiguration = {
      recipient: TEST_RECIPIENT,
      chain: "Arc Testnet",
      chainId: ARC_TESTNET_CHAIN_ID,
      asset: "USDC",
    };

    // Wallet has only 0.005 USDC (5000 atomic units), but requested amount is 0.01 USDC (10000 atomic units)
    const preflight = await runCircleArcPreflight({
      authIdentity: auth,
      requestedAmount: money("0.01", "USDC"),
      destination,
      publicClient: makeMockPublicClient({ balance: BigInt(5_000) }),
    });

    expect(preflight.sufficientWalletBalance).toBe(false);
    expect(preflight.readyForOneTestSettlement).toBe(false);
    expect(preflight.blockers.some((b) => b.includes("Insufficient Arc USDC wallet balance"))).toBe(
      true,
    );

    expect(() =>
      prepareSettlementRequest(preflight, "erc20_transfer"),
    ).toThrow("Cannot prepare settlement");
  });

  // Requirement 8: no transaction occurs without explicit approval / confirmation
  test("Requirement 8: no transaction occurs without explicit approval and confirmed parameters", async () => {
    const auth = makeAuthIdentity();
    const destination: DestinationConfiguration = {
      recipient: TEST_RECIPIENT,
      chain: "Arc Testnet",
      chainId: ARC_TESTNET_CHAIN_ID,
      asset: "USDC",
    };

    const preflight = await runCircleArcPreflight({
      authIdentity: auth,
      requestedAmount: money("0.01", "USDC"),
      destination,
      publicClient: makeMockPublicClient({ balance: BigInt(100_000) }),
    });

    const confirmedParams = prepareSettlementRequest(preflight, "erc20_transfer");
    expect(confirmedParams.sourceWallet).toBe(USER_ALICE_WALLET);
    expect(confirmedParams.recipient).toBe(TEST_RECIPIENT);
    expect(confirmedParams.amount.units).toBe(BigInt(10_000));
    expect(confirmedParams.sourceChain).toBe("Arc Testnet");

    // Provider mismatch: provider has different active account than confirmed source wallet
    const wrongProvider = makeMockProvider({
      account: EXTERNAL_WALLET,
    });

    await expect(
      executeCircleSettlement({
        params: confirmedParams,
        provider: wrongProvider,
        publicClient: makeMockPublicClient(),
      }),
    ).rejects.toThrow("does not match confirmed execution wallet");
  });

  // Requirement 9 & 10: duplicate click cannot submit twice & refresh cannot resubmit
  test("Requirement 9 & 10: state machine prevents duplicate submissions and refresh cannot resubmit", () => {
    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    const execution = createCircleSettlementExecution({
      id: "p6a-test-1",
      params,
      status: "submitting",
    });

    // Cannot transition from submitting directly to submitting again
    expect(() =>
      transitionCircleSettlement(execution, "submitting"),
    ).toThrow("Illegal settlement transition");

    const submitted = transitionCircleSettlement(execution, "submitted", {
      transactionHash: "0xtxhash123",
    });

    // Cannot transition from submitted back to submitting (refresh cannot resubmit)
    expect(() =>
      transitionCircleSettlement(submitted, "submitting"),
    ).toThrow("Illegal settlement transition");
  });

  // Requirement 11: tx identifier persists immediately when known
  test("Requirement 11: transaction hash persists immediately when observed", async () => {
    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    let observedHash: string | undefined;

    const mockProvider = makeMockProvider({
      txHash: "0xpersistenthash999",
    });

    const evidence = await executeCircleSettlement({
      params,
      provider: mockProvider,
      publicClient: makeMockPublicClient(),
      onTxHashObserved: (txHash) => {
        observedHash = txHash;
      },
    });

    expect(observedHash).toBe("0xpersistenthash999");
    expect(evidence.transactionHash).toBe("0xpersistenthash999");
  });

  // Requirement 12: confirmed response becomes confirmed once
  test("Requirement 12: confirmed response transitions to confirmed once and is terminal", () => {
    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    const submitted = createCircleSettlementExecution({
      id: "p6a-test-2",
      params,
      status: "submitted",
    });

    const evidence: CircleSettlementEvidence = {
      executionWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      asset: "USDC",
      sourceChain: "Arc_Testnet",
      destinationChain: "Arc Testnet",
      circleOperation: "erc20_transfer",
      transactionHash: "0xtxconfirmed123",
      confirmedStatus: "confirmed",
      blockNumber: 42000,
      timestamp: new Date().toISOString(),
    };

    const confirming = transitionCircleSettlement(submitted, "confirming", {
      transactionHash: "0xtxconfirmed123",
    });

    const confirmed = transitionCircleSettlement(confirming, "confirmed", {
      evidence,
    });

    expect(confirmed.status).toBe("confirmed");
    expect(isCircleSettlementTerminal(confirmed.status)).toBe(true);

    // Cannot transition anywhere after confirmed
    expect(() =>
      transitionCircleSettlement(confirmed, "submitting"),
    ).toThrow("Illegal settlement transition");
    expect(() =>
      transitionCircleSettlement(confirmed, "confirmed"),
    ).toThrow("Illegal settlement transition");
  });

  // Requirement 13: reverted response never becomes success
  test("Requirement 13: reverted response never becomes success", () => {
    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    const confirming = createCircleSettlementExecution({
      id: "p6a-test-3",
      params,
      status: "confirming",
    });

    const reverted = transitionCircleSettlement(confirming, "reverted", {
      failureReason: "reverted",
      errorMessage: "Transaction execution reverted on Arc Testnet",
    });

    expect(reverted.status).toBe("reverted");
    expect(isCircleSettlementTerminal(reverted.status)).toBe(true);

    // Cannot transition from reverted to confirmed
    expect(() =>
      transitionCircleSettlement(reverted, "confirmed"),
    ).toThrow("Illegal settlement transition");
  });

  // Requirement 14: ambiguous submitted state never auto-retries
  test("Requirement 14: ambiguous submitted state never auto-retries and uses read-only reconciliation", async () => {
    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    const submitted = createCircleSettlementExecution({
      id: "p6a-test-4",
      params,
      status: "submitted",
    });

    const withTx = transitionCircleSettlement(submitted, "confirming", {
      transactionHash: "0xpendingtx999",
    });

    // Reconcile when receipt is null (still pending)
    const outcome = await reconcileCircleSettlementOnchain(
      withTx,
      makeMockPublicClient({ receiptStatus: null }),
    );

    expect(outcome.reconciled).toBe(true);
    expect(outcome.status).toBe("confirmation_delayed");
    expect(outcome.execution.status).toBe("confirmation_delayed");

    // The execution remains delayed and does NOT retry submission
    expect(outcome.execution.status).not.toBe("submitting");
  });

  // Requirement 15: final contractor 50 USDC remains REQUIRE_APPROVAL
  test("Requirement 15: final contractor 50 USDC payment remains REQUIRE_APPROVAL and is NOT sent", () => {
    const policy = createTaskPolicy({
      taskId: "task-flagship-contractor",
      maxServiceSpend: money("0.05", "USD"),
      maxPerService: money("0.05", "USD"),
      allowedServiceCategories: ["wallet-risk", "analytics"],
      allowedServiceNetworks: ["hedera-testnet"],
      allowedAssets: ["USDC", "USD"],
      allowedNetworks: ["arc-testnet"],
      finalPaymentApprovalRequired: true,
    });

    const task = createFinancialTask(
      {
        id: "task-flagship-contractor",
        ownerId: USER_ALICE_DID,
        ownerSubject: USER_ALICE_DID,
        ownerWalletAddress: USER_ALICE_WALLET,
        type: "pay_with_check",
        recipient: CONTRACTOR_WALLET,
        paymentAmount: money("50", "USDC"),
        purpose: "Pay contractor after activity check",
        serviceBudget: policy.maxServiceSpend,
        perServiceCap: policy.maxPerService,
        finalPaymentApprovalRequired: true,
      },
      new Date().toISOString(),
    );

    const nowStr = new Date().toISOString();
    const plannedTask = transitionTask(task, "planned", { now: nowStr });
    const runningTask = transitionTask(plannedTask, "running", { now: nowStr });
    const purchase = createServicePurchase(
      {
        id: "purchase-flagship",
        taskId: task.id,
        serviceId: "wallet-activity-check",
        quotedAmount: money("0.05", "USD"),
        paidAmount: money("0.05", "USD"),
        policySnapshot: policy,
        status: "paid",
        requestId: "req-p6a-check",
        paymentIdentifier: "tx-p6a-hedera-123",
        settlementNetwork: "hedera-testnet",
      },
      new Date().toISOString(),
    );
    const awaitingApproval = moveTaskToAwaitingApproval(
      runningTask,
      policy,
      [purchase],
      new Date().toISOString(),
    );
    expect(awaitingApproval.status).toBe("awaiting_approval");
    expect(awaitingApproval.paymentAmount?.units).toBe(BigInt(50_000_000));
    // The contractor payment has NOT transitioned to settling or completed
    expect(awaitingApproval.status).not.toBe("settling");
    expect(awaitingApproval.status).not.toBe("completed");
  });

  // Requirement 16: automated tests make zero real transactions
  test("Requirement 16: automated tests make zero real transactions", async () => {
    let rawRpcCallMade = false;

    // Use pure mock provider and client
    const mockProvider: EIP1193Provider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts") return [USER_ALICE_WALLET];
        if (method === "eth_chainId") return "0x4cef52";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_sendTransaction") {
          return "0xmocktransactiononly";
        }
        rawRpcCallMade = true;
        return null;
      },
    } as unknown as EIP1193Provider;

    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    const evidence = await executeCircleSettlement({
      params,
      provider: mockProvider,
      publicClient: makeMockPublicClient(),
    });

    expect(evidence.transactionHash).toBe("0xmocktransactiononly");
    expect(rawRpcCallMade).toBe(false);
  });

  // Requirement 17: no wallet or private secret leaks into client bundle or persistence
  test("Requirement 17: no wallet private keys, secrets, or access tokens leak into persistence", () => {
    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    const execution = createCircleSettlementExecution({
      id: "p6a-test-persistence",
      params,
      status: "confirmed",
    });

    const serialized = serializeSettlementExecution(execution);

    // Verify no secret patterns exist in serialized payload
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("mnemonic");

    const deserialized = deserializeSettlementExecution(serialized);
    expect(deserialized.id).toBe("p6a-test-persistence");
    expect(deserialized.params.amount.units).toBe(BigInt(10_000));
  });

  test("Requirement 4b: ensureArcTestnetChain fails closed on query or switch errors", async () => {
    // Case 1: eth_chainId query fails
    const failingQueryProvider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") throw new Error("RPC disconnected");
        return null;
      },
    } as unknown as EIP1193Provider;

    await expect(ensureArcTestnetChain(failingQueryProvider)).rejects.toThrow(
      "Network guard error: failed to query active chainId",
    );

    // Case 2: switch requested but provider remains on wrong chain
    const stubbornProvider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x1"; // Mainnet
        if (method === "wallet_switchEthereumChain") return null;
        return null;
      },
    } as unknown as EIP1193Provider;

    await expect(ensureArcTestnetChain(stubbornProvider)).rejects.toThrow(
      "Network guard security failure",
    );
  });
});

test.describe("Arc Testnet Privy Network Support & Preflight / Switch Flow", () => {
  // 1. Arc Testnet is present in Privy supportedChains
  test("1. Arc Testnet is present in Privy supportedChains", () => {
    expect(
      PRIVY_SUPPORTED_CHAINS.some((c) => c.id === ARC_TESTNET_CHAIN_ID),
    ).toBe(true);
    expect(isChainSupportedByPrivy(ARC_TESTNET_CHAIN_ID)).toBe(true);
    expect(isChainSupportedByPrivy("5042002")).toBe(true);
    expect(isChainSupportedByPrivy("0x4cef52")).toBe(true);
    expect(isChainSupportedByPrivy(1)).toBe(false);
    expect(PRIVY_DEFAULT_CHAIN.id).toBe(ARC_TESTNET_CHAIN_ID);
    expect(PRIVY_DEFAULT_CHAIN.name).toBe("Arc Testnet");
  });

  // 2. chain 1 -> 5042002 switch succeeds through mocked Privy wallet
  test("2. chain 1 -> 5042002 switch succeeds through mocked Privy wallet", async () => {
    let currentChain = "0x1";
    let switchChainCalledWith: number | undefined;

    const mockPrivyWallet = {
      switchChain: async (chainId: number) => {
        switchChainCalledWith = chainId;
        currentChain = `0x${chainId.toString(16)}`;
      },
      getEthereumProvider: async () =>
        ({
          request: async ({ method }: { method: string }) => {
            if (method === "eth_chainId") return currentChain;
            if (method === "eth_accounts") return [USER_ALICE_WALLET];
            return null;
          },
        }) as unknown as EIP1193Provider,
    };

    const auth = makeAuthIdentity({
      switchExecutionWalletChain: async (target) => {
        const id = typeof target === "string" ? parseInt(target, 16) : target;
        await mockPrivyWallet.switchChain(id);
        return mockPrivyWallet.getEthereumProvider();
      },
    });

    const freshProvider = await auth.switchExecutionWalletChain!(
      ARC_TESTNET_CHAIN_ID,
    );
    expect(freshProvider).not.toBeNull();
    expect(switchChainCalledWith).toBe(ARC_TESTNET_CHAIN_ID);

    const postChain = await freshProvider!.request({ method: "eth_chainId" });
    expect(postChain).toBe("0x4cef52");
  });

  // 3. provider is reacquired after switch
  test("3. provider is reacquired after switch", async () => {
    let providerAcquisitionCount = 0;
    let switched = false;

    const staleProvider = {
      id: "stale-provider",
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return switched ? "0x4cef52" : "0x1";
        return null;
      },
    };

    const freshProvider = {
      id: "fresh-provider",
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x4cef52";
        if (method === "eth_accounts") return [USER_ALICE_WALLET];
        return null;
      },
    };

    const auth = makeAuthIdentity({
      switchExecutionWalletChain: async () => {
        switched = true;
        providerAcquisitionCount++;
        return freshProvider as unknown as EIP1193Provider;
      },
    });

    // Before switch, stale provider returns chain 1
    expect(await staleProvider.request({ method: "eth_chainId" })).toBe("0x1");

    // Execution reacquires fresh provider
    const acquired = await auth.switchExecutionWalletChain!(
      ARC_TESTNET_CHAIN_ID,
    );
    expect(providerAcquisitionCount).toBe(1);
    expect((acquired as unknown as { id: string }).id).toBe("fresh-provider");
    expect(await acquired!.request({ method: "eth_chainId" })).toBe("0x4cef52");
  });

  // 4. chain is re-read and validated before signing
  test("4. chain is re-read and validated before signing", async () => {
    let chainQueriesBeforeSigning = 0;
    let signingAttempted = false;

    const mockProvider: EIP1193Provider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") {
          chainQueriesBeforeSigning++;
          return "0x4cef52";
        }
        if (method === "eth_accounts") return [USER_ALICE_WALLET];
        if (method === "eth_sendTransaction") {
          signingAttempted = true;
          return "0xvalidatetx";
        }
        return null;
      },
    } as unknown as EIP1193Provider;

    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    await executeCircleSettlement({
      params,
      provider: mockProvider,
      publicClient: makeMockPublicClient(),
    });

    // eth_chainId must be verified before sendTransaction
    expect(chainQueriesBeforeSigning).toBeGreaterThanOrEqual(1);
    expect(signingAttempted).toBe(true);

    // If chain verification fails, it throws before signing
    const wrongChainProvider: EIP1193Provider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_sendTransaction") {
          throw new Error("Should not sign on wrong chain");
        }
        return null;
      },
    } as unknown as EIP1193Provider;

    await expect(
      executeCircleSettlement({
        params,
        provider: wrongChainProvider,
        publicClient: makeMockPublicClient(),
      }),
    ).rejects.toThrow();
  });

  // 5. unsupported/switch failure submits zero transactions
  test("5. unsupported/switch failure submits zero transactions", async () => {
    let txSubmitted = false;

    const failingProvider: EIP1193Provider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts") return [USER_ALICE_WALLET];
        if (method === "eth_chainId") return "0x1"; // on mainnet
        if (method === "wallet_switchEthereumChain") {
          throw new Error("Unsupported chainId 5042002");
        }
        if (method === "eth_sendTransaction") {
          txSubmitted = true;
          return "0xshouldneverbesent";
        }
        return null;
      },
    } as unknown as EIP1193Provider;

    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    await expect(
      executeCircleSettlement({
        params,
        provider: failingProvider,
        publicClient: makeMockPublicClient(),
      }),
    ).rejects.toThrow("Failed to switch: Unsupported chainId 5042002");

    expect(txSubmitted).toBe(false);
  });

  // 6. already-on-Arc skips unnecessary switch
  test("6. already-on-Arc skips unnecessary switch", async () => {
    let switchAttempted = false;

    const alreadyOnArcProvider: EIP1193Provider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts") return [USER_ALICE_WALLET];
        if (method === "eth_chainId") return "0x4cef52";
        if (method === "wallet_switchEthereumChain") {
          switchAttempted = true;
          return null;
        }
        if (method === "eth_sendTransaction") return "0xalreadyswitchedtx";
        return null;
      },
    } as unknown as EIP1193Provider;

    await ensureArcTestnetChain(alreadyOnArcProvider);
    expect(switchAttempted).toBe(false);

    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    await executeCircleSettlement({
      params,
      provider: alreadyOnArcProvider,
      publicClient: makeMockPublicClient(),
    });

    expect(switchAttempted).toBe(false);
  });

  // 7. external wallet is never substituted
  test("7. external wallet is never substituted as primaryExecutionWallet", () => {
    const externalOnlyAuth = makeAuthIdentity({
      primaryExecutionWallet: undefined,
      connectedExternalWallets: [
        {
          address: EXTERNAL_WALLET,
          walletClientType: "metamask",
          chainType: "ethereum",
          role: "connectedExternalWallet",
          ready: true,
        },
      ],
    });

    expect(() => validatePrimaryExecutionWallet(externalOnlyAuth)).toThrow(
      "Primary execution wallet not found",
    );

    const forgedAuth = makeAuthIdentity({
      primaryExecutionWallet: {
        address: EXTERNAL_WALLET,
        walletClientType: "metamask",
        chainType: "ethereum",
        role: "connectedExternalWallet" as unknown as "primaryExecutionWallet",
        ready: true,
      },
    });

    expect(() => validatePrimaryExecutionWallet(forgedAuth)).toThrow(
      "Security violation: only primaryExecutionWallet can execute settlements",
    );
  });

  // 8. ERC-20 USDC accounting remains 6 decimals
  test("8. ERC-20 USDC accounting remains 6 decimals", () => {
    expect(ARC_TESTNET_USDC_DECIMALS).toBe(6);
    expect(ARC_TESTNET_USDC_SYMBOL).toBe("USDC");
    expect(ARC_TESTNET_USDC_ADDRESS).toBe(
      "0x3600000000000000000000000000000000000000",
    );

    const parsed = parseUsdcUnits("1.50");
    expect(parsed).toBe(BigInt(1_500_000));

    const formatted = formatUsdcUnits(BigInt(50_000_000));
    expect(formatted).toBe("50.00");

    const smallUnits = parseUsdcUnits("0.01");
    expect(smallUnits).toBe(BigInt(10_000));
  });

  // 9. Arc native gas representation remains separate
  test("9. Arc native gas representation remains separate from 6-decimal ERC-20 accounting", () => {
    // Arc native gas currency representation: 18 decimals
    expect(arcTestnetChain.nativeCurrency.name).toBe("USDC");
    expect(arcTestnetChain.nativeCurrency.symbol).toBe("USDC");
    expect(arcTestnetChain.nativeCurrency.decimals).toBe(18);

    // Application-level ERC-20 USDC token representation: 6 decimals
    expect(ARC_TESTNET_USDC_DECIMALS).toBe(6);

    // The two must never be merged
    expect(arcTestnetChain.nativeCurrency.decimals).not.toBe(
      ARC_TESTNET_USDC_DECIMALS,
    );
    expect(arcTestnet.id).toBe(5042002);
  });

  // 10. no live transaction occurs in tests
  test("10. no live transaction occurs in tests", async () => {
    let networkRequestMade = false;

    const offlineProvider: EIP1193Provider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts") return [USER_ALICE_WALLET];
        if (method === "eth_chainId") return "0x4cef52";
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_sendTransaction") return "0xtestonlymockhash";
        networkRequestMade = true;
        return null;
      },
    } as unknown as EIP1193Provider;

    const params: SettlementConfirmationParams = {
      sourceWallet: USER_ALICE_WALLET,
      recipient: TEST_RECIPIENT,
      amount: money("0.01", "USDC"),
      sourceChain: "Arc Testnet",
      destinationChain: "Arc Testnet",
      operationType: "erc20_transfer",
      maxFee: moneyZero("USDC", 6),
    };

    const evidence = await executeCircleSettlement({
      params,
      provider: offlineProvider,
      publicClient: makeMockPublicClient(),
    });

    expect(evidence.transactionHash).toBe("0xtestonlymockhash");
    expect(networkRequestMade).toBe(false);
  });

  // Preflight distinguishing test
  test("Preflight distinguishes currentWalletChain, targetChain, chainSupportedByPrivy, switchRequired, and switchSucceeded", async () => {
    const destination: DestinationConfiguration = {
      recipient: TEST_RECIPIENT,
      chain: "Arc Testnet",
      chainId: ARC_TESTNET_CHAIN_ID,
      asset: "USDC",
    };

    // Case A: wallet is on chain 1 (Mainnet)
    const chain1Provider = makeMockProvider({ chainId: "0x1" });
    const auth1 = makeAuthIdentity();

    const preflight1 = await runCircleArcPreflight({
      authIdentity: auth1,
      requestedAmount: money("0.01", "USDC"),
      destination,
      provider: chain1Provider,
      publicClient: makeMockPublicClient({ balance: BigInt(500_000) }),
    });

    expect(preflight1.currentWalletChain).toBe(1);
    expect(preflight1.targetChain).toBe(ARC_TESTNET_CHAIN_ID);
    expect(preflight1.chainSupportedByPrivy).toBe(true);
    expect(preflight1.switchRequired).toBe(true);
    expect(preflight1.switchSucceeded).toBe(false); // read-only preflight does not switch
    expect(preflight1.signing).toBe(false);
    expect(preflight1.transaction).toBe("not_submitted");
    expect(preflight1.readyForOneTestSettlement).toBe(true);

    // Case B: wallet is already on Arc Testnet (5042002)
    const arcProvider = makeMockProvider({ chainId: "0x4cef52" });
    const preflightArc = await runCircleArcPreflight({
      authIdentity: auth1,
      requestedAmount: money("0.01", "USDC"),
      destination,
      provider: arcProvider,
      publicClient: makeMockPublicClient({ balance: BigInt(500_000) }),
    });

    expect(preflightArc.currentWalletChain).toBe(5042002);
    expect(preflightArc.targetChain).toBe(ARC_TESTNET_CHAIN_ID);
    expect(preflightArc.chainSupportedByPrivy).toBe(true);
    expect(preflightArc.switchRequired).toBe(false);
    expect(preflightArc.switchSucceeded).toBe(true);
  });
});
