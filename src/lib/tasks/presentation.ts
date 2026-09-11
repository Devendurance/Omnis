import {
  serializeMoney,
  type FinancialTask,
  type FinancialTaskStatus,
  type FinancialTaskType,
  type SerializedMoney,
} from "../domain";
import type { IntentMissingField } from "../intent/types";

export type TaskPlanView = Readonly<{
  taskId: string;
  status: FinancialTaskStatus;
  type: FinancialTaskType;
  title: string;
  purpose?: string;
  recipient?: string;
  payment?: SerializedMoney;
  serviceBudget?: SerializedMoney;
  perServiceCap?: SerializedMoney;
  serviceRequirement: string;
  approvalBoundary: string;
  nextAction: string;
  missing: readonly IntentMissingField[];
}>;

function titleFor(type: FinancialTaskType): string {
  if (type === "pay_with_check") return "contractor payment";
  if (type === "delegate") return "delegated research";
  return "payment";
}

function purposeFor(task: FinancialTask): string | undefined {
  if (task.purpose) return task.purpose;
  if (task.type === "pay_with_check") return "wallet check before payment";
  if (task.type === "delegate") return "research task";
  return undefined;
}
function serviceRequirementFor(type: FinancialTaskType): string {
  if (type === "pay_with_check") return "wallet activity check before payment";
  if (type === "delegate") return "research service within budget";
  return "none in this task";
}

function nextActionFor(
  type: FinancialTaskType,
  missing: readonly IntentMissingField[],
): string {
  if (missing.length > 0) return "answer the clarification";
  if (type === "delegate") return "review the research boundary";
  return "review the plan before execution";
}


export function selectTaskPlanView(
  task: FinancialTask,
  missing: readonly IntentMissingField[] = [],
): TaskPlanView {
  return Object.freeze({
    taskId: task.id,
    status: task.status,
    type: task.type,
    title: titleFor(task.type),
    ...(purposeFor(task) ? { purpose: purposeFor(task) } : {}),
    ...(task.recipient ? { recipient: task.recipient } : {}),
    ...(task.paymentAmount
      ? { payment: serializeMoney(task.paymentAmount) }
      : {}),
    ...(task.serviceBudget
      ? { serviceBudget: serializeMoney(task.serviceBudget) }
      : {}),
    ...(task.perServiceCap
      ? { perServiceCap: serializeMoney(task.perServiceCap) }
      : {}),
    serviceRequirement: serviceRequirementFor(task.type),
    approvalBoundary: task.finalPaymentApprovalRequired
      ? "human approval required"
      : "no final payment in this task",
    nextAction: nextActionFor(task.type, missing),
    missing: Object.freeze([...missing]),
  });
}
