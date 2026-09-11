import type { Money } from "../../domain/money";

export type CircleSettlementOperationType =
  | "erc20_transfer"
  | "unified_balance_deposit"
  | "unified_balance_spend";

export type CircleSettlementExecutionStatus =
  | "prepared"
  | "awaiting_approval"
  | "submitting"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "confirmation_delayed"
  | "reverted"
  | "failed";

export type CircleSettlementFailureReason =
  | "failure_before_signature"
  | "signature_rejected"
  | "submitted_with_tx"
  | "confirmation_delayed"
  | "reverted"
  | "unknown_outcome_after_submission"
  | "insufficient_balance"
  | "unauthorized_wallet"
  | "invalid_network"
  | "contract_error";

export type DestinationConfiguration = Readonly<{
  recipient: string;
  chain: string;
  chainId: number;
  asset: "USDC";
}>;

export type CircleArcPreflightReport = Readonly<{
  authenticatedSubject?: string;
  executionWalletAddress?: string;
  walletReady: boolean;
  arcTestnetReachable: boolean;
  currentWalletChain?: number;
  targetChain: number;
  chainSupportedByPrivy: boolean;
  switchRequired: boolean;
  switchSucceeded: boolean;
  currentArcUsdcBalance: Money;
  currentArcUsdcBalanceUnits: string;
  circleUnifiedBalance: Money;
  circleUnifiedBalanceUnits: string;
  destinationConfiguration: DestinationConfiguration;
  requestedAmount: Money;
  sufficientWalletBalance: boolean;
  sufficientUnifiedBalance: boolean;
  requiresUnifiedBalanceDeposit: boolean;
  signing: false;
  transaction: "not_submitted";
  readyForOneTestSettlement: boolean;
  blockers: readonly string[];
  observedAt: string;
}>;

export type SettlementConfirmationParams = Readonly<{
  sourceWallet: string;
  recipient: string;
  amount: Money;
  sourceChain: string;
  destinationChain: string;
  operationType: CircleSettlementOperationType;
  maxFee: Money;
}>;

export type CircleSettlementEvidence = Readonly<{
  executionWallet: string;
  recipient: string;
  amount: Money;
  asset: "USDC";
  sourceChain: "Arc_Testnet";
  destinationChain: string;
  circleOperation: CircleSettlementOperationType;
  transactionHash: string;
  explorerUrl?: string;
  confirmedStatus: "confirmed" | "reverted";
  blockNumber?: number;
  timestamp: string;
  reconciliationSource?: "onchain_receipt" | "circle_sdk";
}>;

export type CircleSettlementExecution = Readonly<{
  id: string;
  taskId?: string;
  operationType: CircleSettlementOperationType;
  params: SettlementConfirmationParams;
  status: CircleSettlementExecutionStatus;
  transactionHash?: string;
  failureReason?: CircleSettlementFailureReason;
  errorMessage?: string;
  evidence?: CircleSettlementEvidence;
  submittedAt?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}>;
