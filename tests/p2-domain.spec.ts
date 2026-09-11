import { expect, test } from "@playwright/test";
import {
  DomainError,
  POLICY_REASON_CODES,
  createFinancialTask,
  createServiceDescriptor,
  createTaskPolicy,
  formatMoney,
  money,
  transitionTask,
  type FinancialTask,
  type ServicePurchase,
  type TaskPolicy,
} from "../src/lib/domain";
import {
  beginTaskExecution,
  completeDelegateTask,
  evaluateFinalPayment,
  evaluateServiceSpend,
  getTaskBudgetState,
  markServicePurchaseFailed,
  markServicePurchasePaid,
  markServicePurchasePaying,
  moveTaskToAwaitingApproval,
  authorizeServiceSpend,
} from "../src/lib/tasks/runtime";
import {
  hydrateDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import { TASK_SESSION_VERSION, type TaskSession } from "../src/lib/tasks/session";
import { orchestrateFinancialIntent } from "../src/lib/tasks/orchestrator";
import { parseFinancialIntent } from "../src/lib/intent";

const NOW = "2026-09-07T12:00:00.000Z";
const NETWORK = "local-preview";
const RECIPIENT = "0x1234567890abcdef";

function expectDomainError(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}

function makePolicy(
  taskId = "task-p2",
  overrides: Partial<TaskPolicy> = {},
): TaskPolicy {
  return createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [NETWORK],
    allowedAssets: ["USD", "USDC"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
    ...overrides,
  });
}

function makeTask(
  policy = makePolicy(),
  type: "pay_with_check" | "delegate" = "pay_with_check",
): FinancialTask {
  return createFinancialTask(
    {
      id: policy.taskId,
      ownerId: "owner-p2",
      type,
      originalIntent: "P2 bounded task",
      ...(type === "pay_with_check"
        ? {
            recipient: RECIPIENT,
            paymentAmount: money("50", "USDC"),
            purpose: "contractor payment",
            finalPaymentApprovalRequired: true,
          }
        : { finalPaymentApprovalRequired: false }),
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
    },
    NOW,
  );
}

function makeService(
  overrides: Partial<Parameters<typeof createServiceDescriptor>[0]> = {},
) {
  return createServiceDescriptor({
    id: "wallet-risk-service",
    name: "wallet risk service",
    capability: "wallet risk check",
    category: "wallet-risk",
    description: "service descriptor used by deterministic tests",
    endpoint: "https://example.test/wallet-risk",
    price: money("0.05", "USD"),
    network: NETWORK,
    paymentProtocol: "x402",
    inputSchema: {},
    outputSchema: {},
    ...overrides,
  });
}

function runningTask(
  task = makeTask(),
  policy = makePolicy(task.id),
): { task: FinancialTask; policy: TaskPolicy } {
  const planned = transitionTask(task, "planned", { now: NOW });
  return { task: beginTaskExecution(planned, policy, NOW), policy };
}

function authorizeOne(
  task: FinancialTask,
  policy: TaskPolicy,
  quote = "0.003",
  existingPurchases: readonly ServicePurchase[] = [],
): ServicePurchase {
  const result = authorizeServiceSpend({
    task,
    policy,
    service: makeService(),
    quotedPrice: money(quote, "USD"),
    existingPurchases,
  });
  expect(result.decision).toBe("ALLOW");
  expect(result.purchase).toBeDefined();
  return result.purchase!;
}

test.describe("P2 bounded budget runtime", () => {
  test("allows a three-mil quote inside the five-cent budget", () => {
    const { task, policy } = runningTask();
    const result = evaluateServiceSpend({
      task,
      policy,
      service: makeService(),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [],
    });

    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.ALLOW_WITHIN_SERVICE_BUDGET,
    );
    expect(formatMoney(result.requestedAmount)).toBe("0.003");
    expect(formatMoney(result.remainingBefore)).toBe("0.05");
    expect(formatMoney(result.remainingAfter)).toBe("0.047");
  });

  test("authorization creates an approved reservation", () => {
    const { task, policy } = runningTask();
    const result = authorizeServiceSpend({
      task,
      policy,
      service: makeService(),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [],
    });

    expect(result.decision).toBe("ALLOW");
    expect(result.purchase?.status).toBe("approved");
    expect(formatMoney(result.reservedSpend)).toBe("0.003");
  });

  test("repeated authorization returns the same reservation", () => {
    const { task, policy } = runningTask();
    const first = authorizeServiceSpend({
      task,
      policy,
      service: makeService(),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [],
      purchaseId: "stable-authorization",
    });
    const replayed = authorizeServiceSpend({
      task,
      policy,
      service: makeService(),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [first.purchase!],
      purchaseId: "stable-authorization",
    });

    expect(replayed.decision).toBe("ALLOW");
    expect(replayed.reasonCode).toBe(
      POLICY_REASON_CODES.ALLOW_SERVICE_SPEND_ALREADY_AUTHORIZED,
    );
    expect(replayed.purchase).toBe(first.purchase);
    expect(formatMoney(replayed.reservedSpend)).toBe("0.003");
  });

  test("remaining budget reflects a reserved three-mil purchase", () => {
    const { task, policy } = runningTask();
    const purchase = authorizeOne(task, policy);
    const state = getTaskBudgetState(task, policy, [purchase]);

    expect(formatMoney(state.configuredServiceBudget!)).toBe("0.05");
    expect(formatMoney(state.confirmedSpend)).toBe("0");
    expect(formatMoney(state.reservedSpend)).toBe("0.003");
    expect(formatMoney(state.remainingAvailable)).toBe("0.047");
  });

  test("reserved purchases prevent two requests from oversubscribing the budget", () => {
    const { task, policy } = runningTask();
    const first = authorizeOne(task, policy, "0.003");
    const second = authorizeServiceSpend({
      task,
      policy,
      service: makeService(),
      quotedPrice: money("0.048", "USD"),
      existingPurchases: [first],
    });

    expect(second.decision).toBe("DENY");
    expect(second.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_TOTAL_BUDGET_EXCEEDED,
    );
    expect(second.purchase).toBeUndefined();
  });

  test("paid converts reservation to confirmed spend once", () => {
    const { task, policy } = runningTask();
    const approved = authorizeOne(task, policy);
    const paying = markServicePurchasePaying(approved, NOW);
    const paid = markServicePurchasePaid(
      paying,
      money("0.003", "USD"),
      "service-payment-1",
      NOW,
    );
    const state = getTaskBudgetState(task, policy, [paid]);

    expect(formatMoney(state.confirmedSpend)).toBe("0.003");
    expect(formatMoney(state.reservedSpend)).toBe("0");
    expect(formatMoney(state.remainingAvailable)).toBe("0.047");
  });

  test("failed purchase releases its reservation", () => {
    const { task, policy } = runningTask();
    const approved = authorizeOne(task, policy);
    const failed = markServicePurchaseFailed(approved, NOW);
    const state = getTaskBudgetState(task, policy, [failed]);

    expect(failed.status).toBe("failed");
    expect(formatMoney(state.reservedSpend)).toBe("0");
    expect(formatMoney(state.remainingAvailable)).toBe("0.05");
  });

  test("denied authorization creates no reservation or purchase", () => {
    const { task, policy } = runningTask();
    const result = authorizeServiceSpend({
      task,
      policy,
      service: makeService({ category: "identity" }),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [],
    });

    expect(result.decision).toBe("DENY");
    expect(result.purchase).toBeUndefined();
    expect(formatMoney(result.reservedSpend)).toBe("0");
  });

  test("replaying paid transition is idempotent", () => {
    const { task, policy } = runningTask();
    const approved = authorizeOne(task, policy);
    const paid = markServicePurchasePaid(
      markServicePurchasePaying(approved, NOW),
      money("0.003", "USD"),
      "service-payment-1",
      NOW,
    );
    const replayed = markServicePurchasePaid(paid);

    expect(replayed).toBe(paid);
    expect(formatMoney(getTaskBudgetState(task, policy, [replayed]).confirmedSpend)).toBe(
      "0.003",
    );
    expectDomainError(
      () => markServicePurchasePaid(paid, money("0.004", "USD"), "service-payment-1"),
      "SERVICE_PURCHASE_IDEMPOTENCY_CONFLICT",
    );
  });

  test("refresh hydration preserves paid entries without double counting", () => {
    const { task, policy } = runningTask();
    const paid = markServicePurchasePaid(
      markServicePurchasePaying(authorizeOne(task, policy), NOW),
      money("0.003", "USD"),
      "service-payment-1",
      NOW,
    );
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      messages: [],
      task,
      policy,
      servicePurchases: [paid],
    };
    const hydrated = hydrateDraftSession(serializeDraftSession(session));

    expect(hydrated?.servicePurchases).toHaveLength(1);
    expect(
      formatMoney(
        getTaskBudgetState(
          hydrated!.task!,
          hydrated!.policy!,
          hydrated!.servicePurchases!,
        ).confirmedSpend,
      ),
    ).toBe("0.003");
    expectDomainError(
      () => getTaskBudgetState(task, policy, [paid, paid]),
      "DUPLICATE_SERVICE_PURCHASE_ID",
    );
  });

  test("per-service cap is enforced before authorization", () => {
    const policy = makePolicy("task-cap", { maxPerService: money("0.002", "USD") });
    const { task } = runningTask(makeTask(policy), policy);
    const result = authorizeServiceSpend({
      task,
      policy,
      service: makeService(),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [],
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_PER_SERVICE_CAP_EXCEEDED,
    );
  });

  test("total budget is enforced independently of the per-service cap", () => {
    const policy = makePolicy("task-total", { maxPerService: money("0.10", "USD") });
    const { task } = runningTask(makeTask(policy), policy);
    const result = authorizeServiceSpend({
      task,
      policy,
      service: makeService({ price: money("0.051", "USD") }),
      quotedPrice: money("0.051", "USD"),
      existingPurchases: [],
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_TOTAL_BUDGET_EXCEEDED,
    );
  });

  test("category and service network policy denials are enforced", () => {
    const { task, policy } = runningTask();
    const category = evaluateServiceSpend({
      task,
      policy,
      service: makeService({ category: "identity" }),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [],
    });
    const network = evaluateServiceSpend({
      task,
      policy,
      service: makeService({ network: "other-network" }),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [],
    });

    expect(category.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_SERVICE_CATEGORY_NOT_ALLOWED,
    );
    expect(network.reasonCode).toBe(POLICY_REASON_CODES.DENY_NETWORK_NOT_ALLOWED);
  });

  test("flagship final payment returns structured REQUIRE_APPROVAL", () => {
    const policy = makePolicy();
    const task = transitionTask(makeTask(policy), "planned", { now: NOW });
    const result = evaluateFinalPayment({ task, policy });

    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.REQUIRE_FINAL_PAYMENT_APPROVAL,
    );
    expect(formatMoney(result.amount)).toBe("50");
    expect(result.asset).toBe("USDC");
    expect(result.recipient).toBe(RECIPIENT);
    expect(result.network).toBeUndefined();
    expect(result.approvalRequired).toBe(true);
  });
  test("final payment still denies a disallowed settlement network", () => {
    const policy = makePolicy();
    const task = transitionTask(makeTask(policy), "planned", { now: NOW });
    const result = evaluateFinalPayment({
      task,
      policy,
      network: "other-network",
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe(POLICY_REASON_CODES.DENY_NETWORK_NOT_ALLOWED);
    expect(result.approvalRequired).toBe(false);
  });

  test("payment tasks cannot disable the final approval rule", () => {
    const policy = makePolicy("task-invalid-approval", {
      maxServiceSpend: undefined,
      maxPerService: undefined,
      finalPaymentApprovalRequired: false,
    });
    const task = createFinancialTask(
      {
        id: policy.taskId,
        ownerId: "owner-p2",
        type: "pay",
        recipient: RECIPIENT,
        paymentAmount: money("50", "USDC"),
        purpose: "contractor payment",
        finalPaymentApprovalRequired: false,
      },
      NOW,
    );
    const result = evaluateFinalPayment({ task, policy });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_FINAL_PAYMENT_APPROVAL_RULE_INVALID,
    );
  });

  test("a denied service result cannot be promoted by an agent or UI", () => {
    const { task, policy } = runningTask();
    const denied = authorizeServiceSpend({
      task,
      policy,
      service: makeService({ status: "unavailable" }),
      quotedPrice: money("0.003", "USD"),
      existingPurchases: [],
    });

    expect(denied.decision).toBe("DENY");
    expect(denied.purchase).toBeUndefined();
    expect(denied.reasonCode).toBe(POLICY_REASON_CODES.DENY_SERVICE_UNAVAILABLE);
  });

  test("planned tasks enter running only through the runtime boundary", () => {
    const policy = makePolicy();
    const planned = transitionTask(makeTask(policy), "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);

    expect(planned.status).toBe("planned");
    expect(running.status).toBe("running");
    expect(beginTaskExecution(running, policy, NOW)).toBe(running);
    expectDomainError(
      () => transitionTask(planned, "awaiting_approval"),
      "TASK_TRANSITION_NOT_ALLOWED",
    );
  });

  test("pay-with-check cannot await approval before paid service evidence", () => {
    const policy = makePolicy();
    const planned = transitionTask(makeTask(policy), "planned", { now: NOW });
    const running = beginTaskExecution(planned, policy, NOW);

    expectDomainError(
      () => moveTaskToAwaitingApproval(running, policy, [], NOW),
      "TASK_SERVICE_WORK_INCOMPLETE",
    );
    const paid = markServicePurchasePaid(
      markServicePurchasePaying(authorizeOne(running, policy), NOW),
      money("0.003", "USD"),
      "service-payment-approval",
      NOW,
    );
    expect(moveTaskToAwaitingApproval(running, policy, [paid], NOW).status).toBe(
      "awaiting_approval",
    );
  });

  test("delegate completion requires persisted service evidence", () => {
    const policy = makePolicy("task-delegate", {
      finalPaymentApprovalRequired: false,
    });
    const { task, policy: activePolicy } = runningTask(
      makeTask(policy, "delegate"),
      policy,
    );
    expectDomainError(
      () => completeDelegateTask(task, activePolicy, [], NOW),
      "TASK_SERVICE_WORK_INCOMPLETE",
    );
    const paid = markServicePurchasePaid(
      markServicePurchasePaying(authorizeOne(task, activePolicy), NOW),
      money("0.003", "USD"),
      "service-payment-delegate",
      NOW,
    );
    expect(completeDelegateTask(task, activePolicy, [paid], NOW).status).toBe(
      "completed",
    );
  });

  test("planning locks policy mutation until an explicit reset", () => {
    const first = orchestrateFinancialIntent(
      parseFinancialIntent(`Pay 50 USDC to ${RECIPIENT}.`),
      { ownerId: "owner-lock", taskId: "task-lock", now: NOW },
    );
    expect(first.kind).toBe("planned");
    if (first.kind !== "planned") throw new Error("expected planned task");

    const changed = orchestrateFinancialIntent(
      parseFinancialIntent(`Pay 99 USDC to ${RECIPIENT}.`),
      {
        existingTask: first.task,
        existingPolicy: first.policy,
        now: NOW,
      },
    );

    expect(changed.kind).toBe("clarification");
    if (changed.kind !== "clarification") throw new Error("expected locked task");
    expect(changed.task).toBeUndefined();
    expect(changed.policy).toBeUndefined();
    expect(first.task.paymentAmount && formatMoney(first.task.paymentAmount)).toBe("50");
    expect(first.policy.maxServiceSpend).toBeUndefined();
  });

  test("persistence rejects duplicate or malformed P2 purchase records", () => {
    const policy = makePolicy("task-corrupt");
    const { task } = runningTask(makeTask(policy), policy);
    const paid = markServicePurchasePaid(
      markServicePurchasePaying(authorizeOne(task, policy), NOW),
      money("0.003", "USD"),
      "service-payment-corrupt",
      NOW,
    );
    const session = {
      version: TASK_SESSION_VERSION,
      messages: [],
      task,
      policy,
      servicePurchases: [paid, paid],
    } satisfies TaskSession;
    expect(hydrateDraftSession(serializeWithoutValidation(session))).toBeNull();
  });
});

function serializeWithoutValidation(session: TaskSession): string {
  const raw = serializeDraftSessionWithoutPurchases(session);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.servicePurchases = session.servicePurchases?.map((purchase) => ({
    ...purchase,
    quotedAmount: {
      amount: formatMoney(purchase.quotedAmount),
      asset: purchase.quotedAmount.asset,
      decimals: purchase.quotedAmount.decimals,
    },
    paidAmount: purchase.paidAmount
      ? {
          amount: formatMoney(purchase.paidAmount),
          asset: purchase.paidAmount.asset,
          decimals: purchase.paidAmount.decimals,
        }
      : undefined,
    policySnapshot: {
      ...session.policy,
      maxServiceSpend: session.policy?.maxServiceSpend
        ? {
            amount: formatMoney(session.policy.maxServiceSpend),
            asset: session.policy.maxServiceSpend.asset,
            decimals: session.policy.maxServiceSpend.decimals,
          }
        : undefined,
      maxPerService: session.policy?.maxPerService
        ? {
            amount: formatMoney(session.policy.maxPerService),
            asset: session.policy.maxPerService.asset,
            decimals: session.policy.maxPerService.decimals,
          }
        : undefined,
    },
  }));
  return JSON.stringify(parsed);
}

function serializeDraftSessionWithoutPurchases(session: TaskSession): string {
  return JSON.stringify({
    version: session.version,
    messages: session.messages,
    task: session.task
      ? {
          ...session.task,
          paymentAmount: session.task.paymentAmount
            ? {
                amount: formatMoney(session.task.paymentAmount),
                asset: session.task.paymentAmount.asset,
                decimals: session.task.paymentAmount.decimals,
              }
            : undefined,
          serviceBudget: session.task.serviceBudget
            ? {
                amount: formatMoney(session.task.serviceBudget),
                asset: session.task.serviceBudget.asset,
                decimals: session.task.serviceBudget.decimals,
              }
            : undefined,
          perServiceCap: session.task.perServiceCap
            ? {
                amount: formatMoney(session.task.perServiceCap),
                asset: session.task.perServiceCap.asset,
                decimals: session.task.perServiceCap.decimals,
              }
            : undefined,
        }
      : undefined,
    policy: session.policy
      ? {
          ...session.policy,
          maxServiceSpend: session.policy.maxServiceSpend
            ? {
                amount: formatMoney(session.policy.maxServiceSpend),
                asset: session.policy.maxServiceSpend.asset,
                decimals: session.policy.maxServiceSpend.decimals,
              }
            : undefined,
          maxPerService: session.policy.maxPerService
            ? {
                amount: formatMoney(session.policy.maxPerService),
                asset: session.policy.maxPerService.asset,
                decimals: session.policy.maxPerService.decimals,
              }
            : undefined,
        }
      : undefined,
  });
}
