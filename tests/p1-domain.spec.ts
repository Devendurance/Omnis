import { expect, test } from "@playwright/test";
import {
  DomainError,
  createApprovalRecord,
  createFinancialTask,
  createSettlementExecution,
  createTaskPolicy,
  formatMoney,
  money,
  transitionSettlement,
} from "../src/lib/domain";
import { parseFinancialIntent } from "../src/lib/intent";
import {
  hydrateDraftSession,
  loadDraftSession,
  saveDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import {
  LOCAL_DRAFT_OWNER_ID,
  orchestrateFinancialIntent,
} from "../src/lib/tasks/orchestrator";
import {
  selectSettlementProgressView,
  selectTaskProgressView,
} from "../src/lib/tasks/selectors";
import { TASK_SESSION_VERSION, type TaskSession } from "../src/lib/tasks/session";

const NOW = "2026-09-06T12:00:00.000Z";
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

test.describe("P1 task capture", () => {
  test("parses the flagship wallet-check payment without inventing authority", () => {
    const result = parseFinancialIntent(
      `Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.`,
    );

    expect(result.status).toBe("needs_clarification");
    expect(result.intentType).toBe("pay_with_check");
    expect(result.fields.recipient).toBeUndefined();
    expect(result.fields.purpose).toBe("contractor payment");
    expect(result.fields.paymentAmount && formatMoney(result.fields.paymentAmount)).toBe("50");
    expect(result.fields.paymentAmount?.asset).toBe("USDC");
    expect(result.fields.serviceBudget && formatMoney(result.fields.serviceBudget)).toBe("0.05");
    expect(result.fields.perServiceCap && formatMoney(result.fields.perServiceCap)).toBe("0.05");
    expect(result.fields.finalPaymentApprovalRequired).toBe(true);
    expect(result.clarification).toBe("Who should receive 50 USDC?");
  });

  test("parses canonical flagship variations without payment amount ambiguity", () => {
    // Variation 1: Pay X 50 USDC, spend no more than $0.05 checking
    const v1 = parseFinancialIntent(
      `Pay ${RECIPIENT} 50 USDC, spend no more than $0.05 checking.`,
    );
    expect(v1.status).toBe("ready");
    expect(v1.intentType).toBe("pay_with_check");
    expect(
      v1.fields.paymentAmount && formatMoney(v1.fields.paymentAmount),
    ).toBe("50");
    expect(v1.fields.paymentAmount?.asset).toBe("USDC");
    expect(
      v1.fields.serviceBudget && formatMoney(v1.fields.serviceBudget),
    ).toBe("0.05");
    expect(v1.fields.recipient).toBe(RECIPIENT);
    expect(v1.ambiguities).toHaveLength(0);

    // Variation 2: $0.05 check budget, then pay 50 USDC
    const v2 = parseFinancialIntent(
      `$0.05 check budget, then pay 50 USDC to ${RECIPIENT}.`,
    );
    expect(v2.status).toBe("ready");
    expect(v2.intentType).toBe("pay_with_check");
    expect(
      v2.fields.paymentAmount && formatMoney(v2.fields.paymentAmount),
    ).toBe("50");
    expect(v2.fields.paymentAmount?.asset).toBe("USDC");
    expect(
      v2.fields.serviceBudget && formatMoney(v2.fields.serviceBudget),
    ).toBe("0.05");
    expect(v2.fields.recipient).toBe(RECIPIENT);
    expect(v2.ambiguities).toHaveLength(0);

    // Variation 3: Pay 50 USDC after a wallet check capped at $0.05
    const v3 = parseFinancialIntent(
      `Pay 50 USDC to ${RECIPIENT} after a wallet check capped at $0.05.`,
    );
    expect(v3.status).toBe("ready");
    expect(v3.intentType).toBe("pay_with_check");
    expect(
      v3.fields.paymentAmount && formatMoney(v3.fields.paymentAmount),
    ).toBe("50");
    expect(v3.fields.paymentAmount?.asset).toBe("USDC");
    expect(
      v3.fields.serviceBudget && formatMoney(v3.fields.serviceBudget),
    ).toBe("0.05");
    expect(v3.fields.recipient).toBe(RECIPIENT);
    expect(v3.ambiguities).toHaveLength(0);
  });

  test("asks for a recipient before a payment plan is ready", () => {
    const result = parseFinancialIntent("Pay 50 USDC.");

    expect(result.status).toBe("needs_clarification");
    expect(result.missing).toEqual(["recipient"]);
    expect(result.clarification).toBe("Who should receive 50 USDC?");
  });

  test("follow-up recipient completes the same draft task", () => {
    const firstParse = parseFinancialIntent(
      "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
    );
    const first = orchestrateFinancialIntent(firstParse, {
      ownerId: "owner-1",
      taskId: "task-p1",
      now: NOW,
    });
    expect(first.kind).toBe("clarification");
    if (first.kind !== "clarification" || !first.task || !first.policy) {
      throw new Error("expected a draft task awaiting clarification");
    }

    const secondParse = parseFinancialIntent(RECIPIENT, {
      pendingIntent: firstParse.fields,
    });
    const second = orchestrateFinancialIntent(secondParse, {
      existingTask: first.task,
      existingPolicy: first.policy,
      now: NOW,
    });

    expect(second.kind).toBe("planned");
    if (second.kind !== "planned") throw new Error("expected a planned task");
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.status).toBe("planned");
    expect(second.task.recipient).toBe(RECIPIENT);
    expect(second.task.originalIntent).toContain("Pay this contractor");
    expect(second.policy.finalPaymentApprovalRequired).toBe(true);
    expect(second.plan.missing).toEqual([]);
  });
  test("fills missing payment asset and service budget from follow-ups", () => {
    const paymentParse = parseFinancialIntent(`Pay 50 to ${RECIPIENT}.`);
    const paymentDraft = orchestrateFinancialIntent(paymentParse, {
      ownerId: "owner-1",
      taskId: "task-asset",
      now: NOW,
    });
    if (paymentDraft.kind !== "clarification" || !paymentDraft.task || !paymentDraft.policy) {
      throw new Error("expected a payment draft awaiting asset");
    }
    const paymentFollowUp = parseFinancialIntent("USDC", {
      pendingIntent: paymentParse.fields,
    });
    const plannedPayment = orchestrateFinancialIntent(paymentFollowUp, {
      existingTask: paymentDraft.task,
      existingPolicy: paymentDraft.policy,
      now: NOW,
    });
    expect(plannedPayment.kind).toBe("planned");

    const budgetParse = parseFinancialIntent("Research this wallet.");
    const budgetDraft = orchestrateFinancialIntent(budgetParse, {
      ownerId: "owner-1",
      taskId: "task-budget",
      now: NOW,
    });
    if (budgetDraft.kind !== "clarification" || !budgetDraft.task || !budgetDraft.policy) {
      throw new Error("expected a research draft awaiting budget");
    }
    const budgetFollowUp = parseFinancialIntent("$0.05", {
      pendingIntent: budgetParse.fields,
    });
    const plannedBudget = orchestrateFinancialIntent(budgetFollowUp, {
      existingTask: budgetDraft.task,
      existingPolicy: budgetDraft.policy,
      now: NOW,
    });
    expect(plannedBudget.kind).toBe("planned");

    const unrelated = parseFinancialIntent("sure", {
      pendingIntent: paymentParse.fields,
    });
    expect(unrelated.status).toBe("needs_clarification");
    expect(unrelated.missing).toContain("payment_asset");
  });

  test("does not apply one numeric follow-up to two missing amount fields", () => {
    const first = parseFinancialIntent(
      `Check this wallet before paying ${RECIPIENT}.`,
    );
    expect(first.missing).toEqual(["payment_amount", "service_budget"]);

    const followUp = parseFinancialIntent("50", {
      pendingIntent: first.fields,
    });
    expect(followUp.status).toBe("needs_clarification");
    expect(followUp.fields.paymentAmount).toBeUndefined();
    expect(followUp.fields.paymentAmountText).toBe("50");
    expect(followUp.fields.serviceBudget).toBeUndefined();
    expect(followUp.missing).toEqual(["payment_asset", "service_budget"]);
    expect(followUp.clarification).toBe(
      "Which supported asset should Omnis use? P1 supports USDC only.",
    );
  });

  test("treats zero payment amounts as missing and never stores them", () => {
    const initial = parseFinancialIntent(`Pay 0 USDC to ${RECIPIENT}.`);
    expect(initial.status).toBe("needs_clarification");
    expect(initial.missing).toContain("payment_amount");
    expect(initial.fields.paymentAmount).toBeUndefined();
    expect(initial.clarification).toBe(
      "Payment amount must be greater than zero. What amount should Omnis pay?",
    );

    const first = parseFinancialIntent(`Pay to ${RECIPIENT}.`);
    const followUp = parseFinancialIntent("0", {
      pendingIntent: first.fields,
    });
    expect(followUp.missing).toContain("payment_amount");
    expect(followUp.fields.paymentAmount).toBeUndefined();
    expect(followUp.clarification).toBe(
      "Payment amount must be greater than zero. What amount should Omnis pay?",
    );
    const draft = orchestrateFinancialIntent(followUp, {
      ownerId: "owner-zero",
      taskId: "task-zero",
      now: NOW,
    });
    expect(draft.kind).toBe("clarification");
    if (draft.kind === "clarification") {
      expect(draft.task?.paymentAmount).toBeUndefined();
    }
  });

  test("supports simple USDC pay and bounded delegate intents", () => {
    const pay = parseFinancialIntent(`Pay 50 USDC to ${RECIPIENT}.`);
    const delegate = parseFinancialIntent("Research this wallet. Spend up to $0.05.");

    expect(pay.status).toBe("ready");
    expect(pay.intentType).toBe("pay");
    expect(pay.fields.recipient).toBe(RECIPIENT);
    expect(delegate.status).toBe("ready");
    expect(delegate.intentType).toBe("delegate");
    expect(delegate.fields.serviceBudget && formatMoney(delegate.fields.serviceBudget)).toBe("0.05");
    expect(delegate.fields.finalPaymentApprovalRequired).toBe(false);
  });

  test("rejects unsupported assets and ambiguous payment amounts", () => {
    const unsupported = parseFinancialIntent(`Pay 50 USDT to ${RECIPIENT}.`);
    const lowercaseUnsupported = parseFinancialIntent(
      `Pay 1 btc to ${RECIPIENT}.`,
    );
    const ambiguous = parseFinancialIntent(`Pay 50 or 60 USDC to ${RECIPIENT}.`);

    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.fields.unsupportedAsset).toBe("USDT");
    expect(unsupported.fields.paymentAmount).toBeUndefined();
    expect(unsupported.clarification).toContain("USDC payments only");
    const corrected = parseFinancialIntent("USDC", {
      pendingIntent: unsupported.fields,
    });
    expect(corrected.status).toBe("ready");
    expect(corrected.fields.unsupportedAsset).toBeUndefined();
    expect(corrected.fields.paymentAmount?.asset).toBe("USDC");
    expect(lowercaseUnsupported.status).toBe("unsupported");
    expect(lowercaseUnsupported.fields.unsupportedAsset).toBe("BTC");
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.ambiguities).toContain("payment amount is ambiguous");
    expect(ambiguous.clarification).toContain("Which amount");
  });

  test("orchestration creates only P0 task and policy records", () => {
    const parse = parseFinancialIntent(`Pay 50 USDC to ${RECIPIENT}.`);
    const result = orchestrateFinancialIntent(parse, {
      ownerId: LOCAL_DRAFT_OWNER_ID,
      taskId: "task-ready",
      now: NOW,
    });

    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") throw new Error("expected a planned task");
    expect(result.task.status).toBe("planned");
    expect(result.task.type).toBe("pay");
    expect(result.task.paymentAmount?.asset).toBe("USDC");
    expect(result.policy.allowedNetworks).toEqual([]);
    expect(result.policy.finalPaymentApprovalRequired).toBe(true);
    expect(result.plan.approvalBoundary).toBe("human approval required");
  });

  test("does not seed a new draft from free text after planning", () => {
    const planned = orchestrateFinancialIntent(
      parseFinancialIntent(`Pay 50 USDC to ${RECIPIENT}.`),
      { ownerId: "owner-planned", taskId: "task-planned", now: NOW },
    );
    if (planned.kind !== "planned") throw new Error("expected a planned task");

    const result = orchestrateFinancialIntent(parseFinancialIntent("hello"), {
      existingTask: planned.task,
      existingPolicy: planned.policy,
      now: NOW,
    });
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.task).toBeUndefined();
      expect(result.policy).toBeUndefined();
      expect(result.plan).toBeUndefined();
      expect(result.parse.missing).toEqual(["task_type"]);
    }
  });

  test("draft orchestration preserves P0 money validation", () => {
    expectDomainError(
      () =>
        orchestrateFinancialIntent(
          {
            status: "ready",
            intentType: "pay",
            fields: {
              type: "pay",
              recipient: RECIPIENT,
              paymentAmount: { asset: "USDC", units: 1, decimals: BigInt(6) } as never,
              paymentAsset: "USDC",
              finalPaymentApprovalRequired: true,
            },
            missing: [],
            ambiguities: [],
            confidence: "high",
            sourceText: "forged",
          },
          { ownerId: "owner-1", taskId: "task-forged", now: NOW },
        ),
      "INVALID_MONEY",
    );
  });

  test("round-trips versioned drafts with serialized money", () => {
    const parse = parseFinancialIntent(
      `Pay this contractor 50 USDC to ${RECIPIENT}, but check the wallet first. Spend no more than $0.05 checking.`,
    );
    const result = orchestrateFinancialIntent(parse, {
      ownerId: "owner-1",
      taskId: "task-persisted",
      now: NOW,
    });
    if (result.kind !== "planned") throw new Error("expected a planned task");
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      messages: [
        {
          id: "message-1",
          role: "omnis",
          kind: "plan",
          content: "I have a validated task plan.",
          plan: result.plan,
          createdAt: NOW,
        },
      ],
      task: result.task,
      policy: result.policy,
    };

    const hydrated = hydrateDraftSession(serializeDraftSession(session));
    expect(hydrated?.task?.id).toBe("task-persisted");
    expect(hydrated?.task?.status).toBe("planned");
    expect(hydrated?.task?.paymentAmount && formatMoney(hydrated.task.paymentAmount)).toBe("50");
    expect(hydrated?.task?.serviceBudget && formatMoney(hydrated.task.serviceBudget)).toBe("0.05");
    expect(hydrated?.messages[0]?.plan?.perServiceCap?.amount).toBe("0.05");
    expect(hydrated?.messages[0]?.kind).toBe("plan");
  });

  test("round-trips pending intent fields needed for follow-ups", () => {
    const initial = parseFinancialIntent(`Pay to ${RECIPIENT}.`);
    const first = orchestrateFinancialIntent(initial, {
      ownerId: "owner-pending",
      taskId: "task-pending",
      now: NOW,
    });
    if (first.kind !== "clarification" || !first.task || !first.policy) {
      throw new Error("expected a pending draft");
    }

    const withAmount = parseFinancialIntent("50", {
      pendingIntent: initial.fields,
    });
    const second = orchestrateFinancialIntent(withAmount, {
      existingTask: first.task,
      existingPolicy: first.policy,
      now: NOW,
    });
    if (second.kind !== "clarification" || !second.task || !second.policy) {
      throw new Error("expected a draft awaiting its asset");
    }

    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      messages: [],
      pendingIntent: withAmount.fields,
      task: second.task,
      policy: second.policy,
    };
    const hydrated = hydrateDraftSession(serializeDraftSession(session));
    expect(hydrated?.pendingIntent?.paymentAmountText).toBe("50");
    expect(hydrated?.task?.paymentAmount).toBeUndefined();

    const withAsset = parseFinancialIntent("USDC", {
      pendingIntent: hydrated?.pendingIntent,
    });
    expect(withAsset.status).toBe("ready");
    expect(withAsset.fields.paymentAmount?.asset).toBe("USDC");
  });

  test("rejects corrupt or stale persisted drafts and clears storage", () => {
    expect(hydrateDraftSession("not json")).toBeNull();
    expect(
      hydrateDraftSession(JSON.stringify({ version: 0, messages: [] })),
    ).toBeNull();
    const storage = new Map<string, string>([["useomnis:p1:draft-session", "not json"]]);
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    expect(loadDraftSession(adapter)).toBeNull();
    expect(storage.size).toBe(0);
    expect(saveDraftSession({ version: TASK_SESSION_VERSION, messages: [] }, adapter)).toBe(true);
  });

  test("settlement submission gets its identifier after approval", () => {
    const policy = createTaskPolicy({
      taskId: "task-settlement",
      maxServiceSpend: money("0.05", "USD"),
      maxPerService: money("0.01", "USD"),
      allowedServiceCategories: ["wallet-risk"],
      allowedAssets: ["USDC", "USD"],
      allowedNetworks: ["arc-testnet"],
      finalPaymentApprovalRequired: true,
    });
    const task = createFinancialTask(
      {
        id: policy.taskId,
        ownerId: "owner-1",
        type: "pay_with_check",
        recipient: RECIPIENT,
        paymentAmount: money("50", "USDC"),
        serviceBudget: policy.maxServiceSpend,
        perServiceCap: policy.maxPerService,
        finalPaymentApprovalRequired: true,
      },
      NOW,
    );
    const settlement = createSettlementExecution(
      {
        id: "execution-p1",
        taskId: task.id,
        provider: "unconfigured",
        amount: money("50", "USDC"),
        recipient: RECIPIENT,
        network: "arc-testnet",
        approvalRequired: true,
        policySnapshot: policy,
      },
      NOW,
    );
    const approval = createApprovalRecord({
      id: "approval-p1",
      taskId: task.id,
      settlementExecutionId: settlement.id,
      approverId: "owner-1",
      walletAddress: "0xowner",
      amount: settlement.amount,
      asset: "USDC",
      recipient: RECIPIENT,
      network: "arc-testnet",
      policySnapshot: policy,
      approvedAt: NOW,
    });
    const waiting = transitionSettlement(settlement, "awaiting_approval", { now: NOW });
    const submitting = transitionSettlement(waiting, "submitting", { approval, now: NOW });
    expect(submitting.status).toBe("submitting");
    expect(submitting.transactionHash).toBeUndefined();
    expect(selectTaskProgressView(task)).toMatchObject({
      status: "draft",
      isTerminal: false,
      nextStatuses: ["planned", "cancelled"],
    });
    expect(selectSettlementProgressView(submitting)).toMatchObject({
      status: "submitting",
      isTerminal: false,
      hasTransactionIdentifier: false,
      hasTrustedConfirmation: false,
      nextStatuses: ["submitted", "failed"],
      canResubmit: false,
    });
    const submitted = transitionSettlement(submitting, "submitted", {
      transactionHash: "0xtransaction",
      now: NOW,
    });
    const confirming = transitionSettlement(submitted, "confirming", { now: NOW });
    const delayed = transitionSettlement(confirming, "confirmation_delayed", {
      errorCode: "CONFIRMATION_DELAYED",
      now: NOW,
    });
    expect(selectSettlementProgressView(delayed)).toMatchObject({
      status: "confirmation_delayed",
      hasTransactionIdentifier: true,
      recoveryMode: "read_only_reconcile",
      canResubmit: false,
    });
    const reverted = transitionSettlement(delayed, "reverted", {
      confirmation: {
        source: "reconciliation",
        transactionHash: "0xtransaction",
        outcome: "reverted",
        observedAt: NOW,
      },
      now: NOW,
    });
    expect(selectSettlementProgressView(reverted)).toMatchObject({
      status: "reverted",
      isTerminal: true,
      hasTrustedConfirmation: true,
      canResubmit: false,
    });
    expectDomainError(
      () => transitionSettlement(submitting, "submitted", { now: NOW }),
      "SETTLEMENT_TRANSACTION_IDENTIFIER_REQUIRED",
    );
  });
});
