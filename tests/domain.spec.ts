import { expect, test } from "@playwright/test";
import {
  DomainError,
  POLICY_REASON_CODES,
  addMoney,
  compareMoney,
  createApprovalRecord,
  createFinancialTask,
  createServiceDescriptor,
  createServicePurchase,
  createSettlementExecution,
  createTaskPolicy,
  evaluatePolicy,
  evaluateServicePurchase,
  finalizeProof,
  formatMoney,
  getServicePurchaseRecoveryPlan,
  getSettlementRecoveryPlan,
  money,
  proofIdentityKey,
  transitionSettlement,
  transitionTask,
  type ApprovalRecord,
  type FinancialTask,
  type SettlementExecution,
  type TaskPolicy,
} from "../src/lib/domain";

const NOW = "2026-09-06T12:00:00.000Z";
const NETWORK = "arc-testnet";
const RECIPIENT = "0xcontractor";

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

function makePolicy(taskId = "task-1"): TaskPolicy {
  return createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.01", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedAssets: ["USD", "USDC"],
    allowedNetworks: [NETWORK],
    finalPaymentApprovalRequired: true,
  });
}

function makeTask(
  policy = makePolicy(),
  type: "pay" | "pay_with_check" = "pay_with_check",
): FinancialTask {
  return createFinancialTask(
    {
      id: policy.taskId,
      ownerId: "owner-1",
      type,
      originalIntent:
        "Pay this contractor 50 USDC, but check the wallet first.",
      recipient: RECIPIENT,
      paymentAmount: money("50", "USDC"),
      purpose: "contractor payment",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
}

function makeSettlement(
  task: FinancialTask,
  policy = makePolicy(task.id),
): SettlementExecution {
  return createSettlementExecution(
    {
      id: "execution-1",
      taskId: task.id,
      provider: "unconfigured",
      amount: money("50", "USDC"),
      recipient: RECIPIENT,
      network: NETWORK,
      approvalRequired: true,
      policySnapshot: policy,
    },
    NOW,
  );
}

function makeApproval(
  task: FinancialTask,
  settlement: SettlementExecution,
  policy = makePolicy(task.id),
): ApprovalRecord {
  return createApprovalRecord({
    id: "approval-1",
    taskId: task.id,
    settlementExecutionId: settlement.id,
    approverId: "owner-1",
    walletAddress: "0xowner",
    amount: settlement.amount,
    asset: "USDC",
    recipient: settlement.recipient,
    network: settlement.network,
    policySnapshot: policy,
    approvedAt: NOW,
  });
}

function makeConfirmedSettlement(
  task: FinancialTask,
  approval: ApprovalRecord,
): SettlementExecution {
  const prepared = makeSettlement(task);
  const waiting = transitionSettlement(prepared, "awaiting_approval", {
    now: NOW,
  });
  const submitting = transitionSettlement(waiting, "submitting", {
    approval,
    now: NOW,
  });
  const submitted = transitionSettlement(submitting, "submitted", {
    transactionHash: "0xtransaction",
    now: NOW,
  });
  const confirming = transitionSettlement(submitted, "confirming", {
    now: NOW,
  });
  return transitionSettlement(confirming, "confirmed", {
    confirmation: {
      source: "reconciliation",
      transactionHash: "0xtransaction",
      outcome: "confirmed",
      observedAt: NOW,
      receiptReference: "receipt-1",
    },
    now: NOW,
  });
}

test.describe("P0 domain foundation", () => {
  test("task transitions allow the planned approval path", () => {
    const policy = makePolicy();
    const task = createFinancialTask(
      {
        ...makeTask(policy),
        type: "pay",
        serviceBudget: undefined,
        perServiceCap: undefined,
      },
      NOW,
    );
    const settlement = makeSettlement(task);
    const approval = makeApproval(task, settlement, policy);

    const planned = transitionTask(task, "planned", { now: NOW });
    const running = transitionTask(planned, "running", { now: NOW });
    const awaitingApproval = transitionTask(running, "awaiting_approval", {
      now: NOW,
    });
    const settling = transitionTask(awaitingApproval, "settling", {
      approval,
      now: NOW,
    });
    const confirmedSettlement = makeConfirmedSettlement(task, approval);
    const completed = transitionTask(settling, "completed", {
      settlement: confirmedSettlement,
      now: NOW,
    });

    expect(completed.status).toBe("completed");
    expect(completed.updatedAt).toBe(NOW);
  });

  test("invalid task transitions fail with stable codes", () => {
    const task = makeTask();
    expectDomainError(
      () => transitionTask(task, "completed"),
      "TASK_TRANSITION_NOT_ALLOWED",
    );
    const planned = transitionTask(task, "planned");
    const running = transitionTask(planned, "running");
    expectDomainError(
      () => transitionTask(running, "completed"),
      "TASK_COMPLETION_REQUIRES_CONFIRMED_SETTLEMENT",
    );
  });

  test("settlement follows submission, delayed confirmation, and recovery", () => {
    const task = makeTask();
    const prepared = makeSettlement(task);
    const approval = makeApproval(task, prepared);
    const waiting = transitionSettlement(prepared, "awaiting_approval");
    const submitting = transitionSettlement(waiting, "submitting", {
      approval,
    });
    const submitted = transitionSettlement(submitting, "submitted", {
      transactionHash: "0xtransaction",
    });
    const confirming = transitionSettlement(submitted, "confirming");
    const delayed = transitionSettlement(confirming, "confirmation_delayed", {
      errorCode: "RPC_TIMEOUT",
    });
    const recovered = transitionSettlement(delayed, "confirmed", {
      confirmation: {
        source: "reconciliation",
        transactionHash: "0xtransaction",
        outcome: "confirmed",
        observedAt: NOW,
      },
    });

    expect(submitted.transactionHash).toBe("0xtransaction");
    expect(delayed.status).toBe("confirmation_delayed");
    expect(getSettlementRecoveryPlan(delayed)).toEqual({
      mode: "read_only_reconcile",
      transactionHash: "0xtransaction",
      canResubmit: false,
    });
    expect(recovered.status).toBe("confirmed");
    expectDomainError(
      () => transitionSettlement(recovered, "submitting"),
      "SETTLEMENT_TRANSITION_NOT_ALLOWED",
    );
  });

  test("reverted and failed settlement outcomes stay terminal", () => {
    const task = makeTask();
    const prepared = makeSettlement(task);
    const approval = makeApproval(task, prepared);
    const waiting = transitionSettlement(prepared, "awaiting_approval");
    const submitting = transitionSettlement(waiting, "submitting", { approval });
    const submitted = transitionSettlement(submitting, "submitted", {
      transactionHash: "0xtransaction",
    });
    const confirming = transitionSettlement(submitted, "confirming");
    const reverted = transitionSettlement(confirming, "reverted", {
      confirmation: {
        source: "reconciliation",
        transactionHash: "0xtransaction",
        outcome: "reverted",
        observedAt: NOW,
      },
    });

    expect(reverted.status).toBe("reverted");
    expectDomainError(
      () => transitionSettlement(reverted, "confirming"),
      "SETTLEMENT_TRANSITION_NOT_ALLOWED",
    );

    const failed = transitionSettlement(submitting, "failed", {
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    expect(failed.status).toBe("failed");
    expectDomainError(
      () => transitionSettlement(failed, "submitted", {
        transactionHash: "0xsecond",
      }),
      "SETTLEMENT_TRANSITION_NOT_ALLOWED",
    );
  });

  test("final payment submission requires the matching approval record", () => {
    const task = makeTask();
    const prepared = makeSettlement(task);
    const waiting = transitionSettlement(prepared, "awaiting_approval");

    expectDomainError(
      () => transitionSettlement(waiting, "submitting"),
      "SETTLEMENT_APPROVAL_REQUIRED",
    );
  });
  test("approval must carry the same policy snapshot as settlement", () => {
    const policy = makePolicy();
    const changedPolicy = createTaskPolicy({
      ...policy,
      maxPerService: money("0.02", "USD"),
    });
    const task = makeTask(policy);
    const prepared = makeSettlement(task, policy);
    const mismatchedApproval = makeApproval(task, prepared, changedPolicy);
    const waiting = transitionSettlement(prepared, "awaiting_approval");

    expectDomainError(
      () =>
        transitionSettlement(waiting, "submitting", {
          approval: mismatchedApproval,
        }),
      "APPROVAL_POLICY_MISMATCH",
    );
  });

  test("policy allows a three-mil service within a five-cent budget", () => {
    const result = evaluatePolicy({
      action: "service_purchase",
      policy: makePolicy(),
      alreadySpent: money("0", "USD"),
      requestedServicePrice: money("0.003", "USD"),
      serviceCategory: "wallet-risk",
      asset: "USD",
      network: NETWORK,
    });

    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.ALLOW_WITHIN_SERVICE_BUDGET,
    );
    expect(formatMoney(result.remainingBudget!)).toBe("0.047");
  });

  test("policy denies total budget overflow and per-service cap overflow", () => {
    const policy = makePolicy();
    const totalExceeded = evaluatePolicy({
      action: "service_purchase",
      policy: createTaskPolicy({
        ...policy,
        maxPerService: money("0.10", "USD"),
      }),
      alreadySpent: money("0", "USD"),
      requestedServicePrice: money("0.051", "USD"),
      serviceCategory: "wallet-risk",
      asset: "USD",
      network: NETWORK,
    });
    const capExceeded = evaluatePolicy({
      action: "service_purchase",
      policy,
      alreadySpent: money("0", "USD"),
      requestedServicePrice: money("0.011", "USD"),
      serviceCategory: "wallet-risk",
      asset: "USD",
      network: NETWORK,
    });

    expect(totalExceeded.decision).toBe("DENY");
    expect(totalExceeded.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_TOTAL_BUDGET_EXCEEDED,
    );
    expect(capExceeded.decision).toBe("DENY");
    expect(capExceeded.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_PER_SERVICE_CAP_EXCEEDED,
    );
  });

  test("policy denies disallowed categories and networks", () => {
    const policy = makePolicy();
    const category = evaluatePolicy({
      action: "service_purchase",
      policy,
      alreadySpent: money("0", "USD"),
      requestedServicePrice: money("0.003", "USD"),
      serviceCategory: "identity",
      asset: "USD",
      network: NETWORK,
    });
    const network = evaluatePolicy({
      action: "service_purchase",
      policy,
      alreadySpent: money("0", "USD"),
      requestedServicePrice: money("0.003", "USD"),
      serviceCategory: "wallet-risk",
      asset: "USD",
      network: "unknown-network",
    });

    expect(category.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_SERVICE_CATEGORY_NOT_ALLOWED,
    );
    expect(network.reasonCode).toBe(POLICY_REASON_CODES.DENY_NETWORK_NOT_ALLOWED);
  });

  test("final USDC payment requiring approval returns REQUIRE_APPROVAL", () => {
    const result = evaluatePolicy({
      action: "final_payment",
      policy: makePolicy(),
      requestedAmount: money("50", "USDC"),
      asset: "USDC",
      network: NETWORK,
    });

    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.REQUIRE_FINAL_PAYMENT_APPROVAL,
    );
  });

  test("service authorization enforces the remaining budget", () => {
    const policy = createTaskPolicy({
      ...makePolicy(),
      maxPerService: money("0.10", "USD"),
    });
    const service = createServiceDescriptor({
      id: "wallet-risk",
      name: "Wallet Risk",
      capability: "wallet risk check",
      category: "wallet-risk",
      description: "Checks wallet risk signals.",
      endpoint: "https://example.test/risk",
      price: money("0.051", "USD"),
      network: NETWORK,
      paymentProtocol: "x402",
      inputSchema: {},
      outputSchema: {},
    });
    const purchase = createServicePurchase({
      id: "purchase-1",
      taskId: policy.taskId,
      serviceId: service.id,
      quotedAmount: money("0.051", "USD"),
      policySnapshot: policy,
    });
    const result = evaluateServicePurchase({
      policy,
      purchase,
      service,
      alreadySpent: money("0", "USD"),
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_TOTAL_BUDGET_EXCEEDED,
    );
  });

  test("service quote above descriptor price is denied", () => {
    const policy = createTaskPolicy({
      ...makePolicy(),
      maxPerService: money("0.10", "USD"),
    });
    const service = createServiceDescriptor({
      id: "wallet-risk",
      name: "Wallet Risk",
      capability: "wallet risk check",
      category: "wallet-risk",
      description: "Checks wallet risk signals.",
      endpoint: "https://example.test/risk",
      price: money("0.003", "USD"),
      network: NETWORK,
      paymentProtocol: "x402",
      inputSchema: {},
      outputSchema: {},
    });
    const purchase = createServicePurchase({
      id: "purchase-2",
      taskId: policy.taskId,
      serviceId: service.id,
      quotedAmount: money("0.004", "USD"),
      policySnapshot: policy,
    });

    const result = evaluateServicePurchase({
      policy,
      purchase,
      service,
      alreadySpent: money("0", "USD"),
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe(
      POLICY_REASON_CODES.DENY_SERVICE_PRICE_EXCEEDED_DESCRIPTOR,
    );
  });

  test("money comparisons and additions stay decimal-safe", () => {
    const threeMils = money("0.003", "USD");
    const threeMilsAtFourDecimals = money("0.0030", "USD", 4);
    const oneMil = money("0.001", "USD");

    expect(compareMoney(threeMils, threeMilsAtFourDecimals)).toBe(0);
    expect(compareMoney(threeMils, oneMil)).toBe(1);
    expect(formatMoney(addMoney(threeMils, oneMil))).toBe("0.004");
  });

  test("proof identity and finalization are deterministic and idempotent", () => {
    const policy = makePolicy();
    const task = makeTask(policy, "pay");
    const prepared = makeSettlement(task);
    const approval = makeApproval(task, prepared, policy);
    const settlement = makeConfirmedSettlement(task, approval);
    const service = createServiceDescriptor({
      id: "wallet-risk",
      name: "Wallet Risk",
      capability: "wallet risk check",
      category: "wallet-risk",
      description: "Checks wallet risk signals.",
      endpoint: "https://example.test/risk",
      price: money("0.003", "USD"),
      network: NETWORK,
      paymentProtocol: "x402",
      inputSchema: {},
      outputSchema: {},
    });
    const purchase = createServicePurchase({
      id: "purchase-1",
      taskId: task.id,
      serviceId: service.id,
      quotedAmount: money("0.003", "USD"),
      policySnapshot: policy,
      paidAmount: money("0.003", "USD"),
      paymentIdentifier: "service-payment-1",
      status: "paid",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const completedTask = transitionTask(
      transitionTask(
        transitionTask(task, "planned", { now: NOW }),
        "running",
        { now: NOW },
      ),
      "settling",
      { approval, now: NOW },
    );
    const finalTask = transitionTask(completedTask, "completed", {
      settlement,
      now: NOW,
    });
    const input = {
      task: finalTask,
      policy,
      servicePurchases: [purchase],
      settlement,
      approval,
      agentSummary: "The wallet check passed.",
      recordedAt: NOW,
    } as const;
    const proof = finalizeProof(input);
    const repeated = finalizeProof(input, proof);

    expect(proofIdentityKey(task.id, settlement.id)).toBe(proof.idempotencyKey);
    expect(formatMoney(proof.totalServiceSpend)).toBe("0.003");
    expect(repeated).toBe(proof);
  });

  test("proof rejects a confirmed status without reconciliation evidence", () => {
    const policy = makePolicy();
    const task = makeTask(policy, "pay");
    const prepared = makeSettlement(task);
    const approval = makeApproval(task, prepared, policy);
    const confirmed = makeConfirmedSettlement(task, approval);
    const completedTask = transitionTask(
      transitionTask(
        transitionTask(task, "planned"),
        "running",
      ),
      "settling",
      { approval },
    );
    const finalTask = transitionTask(completedTask, "completed", {
      settlement: confirmed,
    });
    const untrusted = { ...confirmed, confirmationEvidence: undefined };

    expectDomainError(
      () =>
        finalizeProof({
          task: finalTask,
          policy,
          servicePurchases: [],
          settlement: untrusted,
          approval,
          recordedAt: NOW,
          agentSummary: "payment confirmed by the model",
        }),
      "PROOF_REQUIRES_TRUSTED_SETTLEMENT_EVIDENCE",
    );
  });

  test("service recovery is read-only after a payment identifier exists", () => {
    const policy = makePolicy();
    const service = createServiceDescriptor({
      id: "wallet-risk",
      name: "Wallet Risk",
      capability: "wallet risk check",
      category: "wallet-risk",
      description: "Checks wallet risk signals.",
      endpoint: "https://example.test/risk",
      price: money("0.003", "USD"),
      network: NETWORK,
      paymentProtocol: "x402",
      inputSchema: {},
      outputSchema: {},
    });
    const purchase = createServicePurchase({
      id: "purchase-1",
      taskId: policy.taskId,
      serviceId: service.id,
      quotedAmount: service.price,
      policySnapshot: policy,
      paidAmount: service.price,
      paymentIdentifier: "service-payment-1",
      status: "paid",
    });

    expect(getServicePurchaseRecoveryPlan(purchase)).toEqual({
      mode: "read_only_reconcile",
      paymentIdentifier: "service-payment-1",
      canRepurchase: false,
    });
  });
});
