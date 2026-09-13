import {
  formatMoney,
  serializeMoney,
  type FinancialTask,
  type FinancialTaskStatus,
  type FinancialTaskType,
  type SerializedMoney,
  type ServicePurchase,
  type TaskPolicy,
} from "../domain";
import type { IntentMissingField } from "../intent/types";
import { resolveRequiredCapability } from "../services/capabilities";
import type { ServiceRegistry } from "../services/registry";
import { selectServiceCandidate } from "../services/selection";

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

function displayRecipientName(recipient?: string): string | undefined {
  const name = recipient?.trim();
  if (!name || name.length > 64) return undefined;
  if (/^0x/i.test(name)) return undefined;
  return name;
}

// Deterministic plan confirmation for the composer fallback path. Every fact
// comes from validated task and policy state; the recipient name is used only
// when task metadata already holds a non-address label, otherwise a neutral
// phrase keeps the copy honest. Never claims execution, recommendation, or
// purchase. Returns undefined when the task lacks the facts needed for a
// specific confirmation so the caller keeps the generic fallback.
export function buildPlanConfirmation(
  task: FinancialTask,
  policy?: TaskPolicy,
): string | undefined {
  const approvalRequired =
    task.finalPaymentApprovalRequired || policy?.finalPaymentApprovalRequired === true;
  if (task.type === "delegate") {
    const budget = policy?.maxServiceSpend ?? task.serviceBudget;
    if (!budget) return undefined;
    return (
      `Got it. I will start the research using up to $${formatMoney(budget)}.` +
      (approvalRequired ? " I will still need your approval before any spend." : "")
    );
  }
  const payment = task.paymentAmount;
  if (!payment) return undefined;
  const paymentText = `${formatMoney(payment)} ${payment.asset}`;
  const approvalClause = approvalRequired
    ? " will still require your approval."
    : " is planned.";
  if (task.type === "pay_with_check") {
    const budget = policy?.maxServiceSpend ?? task.serviceBudget;
    const name = displayRecipientName(task.recipient);
    const who = name ? `${name}'s` : "the recipient's";
    const budgetClause = budget ? `, using up to $${formatMoney(budget)} for the check` : "";
    return (
      `Got it. I will check ${who} wallet first${budgetClause}.` +
      ` The ${paymentText} payment${approvalClause}`
    );
  }
  const name = displayRecipientName(task.recipient);
  const who = name ?? "the recipient";
  return (
    `Got it. I will prepare the ${paymentText} payment for ${who}.` +
    (approvalRequired ? " It will still require your approval." : "")
  );
}

// Display-copy gate: true when the model copy already carries the validated
// plan facts: canonical amount plus asset (a bare number or a wrong asset
// such as HBAR for a USDC task fails), the USD service budget when the task
// has one, and a positive approval-required statement when final approval is
// required. Anything weaker, including fact-free lines such as
// "i can help you plan that", returns false so the caller prefers the
// deterministic confirmation. This selects display copy only; financial truth
// always comes from task and policy state.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Canonical amount source with an optional trailing zero ("0.1" also matches
// "0.10"), guarded by token boundaries so "10.1 USDC" never matches "0.1 USDC".
function amountSource(amount: string): string {
  const base = escapeRegExp(amount);
  const padded = /\.\d*[1-9]$/.test(amount) ? `${base}0?` : base;
  return `(?<!\\d|\\.)${padded}(?!\\d|\\.)`;
}

function amountAssetPattern(payment: FinancialTask["paymentAmount"] & {}): RegExp {
  return new RegExp(
    `${amountSource(formatMoney(payment))}\\s+${escapeRegExp(payment.asset)}(?![a-zA-Z])`,
    "i",
  );
}

function budgetPattern(budget: FinancialTask["serviceBudget"] & {}): RegExp {
  return new RegExp(`\\$${amountSource(formatMoney(budget))}(?!\\d|\\.)`);
}

const APPROVAL_REQUIRED_PATTERN =
  /\bapproval\b[^.]{0,40}\brequired\b|\brequired\b[^.]{0,40}\bapproval\b|\bstill requires?\b|\bneeds?\s+your\s+approval\b|\brequires?\s+your\s+approval\b/i;
const APPROVAL_NEGATED_PATTERN =
  /disapprov|approv\w*\s+(is\s+|was\s+)?not\b|not\s+requir|n't\s+requir|no\s+approv|without\s+approv/i;

function copyStatesApprovalRequired(copy: string): boolean {
  return APPROVAL_REQUIRED_PATTERN.test(copy) && !APPROVAL_NEGATED_PATTERN.test(copy);
}
export function modelCopyCarriesPlanFacts(
  copy: string,
  task: FinancialTask,
  policy?: TaskPolicy,
): boolean {
  if (task.type !== "delegate") {
    const payment = task.paymentAmount;
    if (payment && !amountAssetPattern(payment).test(copy)) return false;
  }
  const budget = policy?.maxServiceSpend ?? task.serviceBudget;
  if (budget && !budgetPattern(budget).test(copy)) return false;
  if (task.finalPaymentApprovalRequired || policy?.finalPaymentApprovalRequired === true) {
    if (!copyStatesApprovalRequired(copy)) return false;
  }
  return true;
}

// Plan-copy selection: a strong fact-bearing model message is preserved, any
// other model copy yields to the deterministic confirmation when available.
// Falls back to the model copy, then to the supplied generic text.
export function selectPlanConfirmation(input: {
  modelCopy?: string;
  task: FinancialTask;
  policy?: TaskPolicy;
  genericCopy: string;
}): string {
  const synthesized = buildPlanConfirmation(input.task, input.policy);
  if (
    input.modelCopy &&
    (synthesized === undefined ||
      modelCopyCarriesPlanFacts(input.modelCopy, input.task, input.policy))
  ) {
    return input.modelCopy;
  }
  return synthesized ?? input.modelCopy ?? input.genericCopy;
}

export const BUDGET_NOTE_CATALOG_ONLY = "Catalog-only. No service was purchased.";
export const BUDGET_NOTE_PRE_PURCHASE = "No service purchased yet.";

// Pre-purchase budget note. Catalog-only wording is used only when the caller
// knows no executable candidate exists; an unknown or executable-available
// state must never claim the task is catalog-only.
export function resolveBudgetPrePurchaseNote(hasExecutableService?: boolean): string {
  return hasExecutableService === false ? BUDGET_NOTE_CATALOG_ONLY : BUDGET_NOTE_PRE_PURCHASE;
}

// Display-only executable probe: true when the current registry offers a live
// (non-catalog, available) selectable candidate for the task. Reads the same
// deterministic selection as the discovery card but changes nothing about
// selection, eligibility, or execution.
export function hasExecutableServiceCandidate(input: {
  task: FinancialTask;
  policy: TaskPolicy;
  registry: ServiceRegistry;
  existingPurchases?: readonly ServicePurchase[];
}): boolean {
  const capability = resolveRequiredCapability(input.task);
  if (!capability) return false;
  const result = selectServiceCandidate({
    task: input.task,
    policy: input.policy,
    requiredCapability: capability,
    registry: input.registry,
    existingPurchases: input.existingPurchases ?? [],
  });
  // Any selectable live candidate counts: selection may legitimately prefer a
  // cheaper catalog entry while a live service stays available, and the task
  // is still not catalog-only.
  return result.discovery.selectableCandidates.some((candidate) => {
    const descriptor = candidate.descriptor;
    return (
      !descriptor.catalogOnly &&
      descriptor.environment !== "development" &&
      descriptor.status === "available"
    );
  });
}
