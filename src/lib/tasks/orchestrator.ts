import {
  assertMoney,
  createFinancialTask,
  createTaskPolicy,
  normalizeAsset,
  raiseDomainError,
  transitionTask,
  updateFinancialTaskDraft,
  type FinancialTask,
  type FinancialTaskDraftPatch,
  type TaskPolicy,
} from "../domain";
import type {
  FinancialIntentFields,
  FinancialIntentParseResult,
} from "../intent/types";
import { selectTaskPlanView, type TaskPlanView } from "./presentation";
import { LOCAL_PREVIEW_SERVICE_NETWORK } from "./runtime";
import { HEDERA_TESTNET_NETWORK } from "../services/wallet-activity-descriptor";
export const LOCAL_DRAFT_OWNER_ID = "local-preview-user";

export type OrchestrationOptions = Readonly<{
  ownerId?: string;
  ownerSubject?: string;
  ownerWalletAddress?: string;
  taskId?: string;
  existingTask?: FinancialTask;
  existingPolicy?: TaskPolicy;
  now?: string;
}>;

export type TaskOrchestrationResult = Readonly<
  | {
      kind: "clarification";
      parse: FinancialIntentParseResult;
      clarification: string;
      task?: FinancialTask;
      policy?: TaskPolicy;
      plan?: TaskPlanView;
    }
  | {
      kind: "planned";
      parse: FinancialIntentParseResult;
      task: FinancialTask;
      policy: TaskPolicy;
      plan: TaskPlanView;
    }
>;

function localId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
}

function requireOwnerId(ownerId: string): string {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    return raiseDomainError("P1_OWNER_REQUIRED", "owner id is required for task orchestration");
  }
  return ownerId.trim();
}

function validateFields(
  parse: FinancialIntentParseResult,
  fields: FinancialIntentFields,
): void {
  if (fields.paymentAmount) {
    assertMoney(fields.paymentAmount);
    if (fields.paymentAmount.asset !== "USDC") {
      raiseDomainError(
        "P1_UNSUPPORTED_PAYMENT_ASSET",
        "P1 supports USDC payments only",
      );
    }
  }
  if (fields.paymentAsset && normalizeAsset(fields.paymentAsset) !== "USDC") {
    if (parse.status === "ready") {
      raiseDomainError(
        "P1_UNSUPPORTED_PAYMENT_ASSET",
        "P1 supports USDC payments only",
      );
    }
  }
  if (fields.serviceBudget) {
    assertMoney(fields.serviceBudget);
    if (fields.serviceBudget.asset !== "USD") {
      raiseDomainError(
        "P1_INVALID_SERVICE_BUDGET",
        "service budgets must use USD policy units",
      );
    }
  }
  if (fields.perServiceCap) {
    assertMoney(fields.perServiceCap);
    if (
      fields.serviceBudget &&
      fields.perServiceCap.asset !== fields.serviceBudget.asset
    ) {
      raiseDomainError(
        "P1_INVALID_SERVICE_CAP",
        "per-service cap must use the service budget asset",
      );
    }
  }
  if (fields.type && fields.finalPaymentApprovalRequired !== undefined) {
    const expected = fields.type !== "delegate";
    if (fields.finalPaymentApprovalRequired !== expected) {
      raiseDomainError(
        "P1_APPROVAL_RULE_MISMATCH",
        "final payment approval cannot be relaxed by intent text",
      );
    }
  }
}
function requireReadyFields(
  parse: FinancialIntentParseResult,
  fields: FinancialIntentFields,
): void {
  if (parse.status !== "ready") return;
  if (
    parse.missing.length > 0 ||
    !fields.type ||
    parse.intentType !== fields.type
  ) {
    raiseDomainError(
      "P1_INVALID_INTENT_RESULT",
      "a ready intent must contain a complete, consistent task type",
    );
  }
  if (fields.type === "pay" || fields.type === "pay_with_check") {
    if (!fields.paymentAmount || !fields.recipient?.trim()) {
      raiseDomainError(
        "P1_INVALID_INTENT_RESULT",
        "a ready payment intent must contain an amount and recipient",
      );
    }
    if (fields.paymentAmount.units === BigInt(0)) {
      raiseDomainError(
        "P1_INVALID_INTENT_RESULT",
        "a payment amount must be greater than zero",
      );
    }
  }
  if (
    (fields.type === "pay_with_check" || fields.type === "delegate") &&
    !fields.serviceBudget
  ) {
    raiseDomainError(
      "P1_INVALID_INTENT_RESULT",
      "a service-backed intent must contain a service budget",
    );
  }
}

function policyAssets(fields: FinancialIntentFields): string[] {
  const assets: string[] = [];
  if (fields.paymentAmount?.asset === "USDC") assets.push("USDC");
  if (fields.serviceBudget?.asset === "USD") assets.push("USD");
  return [...new Set(assets)];
}

function policyCategories(fields: FinancialIntentFields): string[] {
  if (fields.type === "pay_with_check") return ["wallet-risk"];
  if (fields.type === "delegate") return ["research"];
  return [];
}

function makePolicy(
  taskId: string,
  fields: FinancialIntentFields,
): TaskPolicy {
  if (!fields.type) {
    return raiseDomainError(
      "P1_INVALID_INTENT_RESULT",
      "task type is required before creating a task policy",
    );
  }
  return createTaskPolicy({
    taskId,
    maxServiceSpend: fields.serviceBudget,
    maxPerService: fields.perServiceCap,
    allowedServiceCategories: policyCategories(fields),
    ...(fields.type === "pay_with_check" || fields.type === "delegate"
      ? {
          allowedServiceNetworks: [
            LOCAL_PREVIEW_SERVICE_NETWORK,
            HEDERA_TESTNET_NETWORK,
          ],
        }
      : {}),
    allowedAssets: policyAssets(fields),
    allowedNetworks: [],
    finalPaymentApprovalRequired: fields.type !== "delegate",
  });
}

function taskPatch(
  parse: FinancialIntentParseResult,
  fields: FinancialIntentFields,
  existingTask?: FinancialTask,
  options: OrchestrationOptions = {},
): FinancialTaskDraftPatch {
  const originalIntent =
    existingTask?.originalIntent ?? (parse.sourceText || undefined);
  const ownerSubject = options.ownerSubject ?? existingTask?.ownerSubject;
  const ownerWalletAddress =
    options.ownerWalletAddress ?? existingTask?.ownerWalletAddress;
  return {
    ...(ownerSubject ? { ownerSubject } : {}),
    ...(ownerWalletAddress ? { ownerWalletAddress } : {}),
    ...(originalIntent !== undefined ? { originalIntent } : {}),
    ...(fields.recipient !== undefined ? { recipient: fields.recipient } : {}),
    ...(fields.paymentAmount !== undefined
      ? { paymentAmount: fields.paymentAmount }
      : {}),
    ...(fields.purpose !== undefined ? { purpose: fields.purpose } : {}),
    ...(fields.serviceBudget !== undefined
      ? { serviceBudget: fields.serviceBudget }
      : {}),
    ...(fields.perServiceCap !== undefined
      ? { perServiceCap: fields.perServiceCap }
      : {}),
    ...(fields.finalPaymentApprovalRequired !== undefined
      ? { finalPaymentApprovalRequired: fields.finalPaymentApprovalRequired }
      : {}),
  };
}

function makeTask(
  parse: FinancialIntentParseResult,
  fields: FinancialIntentFields,
  options: OrchestrationOptions,
  now: string,
): FinancialTask {
  const existing = options.existingTask;
  if (existing?.status === "draft") {
    return updateFinancialTaskDraft(
      existing,
      taskPatch(parse, fields, existing, options),
      now,
    );
  }
  if (!fields.type) {
    return raiseDomainError(
      "P1_INVALID_INTENT_RESULT",
      "task type is required before creating a financial task",
    );
  }
  const ownerId = requireOwnerId(
    options.ownerId ?? options.ownerSubject ?? LOCAL_DRAFT_OWNER_ID,
  );
  return createFinancialTask(
    {
      id: options.taskId ?? localId("task"),
      ownerId,
      ...(options.ownerSubject ? { ownerSubject: options.ownerSubject } : {}),
      ...(options.ownerWalletAddress
        ? { ownerWalletAddress: options.ownerWalletAddress }
        : {}),
      type: fields.type,
      originalIntent: parse.sourceText || undefined,
      recipient: fields.recipient,
      paymentAmount: fields.paymentAmount,
      purpose: fields.purpose,
      serviceBudget: fields.serviceBudget,
      perServiceCap: fields.perServiceCap,
      finalPaymentApprovalRequired:
        fields.finalPaymentApprovalRequired ?? fields.type !== "delegate",
    },
    now,
  );
}

function fallbackClarification(parse: FinancialIntentParseResult): string {
  return parse.clarification ?? "Tell Omnis what needs to be paid or researched.";
}

export function orchestrateFinancialIntent(
  parse: FinancialIntentParseResult,
  options: OrchestrationOptions = {},
): TaskOrchestrationResult {
  if (
    options.existingTask &&
    options.existingPolicy &&
    options.existingTask.id !== options.existingPolicy.taskId
  ) {
    return raiseDomainError(
      "P1_POLICY_TASK_MISMATCH",
      "an existing task policy must belong to the existing task",
    );
  }
  validateFields(parse, parse.fields);
  const existingDraft = options.existingTask?.status === "draft";
  if (options.existingTask && !existingDraft && parse.intentType) {
    return {
      kind: "clarification",
      parse,
      clarification:
        "this planned task is locked. edit the task or start a new task before changing its policy.",
    };
  }
  if (!parse.intentType && !existingDraft) {
    return {
      kind: "clarification",
      parse,
      clarification: fallbackClarification(parse),
    };
  }

  const fields = parse.fields;
  const type = fields.type ?? (existingDraft ? options.existingTask?.type : undefined);
  if (!type) {
    return {
      kind: "clarification",
      parse,
      clarification: fallbackClarification(parse),
    };
  }
  const normalizedFields: FinancialIntentFields = {
    ...fields,
    type,
    finalPaymentApprovalRequired:
      fields.finalPaymentApprovalRequired ?? type !== "delegate",
  };
  requireReadyFields(parse, normalizedFields);
  const now = options.now ?? new Date().toISOString();
  const task = makeTask(parse, normalizedFields, options, now);
  const policy = makePolicy(task.id, normalizedFields);
  const plan = selectTaskPlanView(task, parse.missing);

  if (parse.status !== "ready") {
    return {
      kind: "clarification",
      parse,
      clarification: fallbackClarification(parse),
      task,
      policy,
      plan,
    };
  }

  const plannedTask =
    task.status === "draft" ? transitionTask(task, "planned", { now }) : task;
  const plannedPlan = selectTaskPlanView(plannedTask);
  return {
    kind: "planned",
    parse,
    task: plannedTask,
    policy,
    plan: plannedPlan,
  };
}
