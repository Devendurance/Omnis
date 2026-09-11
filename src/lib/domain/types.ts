import type { Money } from "./money";

export const FINANCIAL_TASK_TYPES = [
  "pay",
  "pay_with_check",
  "delegate",
] as const;
export type FinancialTaskType = (typeof FINANCIAL_TASK_TYPES)[number];

export const FINANCIAL_TASK_STATUSES = [
  "draft",
  "planned",
  "running",
  "awaiting_approval",
  "settling",
  "completed",
  "failed",
  "cancelled",
] as const;
export type FinancialTaskStatus = (typeof FINANCIAL_TASK_STATUSES)[number];

export const POLICY_DECISIONS = ["ALLOW", "REQUIRE_APPROVAL", "DENY"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const SERVICE_PURCHASE_STATUSES = [
  "quoted",
  "approved",
  "paying",
  "paid",
  "failed",
  "cancelled",
] as const;
export type ServicePurchaseStatus = (typeof SERVICE_PURCHASE_STATUSES)[number];

export const SETTLEMENT_STATUSES = [
  "prepared",
  "awaiting_approval",
  "submitting",
  "submitted",
  "confirming",
  "confirmed",
  "confirmation_delayed",
  "reverted",
  "failed",
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const ARC_RECONCILIATION_STATES = [
  "HASH_RECORDED_CHAIN_VISIBLE",
  "HASH_RECORDED_RECEIPT_PENDING",
  "HASH_RECORDED_CHAIN_UNOBSERVED",
  "CONFIRMED",
  "REVERTED",
] as const;
export type ArcReconciliationState = (typeof ARC_RECONCILIATION_STATES)[number];

export const PROOF_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "demo_verified",
] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export type FinancialTask = Readonly<{
  id: string;
  ownerId: string;
  ownerSubject?: string;
  ownerWalletAddress?: string;
  type: FinancialTaskType;
  status: FinancialTaskStatus;
  originalIntent?: string;
  recipient?: string;
  paymentAmount?: Money;
  purpose?: string;
  serviceBudget?: Money;
  perServiceCap?: Money;
  finalPaymentApprovalRequired: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type TaskPolicy = Readonly<{
  taskId: string;
  maxServiceSpend?: Money;
  maxPerService?: Money;
  allowedServiceCategories: readonly string[];
  /** Networks available to service providers; settlement networks stay separate. */
  allowedServiceNetworks?: readonly string[];
  allowedAssets: readonly string[];
  allowedNetworks: readonly string[];
  finalPaymentApprovalRequired: boolean;
}>;

/** Environments describe where a service is configured to operate. */
export const SERVICE_ENVIRONMENTS = [
  "development",
  "testnet",
  "production",
] as const;
export type ServiceEnvironment = (typeof SERVICE_ENVIRONMENTS)[number];

export type ServiceResultObservation = Readonly<Record<string, unknown>>;

export type ServiceHeuristicFlag = Readonly<Record<string, unknown>>;

/** Trusted service output kept separate from explanatory heuristic flags. */
export type PersistedServiceResult = Readonly<{
  observations: ServiceResultObservation;
  heuristicFlags: readonly ServiceHeuristicFlag[];
  disclaimer?: string;
  requestId?: string;
}>;

export type ServicePurchaseRecoveryState = Readonly<{
  mode: "read_only_reconcile";
  stage: string;
  requestId: string;
  paymentIdentifier?: string;
  settlementNetwork?: string;
  settlementSent: boolean | "unknown";
  paymentSettled: boolean | "unknown";
  retryable: false;
  message: string;
}>;

export type ServiceDescriptor = Readonly<{
  id: string;
  name: string;
  capability: string;
  category: string;
  description: string;
  endpoint: string;
  /** The policy quote charged against the task service budget. */
  price: Money;
  /** The on-chain amount used when the service quote asset differs. */
  paymentAmount?: Money;
  network: string;
  paymentProtocol: "x402";
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
  /** Availability is configuration state; remote health is request-scoped. */
  status: "available" | "unavailable";
  /** Catalog-only entries are never treated as executable services. */
  environment: ServiceEnvironment;
  catalogOnly: boolean;
}>;

export type ServicePurchase = Readonly<{
  id: string;
  taskId: string;
  serviceId: string;
  quotedAmount: Money;
  /** The exact on-chain amount requested by the x402 service. */
  paymentAmount?: Money;
  paidAmount?: Money;
  requestId?: string;
  paymentIdentifier?: string;
  settlementNetwork?: string;
  serviceResult?: PersistedServiceResult;
  recoveryState?: ServicePurchaseRecoveryState;
  policySnapshot: TaskPolicy;
  status: ServicePurchaseStatus;
  resultDigest?: string;
  createdAt: string;
  updatedAt: string;
}>;


export const RECONCILIATION_SOURCE_TYPES = [
  "primary_rpc",
  "fallback_rpc",
  "blockscout_api",
] as const;
export type ReconciliationSourceType =
  (typeof RECONCILIATION_SOURCE_TYPES)[number];

export type ReconciliationProvenance = Readonly<{
  sourceType: ReconciliationSourceType;
  sourceName: string;
  primaryRpcObserved: boolean;
  fallbackObserved: boolean;
  verifiedAt: string;
  blockNumber: string;
  transactionHash: string;
  transactionFee?: string;
}>;

export type SettlementConfirmationEvidence = Readonly<{
  source: "reconciliation";
  transactionHash: string;
  outcome: "confirmed" | "reverted";
  observedAt: string;
  receiptReference?: string;
  provenance?: ReconciliationProvenance;
}>;

export type SettlementExecution = Readonly<{
  id: string;
  taskId: string;
  provider: string;
  amount: Money;
  requestedAmount?: Money;
  executionAmount?: Money;
  testMode?: boolean;
  recipient: string;
  network: string;
  approvalRequired: boolean;
  policySnapshot: TaskPolicy;
  status: SettlementStatus;
  transactionHash?: string;
  reconciliationState?: ArcReconciliationState;
  errorCode?: string;
  confirmationEvidence?: SettlementConfirmationEvidence;
  createdAt: string;
  updatedAt: string;
}>;


export type ApprovalServiceEvidence = Readonly<{
  paidPurchaseIds: readonly string[];
  paidTotal: Money;
}>;

export type ApprovalRecord = Readonly<{
  id: string;
  taskId: string;
  settlementExecutionId: string;
  approverId: string;
  walletAddress: string;
  amount: Money;
  requestedAmount?: Money;
  executionAmount?: Money;
  testMode?: boolean;
  asset: string;
  recipient: string;
  network: string;
  policySnapshot: TaskPolicy;
  decision: "approved";
  approvedAt: string;
  serviceEvidence?: ApprovalServiceEvidence;
}>;

export type OmnisProof = Readonly<{
  id: string;
  idempotencyKey: string;
  taskId: string;
  ownerId: string;
  createdAt: string;
  intent: unknown;
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  totalServiceSpend: Money;
  approval?: ApprovalRecord;
  finalPayment?: SettlementExecution;
  status: ProofStatus;
  testMode?: boolean;
  demoVerificationStatus?: "complete" | "not_executed" | "failed";
  originalPaymentDelivered?: boolean;
  reconciliationProvenance?: ReconciliationProvenance;
  /** Explanatory only. It never establishes payment or settlement truth. */
  agentSummary?: string;
}>;
