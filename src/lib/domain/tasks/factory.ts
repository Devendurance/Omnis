import { raiseDomainError } from "../errors";
import { assertMoney } from "../money";
import {
  FINANCIAL_TASK_TYPES,
  type FinancialTask,
  type FinancialTaskType,
} from "../types";

export type CreateFinancialTaskInput = Omit<
  FinancialTask,
  "status" | "createdAt" | "updatedAt"
>;

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return raiseDomainError("INVALID_TASK", `${field} is required`);
  }
  return value.trim();
}

function requireTimestamp(value: string): string {
  return requireText(value, "timestamp");
}

export function createFinancialTask(
  input: CreateFinancialTaskInput,
  now = new Date().toISOString(),
): FinancialTask {
  const id = requireText(input.id, "task id");
  const ownerId = requireText(
    input.ownerId || input.ownerSubject || "",
    "task owner id",
  );
  const ownerSubject = input.ownerSubject?.trim() || undefined;
  const ownerWalletAddress = input.ownerWalletAddress?.trim() || undefined;
  if (!FINANCIAL_TASK_TYPES.includes(input.type as FinancialTaskType)) {
    return raiseDomainError("INVALID_TASK_TYPE", `unsupported task type: ${input.type}`);
  }
  if (typeof input.finalPaymentApprovalRequired !== "boolean") {
    return raiseDomainError(
      "INVALID_TASK",
      "final payment approval requirement must be explicit",
    );
  }
  if (input.paymentAmount) assertMoney(input.paymentAmount);
  if (input.serviceBudget) assertMoney(input.serviceBudget);
  if (input.perServiceCap) assertMoney(input.perServiceCap);
  const timestamp = requireTimestamp(now);
  return Object.freeze({
    ...input,
    id,
    ownerId,
    ...(ownerSubject ? { ownerSubject } : {}),
    ...(ownerWalletAddress ? { ownerWalletAddress } : {}),
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}
export type FinancialTaskDraftPatch = Partial<
  Pick<
    FinancialTask,
    | "type"
    | "ownerSubject"
    | "ownerWalletAddress"
    | "originalIntent"
    | "recipient"
    | "paymentAmount"
    | "purpose"
    | "serviceBudget"
    | "perServiceCap"
    | "finalPaymentApprovalRequired"
  >>;

export function updateFinancialTaskDraft(
  task: FinancialTask,
  patch: FinancialTaskDraftPatch,
  now = new Date().toISOString(),
): FinancialTask {
  if (task.status !== "draft") {
    return raiseDomainError(
      "TASK_DRAFT_UPDATE_NOT_ALLOWED",
      "only draft tasks can be updated during intent capture",
    );
  }
  const validated = createFinancialTask({ ...task, ...patch }, task.createdAt);
  const updatedAt = requireTimestamp(now);
  return Object.freeze({ ...validated, createdAt: task.createdAt, updatedAt });
}
