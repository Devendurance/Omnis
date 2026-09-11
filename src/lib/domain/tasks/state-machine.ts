import { raiseDomainError } from "../errors";
import { assertApprovalForTask } from "../approvals/factory";
import { assertServiceWorkComplete } from "../services/budget";
import {
  FINANCIAL_TASK_STATUSES,
  type ApprovalRecord,
  type FinancialTask,
  type FinancialTaskStatus,
  type ServicePurchase,
  type SettlementExecution,
  type TaskPolicy,
} from "../types";
const TASK_TRANSITIONS: Readonly<
  Record<FinancialTaskStatus, readonly FinancialTaskStatus[]>
> = {
  draft: ["planned", "cancelled"],
  planned: ["running", "failed", "cancelled"],
  running: [
    "awaiting_approval",
    "settling",
    "completed",
    "failed",
    "cancelled",
  ],
  awaiting_approval: ["settling", "failed", "cancelled"],
  settling: ["awaiting_approval", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export type TaskTransitionContext = Readonly<{
  approval?: ApprovalRecord;
  serviceWork?: Readonly<{
    policy: TaskPolicy;
    purchases: readonly ServicePurchase[];
  }>;
  settlement?: Pick<
    SettlementExecution,
    "status" | "transactionHash" | "confirmationEvidence"
  >;
  now?: string;
}>;

export function canTransitionTask(
  from: FinancialTaskStatus,
  to: FinancialTaskStatus,
): boolean {
  if (
    !FINANCIAL_TASK_STATUSES.includes(from) ||
    !FINANCIAL_TASK_STATUSES.includes(to)
  ) {
    return false;
  }
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTaskTerminal(status: FinancialTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function requireTaskTimestamp(value: string | undefined): string {
  if (value === undefined) return "";
  if (!value.trim()) {
    return raiseDomainError("INVALID_TASK_TIMESTAMP", "task transition timestamp is empty");
  }
  return value;
}

function requireCompletionEvidence(
  task: FinancialTask,
  nextStatus: FinancialTaskStatus,
  context: TaskTransitionContext,
): void {
  if (nextStatus === "awaiting_approval" && task.type === "pay_with_check") {
    if (context.serviceWork) {
      assertServiceWorkComplete(
        task,
        context.serviceWork.policy,
        context.serviceWork.purchases,
      );
    } else if (task.status !== "settling") {
      return raiseDomainError(
        "TASK_SERVICE_WORK_REQUIRED",
        "a checked payment can await approval only after service work is complete",
      );
    }
  }
  if (nextStatus === "settling" && task.type === "pay_with_check") {
    if (!context.serviceWork) {
      return raiseDomainError(
        "TASK_SERVICE_WORK_REQUIRED",
        "a checked payment can settle only after service work is complete",
      );
    }
    assertServiceWorkComplete(
      task,
      context.serviceWork.policy,
      context.serviceWork.purchases,
    );
  }

  if (nextStatus === "settling" && task.finalPaymentApprovalRequired) {
    if (!context.approval) {
      raiseDomainError(
        "TASK_APPROVAL_REQUIRED",
        "an approval record is required before this task can settle",
      );
    }
    assertApprovalForTask(context.approval, task.id);
  }
  if (nextStatus !== "completed") return;
  if (task.status === "running" && task.type === "delegate") {
    if (!context.serviceWork) {
      return raiseDomainError(
        "TASK_COMPLETION_REQUIRES_SERVICE_EVIDENCE",
        "a delegated task can complete only after persisted service evidence",
      );
    }
    assertServiceWorkComplete(
      task,
      context.serviceWork.policy,
      context.serviceWork.purchases,
    );
    return;
  }
  if (context.settlement?.status !== "confirmed") {
    raiseDomainError(
      "TASK_COMPLETION_REQUIRES_CONFIRMED_SETTLEMENT",
      "a task can complete only after settlement is confirmed",
    );
  }
  const settlement = context.settlement;
  const evidence = settlement.confirmationEvidence;
  if (
    !settlement.transactionHash ||
    !evidence ||
    evidence.source !== "reconciliation" ||
    evidence.outcome !== "confirmed" ||
    evidence.transactionHash !== settlement.transactionHash ||
    typeof evidence.observedAt !== "string" ||
    !evidence.observedAt.trim()
  ) {
    raiseDomainError(
      "TASK_COMPLETION_REQUIRES_TRUSTED_SETTLEMENT_EVIDENCE",
      "a task can complete only with trusted reconciliation evidence",
    );
  }
}

export function transitionTask(
  task: FinancialTask,
  nextStatus: FinancialTaskStatus,
  context: TaskTransitionContext = {},
): FinancialTask {
  if (!FINANCIAL_TASK_STATUSES.includes(nextStatus)) {
    return raiseDomainError(
      "INVALID_TASK_STATUS",
      `unsupported task status: ${nextStatus}`,
    );
  }
  if (!canTransitionTask(task.status, nextStatus)) {
    return raiseDomainError(
      "TASK_TRANSITION_NOT_ALLOWED",
      `cannot transition task from ${task.status} to ${nextStatus}`,
      { from: task.status, to: nextStatus },
    );
  }
  requireCompletionEvidence(task, nextStatus, context);
  const updatedAt = requireTaskTimestamp(context.now) || task.updatedAt;
  return Object.freeze({ ...task, status: nextStatus, updatedAt });
}

export function taskTransitions(): Readonly<
  Record<FinancialTaskStatus, readonly FinancialTaskStatus[]>
> {
  return TASK_TRANSITIONS;
}
