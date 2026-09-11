import type { FinancialIntentFields } from "../intent";
import type {
  ApprovalRecord,
  FinancialTask,
  Money,
  OmnisProof,
  ServicePurchase,
  SettlementExecution,
  TaskPolicy,
} from "../domain";
import type { TaskPlanView } from "./presentation";
export const TASK_SESSION_VERSION = 5 as const;
export const LEGACY_TASK_SESSION_VERSION = 4 as const;
export const EARLIER_TASK_SESSION_VERSION = 3 as const;
export const INITIAL_TASK_SESSION_VERSION = 2 as const;
export type TaskSessionVersion =
  | typeof TASK_SESSION_VERSION
  | typeof LEGACY_TASK_SESSION_VERSION
  | typeof EARLIER_TASK_SESSION_VERSION
  | typeof INITIAL_TASK_SESSION_VERSION;
export type TaskDiscoveryState = Readonly<{
  requiredCapability: string;
  selectedServiceId?: string;
  discoveredAt: string;
  registryVersion: string;
}>;

export type TaskBudgetSnapshot = Readonly<{
  taskId: string;
  configuredServiceBudget?: Money;
  confirmedSpend: Money;
  reservedSpend: Money;
  remainingAvailable: Money;
}>;

export type ChatMessageRole = "user" | "omnis";
export type ChatMessageKind = "message" | "clarification" | "plan";

export type ChatMessage = Readonly<{
  id: string;
  role: ChatMessageRole;
  kind: ChatMessageKind;
  content: string;
  plan?: TaskPlanView;
  createdAt: string;
}>;

export type TaskSession = Readonly<{
  version: TaskSessionVersion;
  ownerSubject?: string;
  ownerWalletAddress?: string;
  messages: readonly ChatMessage[];
  pendingIntent?: FinancialIntentFields;
  task?: FinancialTask;
  policy?: TaskPolicy;
  servicePurchases?: readonly ServicePurchase[];
  budget?: TaskBudgetSnapshot;
  discovery?: TaskDiscoveryState;
  approval?: ApprovalRecord;
  settlement?: SettlementExecution;
  proof?: OmnisProof;
}>;
