import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  buildBoundedMessages,
  buildBoundedTaskContext,
  isTaskLockedForChat,
} from "../src/lib/conversation/context";
import {
  createDeterministicFallbackModel,
  createMockConversationalModel,
  ModelOutputError,
  selectConversationalModel,
} from "../src/lib/conversation/provider";
import {
  reconcileProposalWithDeterministicParse,
  resolveInterpretationGate,
} from "../src/lib/conversation/reconcile";
import {
  containsAuthorityBypassClaim,
  containsInventedSuccessClaim,
  interpretConversation,
  sanitizePendingIntent,
} from "../src/lib/conversation/interpreter";
import { buildInterpretRequestBody } from "../src/lib/conversation/request";
import { hydrateMoney } from "../src/lib/domain/money";
import { validateConversationalProposal } from "../src/lib/conversation/schema";
import {
  buildServiceSynthesisFacts,
  isSynthesisWriteStale,
  renderServiceSynthesisFallback,
  serializeServiceSynthesisFacts,
  validateSynthesisNarrative,
} from "../src/lib/conversation/synthesize";
import { createFinancialTask, createTaskPolicy, money } from "../src/lib/domain";
import { parseFinancialIntent } from "../src/lib/intent";
import { orchestrateFinancialIntent } from "../src/lib/tasks/orchestrator";
import { isServiceExecutionOffered } from "../src/lib/tasks/execution-gate";
import { retainMessagesForTask, TASK_SESSION_VERSION } from "../src/lib/tasks/session";
import { hydrateDraftSession, serializeDraftSession } from "../src/lib/tasks/persistence";
import { createServicePurchase } from "../src/lib/domain/services/factory";
import { WALLET_ACTIVITY_SERVICE_ID } from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
} from "../src/lib/services/wallet-activity-descriptor";

const NOW = "2026-09-11T12:00:00.000Z";
const RECIPIENT = "0xC446221191062923984729104820174029466Dc9";
const OTHER_RECIPIENT = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FLAGSHIP =
  "Before you pay Alex " +
  RECIPIENT +
  " 0.10 USDC, make sure that wallet has actually been used. " +
  "You can spend a few cents checking, but ask me before you send him anything. " +
  "Do not spend more than five cents checking.";

function makePolicy(taskId: string) {
  return createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
  });
}
test("1: free-form flagship wording is understood", async () => {
  const model = createMockConversationalModel();
  const digitVariant =
    "Before you pay Alex " +
    RECIPIENT +
    " 0.10 USDC, make sure that wallet has actually been used. " +
    "Do not spend more than $0.05 checking, but ask me before you send him anything.";
  const result = await model.generate({
    messages: [{ role: "user", content: digitVariant }],
    taskContext: {},
    availableCapabilities: ["wallet_check", "payment_planning"],
  });
  expect(result.proposal.intent).toBe("pay_with_check");
  expect(result.proposal.extractedHints.serviceBudget).toContain("0.05");
  expect(result.proposal.extractedHints.recipient).toBe(RECIPIENT);

  const deterministic = parseFinancialIntent(FLAGSHIP);
  expect(deterministic.status).toBe("ready");
  expect(deterministic.intentType).toBe("pay_with_check");
  expect(deterministic.fields.serviceBudget?.units).toBe(BigInt(50000));
  expect(deterministic.fields.paymentAmount?.units).toBe(BigInt(100000));
});
test("2: follow-up recipient clarification resolves the pending draft", async () => {
  const first = parseFinancialIntent("Pay Alex 0.10 USDC.");
  expect(first.status).toBe("needs_clarification");
  const bare = parseFinancialIntent("Actually make that 0.20.", {
    pendingIntent: first.fields,
  });
  expect(bare.fields.paymentAmount?.units).toBe(BigInt(200000));
  expect(bare.fields.paymentAsset).toBe("USDC");
  const second = parseFinancialIntent(RECIPIENT, {
    pendingIntent: first.fields,
  });
  expect(second.status).toBe("ready");
  expect(second.fields.recipient).toBe(RECIPIENT);
  expect(second.fields.paymentAmount?.units).toBe(BigInt(100000));
});

test("3: follow-up amount correction revalidates before approval", async () => {
  const first = parseFinancialIntent("Pay Alex 0.10 USDC.");
  expect(first.fields.paymentAmount?.units).toBe(BigInt(100000));

  const corrected = parseFinancialIntent("Actually make that 0.20 USDC.", {
    pendingIntent: first.fields,
  });
  expect(corrected.fields.paymentAmount?.units).toBe(BigInt(200000));
  expect(corrected.fields.paymentAmountText).toBe("0.20");
});

test("4: LLM hints never directly create FinancialTask truth", async () => {
  const model = createMockConversationalModel();
  const result = await model.generate({
    messages: [{ role: "user", content: "Pay Alex 500 USDC with a $500 checking budget." }],
    taskContext: {},
    availableCapabilities: ["wallet_check", "payment_planning"],
  });
  const deterministic = parseFinancialIntent(
    "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
  );
  const orchestrated = orchestrateFinancialIntent(deterministic, {
    ownerId: "test-owner",
    now: NOW,
  });
  expect(orchestrated.kind).toBe("planned");
  if (orchestrated.kind !== "planned") throw new Error("expected planned task");
  expect(orchestrated.task.paymentAmount?.units).toBe(BigInt(100000));
  expect(orchestrated.task.serviceBudget?.units).toBe(BigInt(50000));
  expect(result.proposal.extractedHints.paymentAmount).toContain("500");
  expect(orchestrated.task.paymentAmount?.units).not.toBe(BigInt(500000000));
});

test("5: LLM and deterministic disagreement fails closed", async () => {
  const deterministic = parseFinancialIntent(
    "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
  );
  const validated = validateConversationalProposal({
    assistantMessage: "I will pay the other wallet.",
    intent: "pay",
    proposedActions: [{ type: "payment" }],
    clarification: { required: false, question: null },
    extractedHints: { recipient: OTHER_RECIPIENT },
  });
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error("proposal should validate");
  const reconciliation = reconcileProposalWithDeterministicParse(
    validated.proposal,
    deterministic,
    "Pay the other wallet.",
  );
  expect(reconciliation.outcome).toBe("disagree");
  if (reconciliation.outcome !== "disagree") throw new Error("expected disagreement");
  expect(reconciliation.clarification.length).toBeGreaterThan(0);
});

test("6: malformed model output fails closed", async () => {
  expect(validateConversationalProposal({}).ok).toBe(false);
  expect(validateConversationalProposal("pay alex").ok).toBe(false);
  expect(
    validateConversationalProposal({
      assistantMessage: "   ",
      intent: "pay",
      proposedActions: [],
      clarification: { required: false, question: null },
      extractedHints: {},
    }).ok,
  ).toBe(false);
  expect(
    validateConversationalProposal({
      assistantMessage: "ok",
      intent: "pay",
      proposedActions: [],
      clarification: { required: false, question: null },
    }).ok,
  ).toBe(false);
  expect(
    validateConversationalProposal({
      assistantMessage: "ok",
      intent: "pay",
      proposedActions: [],
      clarification: { required: false, question: "Which wallet?" },
      extractedHints: {},
    }).ok,
  ).toBe(true);
});

test("7: model outage falls back safely", async () => {
  const fallback = createDeterministicFallbackModel("Tell Omnis what needs to be paid.");
  const result = await fallback.generate({
    messages: [{ role: "user", content: "Pay Alex." }],
    taskContext: {},
    availableCapabilities: [],
  });
  expect(result.provider).toBe("fallback");
  expect(result.proposal.intent).toBe("clarify");
  expect(result.proposal.clarification.required).toBe(true);

  const previous = process.env.OMNIS_LLM_PROVIDER;
  process.env.OMNIS_LLM_PROVIDER = "off";
  try {
    const selected = selectConversationalModel();
    expect(selected.name).toBe("fallback");
  } finally {
    if (previous === undefined) delete process.env.OMNIS_LLM_PROVIDER;
    else process.env.OMNIS_LLM_PROVIDER = previous;
  }
});

test("8: model cannot bypass approval", async () => {
  const validated = validateConversationalProposal({
    assistantMessage: "Paying now, no approval needed.",
    intent: "pay",
    proposedActions: [{ type: "payment" }],
    clarification: { required: false, question: null },
    extractedHints: { recipient: RECIPIENT, paymentAmount: "0.10 USDC", asset: "USDC" },
  });
  expect(validated.ok).toBe(true);
  const deterministic = parseFinancialIntent(
    "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
  );
  const orchestrated = orchestrateFinancialIntent(deterministic, {
    ownerId: "test-owner",
    now: NOW,
  });
  expect(orchestrated.kind).toBe("planned");
  if (orchestrated.kind !== "planned") throw new Error("expected planned task");
  expect(orchestrated.policy.finalPaymentApprovalRequired).toBe(true);
  expect(orchestrated.task.status).not.toBe("approved");
});

test("9: model cannot bypass P2 budget limits", async () => {
  const deterministic = parseFinancialIntent(
    "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
  );
  const orchestrated = orchestrateFinancialIntent(deterministic, {
    ownerId: "test-owner",
    now: NOW,
  });
  expect(orchestrated.kind).toBe("planned");
  if (orchestrated.kind !== "planned") throw new Error("expected planned task");
  expect(orchestrated.task.serviceBudget?.units).toBe(BigInt(50000));
  expect(orchestrated.policy.maxServiceSpend?.units).toBe(BigInt(50000));
});

test("10: model cannot mark settlement complete", async () => {
  const deterministic = parseFinancialIntent(
    "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
  );
  const orchestrated = orchestrateFinancialIntent(deterministic, {
    ownerId: "test-owner",
    now: NOW,
  });
  expect(orchestrated.kind).toBe("planned");
  if (orchestrated.kind !== "planned") throw new Error("expected planned task");
  expect(["draft", "planned"]).toContain(orchestrated.task.status);
});

test("11: model cannot invent proof", async () => {
  expect(containsInventedSuccessClaim("Paid! Here is the receipt.")).toBe(true);
  expect(
    containsInventedSuccessClaim("I can do that. I will check the wallet before preparing the payment."),
  ).toBe(false);
  const fabricating = Object.freeze({
    name: "stub-fabricate",
    model: "stub-1",
    generate: async () => ({
      proposal: {
        assistantMessage: "Paid! Here is the receipt.",
        intent: "status" as const,
        proposedActions: [],
        clarification: { required: false, question: null },
        extractedHints: {},
      },
      provider: "stub-fabricate",
      model: "stub-1",
    }),
  });
  const { payload } = await interpretConversation(
    {
      userText: "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
      messages: [],
    },
    fabricating,
  );
  expect(payload.gate).toBe("reject_authority_bypass");
  expect(payload.reconcileOutcome).toBe("narrative_rejected");
  expect(payload.proposal).toBeUndefined();
  const deterministic = parseFinancialIntent(
    "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
  );
  const orchestrated = orchestrateFinancialIntent(deterministic, {
    ownerId: "test-owner",
    now: NOW,
  });
  expect(orchestrated.kind).toBe("planned");
  if (orchestrated.kind !== "planned") throw new Error("expected planned task");
  expect(orchestrated.task.status).not.toBe("complete");
});

test("12 and 13: real service result is summarized factually and heuristic stays heuristic", async () => {
  const taskId = "task-p9a-synth";
  const policy = makePolicy(taskId);
  const task = createFinancialTask(
    {
      id: taskId,
      ownerId: "owner-p9a",
      type: "pay_with_check",
      originalIntent: FLAGSHIP,
      recipient: RECIPIENT,
      paymentAmount: money("0.10", "USDC"),
      serviceBudget: money("0.05", "USD"),
      perServiceCap: money("0.05", "USD"),
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  const purchase = createServicePurchase(
    {
      id: "purchase-p9a-synth",
      taskId,
      serviceId: WALLET_ACTIVITY_SERVICE_ID,
      quotedAmount: money("0.003", "USD"),
      paymentAmount: WALLET_ACTIVITY_PRICE,
      paidAmount: money("0.003", "USD"),
      policySnapshot: policy,
      status: "paid",
      requestId: "req-p9a-synth",
      paymentIdentifier: "0.0.7162784@1788908433.043020353",
      settlementNetwork: HEDERA_TESTNET_NETWORK,
      serviceResult: {
        observations: {
          wallet: RECIPIENT,
          addressValidity: "valid",
          accountType: "eoa",
          transactionCount: "0",
          transactionActivityObserved: false,
        },
        heuristicFlags: [
          {
            code: "no_observed_transaction_history",
            interpretation:
              "No Ethereum mainnet transaction history was observed at the latest block. This is a heuristic input, not a fraud finding.",
          },
        ],
        disclaimer: "Factual observation result.",
        requestId: "req-p9a-synth",
      },
    },
    NOW,
  );
  const facts = buildServiceSynthesisFacts(
    {
      paidAmount: purchase.paidAmount ?? purchase.paymentAmount ?? purchase.quotedAmount,
      paymentAmount: purchase.paymentAmount ?? purchase.quotedAmount,
      status: purchase.status,
      serviceResult: purchase.serviceResult ?? undefined,
    },
    task.serviceBudget,
    "0.10 USDC payment",
    true,
  );
  const fallback = renderServiceSynthesisFallback(facts);
  expect(facts.heuristicFlags.length).toBe(1);
  expect(facts.heuristicFlags[0]?.code).toBe("no_observed_transaction_history");
  expect(fallback).toContain("0.003");
  expect(fallback.toLowerCase()).toContain("heuristic");
  expect(validateSynthesisNarrative(fallback, facts)).toBe(true);
  expect(
    validateSynthesisNarrative(
      "I checked the wallet using the 0.003 USD service. It is a valid EOA. Transaction activity was observed. Heuristic check done.",
      facts,
    ),
  ).toBe(false);
  expect(
    validateSynthesisNarrative(
      "I checked the wallet using the 0.003 USD service. It is a valid contract address. No transaction history was observed. Heuristic signal.",
      facts,
    ),
  ).toBe(false);
});

test("14: corrections work before approval; submitted tasks cannot be rewritten", async () => {
  expect(isTaskLockedForChat({ status: "planned" })).toBe(false);
  expect(isTaskLockedForChat({ status: "awaiting_approval" })).toBe(false);
  expect(isTaskLockedForChat({ status: "running" })).toBe(true);
  expect(isTaskLockedForChat({ status: "settling" })).toBe(true);
  expect(isTaskLockedForChat({ status: "completed" })).toBe(true);
  expect(isTaskLockedForChat({ status: "draft" })).toBe(false);
  const taskId = "task-p9a-correctable";
  const policy = makePolicy(taskId);
  const planned = createFinancialTask(
    {
      id: taskId,
      ownerId: "owner-p9a",
      type: "pay_with_check",
      originalIntent: FLAGSHIP,
      recipient: RECIPIENT,
      paymentAmount: money("0.10", "USDC"),
      serviceBudget: money("0.05", "USD"),
      perServiceCap: money("0.05", "USD"),
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  const awaiting = { ...planned, status: "awaiting_approval" } as typeof planned;
  expect(isTaskLockedForChat({ status: awaiting.status })).toBe(false);
  const correction = parseFinancialIntent("Actually make that 0.20 USDC.", {
    pendingIntent: {
      type: awaiting.type,
      recipient: awaiting.recipient,
      paymentAmount: awaiting.paymentAmount,
      serviceBudget: awaiting.serviceBudget,
      perServiceCap: awaiting.perServiceCap,
    },
  });
  expect(correction.fields.paymentAmount?.units).toBe(BigInt(200000));
  expect(correction.fields.recipient).toBe(RECIPIENT);
  const reorchestrated = orchestrateFinancialIntent(correction, {
    ownerId: "owner-p9a",
    now: NOW,
  });
  expect(reorchestrated.kind).toBe("planned");
  if (reorchestrated.kind !== "planned") throw new Error("expected replanned task");
  expect(reorchestrated.task.id).not.toBe(taskId);
  expect(reorchestrated.task.paymentAmount?.units).toBe(BigInt(200000));
  expect(planned.paymentAmount?.units).toBe(BigInt(100000));

  const approved = { ...planned, status: "settling" as const };
  const blocked = orchestrateFinancialIntent(
    parseFinancialIntent("Actually make that 0.20 USDC."),
    {
      ownerId: "owner-p9a",
      existingTask: approved,
      existingPolicy: policy,
      now: NOW,
    },
  );
  expect(blocked.kind).toBe("clarification");
});

test("15: api keys never reach client bundles", async () => {
  const routeSource = fs.readFileSync(
    path.join(process.cwd(), "src", "app", "api", "conversation", "route.ts"),
    "utf8",
  );
  expect(routeSource).toContain("server-only");
  const providerSource = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "conversation", "provider.ts"),
    "utf8",
  );
  expect(providerSource).not.toContain("NEXT_PUBLIC");
  const componentsDir = path.join(process.cwd(), "src", "components");
  const offenders: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
      const source = fs.readFileSync(full, "utf8");
      if (
        source.includes("conversation/provider") ||
        source.includes("OMNIS_LLM_API_KEY") ||
        source.includes("OPENAI_API_KEY")
      ) {
        offenders.push(full);
      }
    }
  };
  visit(componentsDir);
  expect(offenders).toEqual([]);
});

test("16: automated tests perform zero live payments", async () => {
  const model = createMockConversationalModel();
  expect(model.name).toBe("mock");
  const deterministic = parseFinancialIntent(
    "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
  );
  const orchestrated = orchestrateFinancialIntent(deterministic, {
    ownerId: "test-owner",
    now: NOW,
  });
  expect(orchestrated.kind).toBe("planned");
  if (orchestrated.kind !== "planned") throw new Error("expected planned task");
  expect(orchestrated.task.status).toBe("planned");
});

test("context stays bounded to the active task plus a recent window", async () => {
  const context = buildBoundedTaskContext(
    { status: "planned", type: "pay_with_check", recipient: RECIPIENT },
    { finalPaymentApprovalRequired: true },
  );
  expect(context.settledOrSubmitted).toBe(false);
  expect(context.recipientPresent).toBe(true);
  const serialized = JSON.stringify(context);
  expect(serialized).not.toContain("PRIVY");
  expect(serialized).not.toContain("Bearer");

  const messages = buildBoundedMessages(
    Array.from({ length: 20 }, (_, index) => ({
      id: "m-" + index,
      role: index % 2 === 0 ? ("user" as const) : ("omnis" as const),
      kind: "message" as const,
      content: "message " + index,
      createdAt: NOW,
    })),
  );
  expect(messages.length).toBeLessThanOrEqual(8);
});

test("gate: disagreement and schema failures clarify without planning", async () => {
  expect(resolveInterpretationGate({ fallback: true, reconcileOutcome: "disagree" })).toBe(
    "clarify",
  );
  expect(
    resolveInterpretationGate({ fallback: true, reconcileOutcome: "schema_rejected" }),
  ).toBe("clarify");
  expect(resolveInterpretationGate({ locked: true, fallback: true })).toBe("clarify");
  expect(resolveInterpretationGate({ fallback: true })).toBe("plan");
  expect(resolveInterpretationGate({ fallback: false, reconcileOutcome: "agree" })).toBe(
    "plan",
  );
  expect(resolveInterpretationGate({ fallback: false, reconcileOutcome: "no_hints" })).toBe(
    "plan",
  );
  expect(
    resolveInterpretationGate({ fallback: true, reconcileOutcome: "authority_bypass" }),
  ).toBe("reject_authority_bypass");
  expect(
    resolveInterpretationGate({ fallback: true, reconcileOutcome: "narrative_rejected" }),
  ).toBe("reject_authority_bypass");
});

test("interpreter: outage falls back to deterministic planning gate", async () => {
  const fallback = createDeterministicFallbackModel("Tell Omnis what needs to be paid.");
  const { payload, log } = await interpretConversation(
    { userText: "Pay Alex 0.10 USDC.", messages: [] },
    fallback,
  );
  expect(payload.gate).toBe("plan");
  expect(payload.fallback).toBe(true);
  expect(typeof payload.message).toBe("string");
  expect(log.reconcileOutcome).toBe("fallback");
});

test("interpreter: locked tasks clarify without planning", async () => {
  const model = createMockConversationalModel();
  const { payload } = await interpretConversation(
    {
      userText: "Actually make that 0.20 USDC.",
      messages: [],
      task: { status: "settling", type: "pay_with_check", recipient: RECIPIENT },
    },
    model,
  );
  expect(payload.gate).toBe("clarify");
  expect(payload.locked).toBe(true);
  expect(payload.proposal).toBeUndefined();
});

test("interpreter: agreeing model plans with model copy", async () => {
  const model = createMockConversationalModel();
  const { payload } = await interpretConversation(
    {
      userText: "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
      messages: [],
    },
    model,
  );
  expect(payload.gate).toBe("plan");
  expect(payload.fallback).toBe(false);
  expect(payload.reconcileOutcome).toBe("agree");
  expect(typeof payload.message).toBe("string");
});

test("interpreter: disagreeing hints clarify and never plan", async () => {
  const disagreeing = Object.freeze({
    name: "stub-disagree",
    model: "stub-1",
    generate: async () => ({
      proposal: {
        assistantMessage: "I will pay a different wallet.",
        intent: "pay" as const,
        proposedActions: [{ type: "payment" as const }],
        clarification: { required: false, question: null },
        extractedHints: { recipient: OTHER_RECIPIENT },
      },
      provider: "stub-disagree",
      model: "stub-1",
    }),
  });
  const { payload } = await interpretConversation(
    {
      userText: "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
      messages: [],
    },
    disagreeing,
  );
  expect(payload.gate).toBe("clarify");
  expect(payload.reconcileOutcome).toBe("disagree");
  expect(payload.proposal).toBeUndefined();
  expect(typeof payload.message).toBe("string");
});

test("request: bigint money serializes for follow-up interpreter calls", async () => {
  const body = buildInterpretRequestBody("Actually make that 0.20 USDC.", {
    messages: [{ role: "user", content: "Pay " + RECIPIENT + " 0.10 USDC." }],
    pendingIntent: {
      type: "pay_with_check",
      recipient: RECIPIENT,
      paymentAmount: money("0.10", "USDC"),
      serviceBudget: money("0.05", "USD"),
    },
    task: {
      status: "planned",
      type: "pay_with_check",
      recipient: RECIPIENT,
      paymentAmount: money("0.10", "USDC"),
      serviceBudget: money("0.05", "USD"),
    },
    policy: { finalPaymentApprovalRequired: true },
  });
  const serialized = JSON.stringify(body);
  const revived = JSON.parse(serialized) as Record<string, unknown>;
  const pending = revived.pendingIntent as Record<string, unknown>;
  expect(hydrateMoney(pending.paymentAmount).units).toBe(BigInt(100000));
  const task = revived.task as Record<string, unknown>;
  expect(hydrateMoney(task.serviceBudget).units).toBe(BigInt(50000));
  const sanitized = sanitizePendingIntent(pending);
  expect(sanitized?.paymentAmount?.units).toBe(BigInt(100000));
  expect(sanitized?.recipient).toBe(RECIPIENT);
});

test("interpreter: model receives a bounded message window", async () => {
  let seenCount = 0;
  const spy = Object.freeze({
    name: "stub-spy",
    model: "stub-1",
    generate: async (input: {
      messages: ReadonlyArray<{ role: string; content: string }>;
    }) => {
      seenCount = input.messages.length;
      return {
        proposal: {
          assistantMessage: "What needs to get done? Share the task and budget.",
          intent: "clarify" as const,
          proposedActions: [],
          clarification: { required: true, question: "What needs to get done?" },
          extractedHints: {},
        },
        provider: "stub-spy",
        model: "stub-1",
      };
    },
  });
  const { payload } = await interpretConversation(
    {
      userText: "Pay Alex.",
      messages: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: "message " + index,
      })),
    },
    spy,
  );
  expect(payload.reconcileOutcome).toBe("no_hints");
  expect(seenCount).toBeLessThanOrEqual(9);
});

test("interpreter: bare correction with task context plans without disagreement", async () => {
  const model = createMockConversationalModel();
  const { payload } = await interpretConversation(
    {
      userText: "Actually make that 0.20.",
      messages: [],
      pendingIntent: {
        type: "pay_with_check",
        recipient: RECIPIENT,
        paymentAmount: money("0.10", "USDC"),
        paymentAsset: "USDC",
        serviceBudget: money("0.05", "USD"),
      },
    },
    model,
  );
  expect(payload.gate).toBe("plan");
  expect(payload.reconcileOutcome).not.toBe("disagree");
  expect(payload.deterministic?.status).toBe("ready");
});

test("synthesize: wire facts survive JSON serialization", async () => {
  const facts = buildServiceSynthesisFacts(
    {
      paidAmount: money("0.003", "USD"),
      paymentAmount: money("0.003", "USD"),
      status: "paid",
      serviceResult: {
        observations: {
          wallet: RECIPIENT,
          addressValidity: "valid",
          accountType: "eoa",
          transactionCount: "0",
          transactionActivityObserved: false,
        },
        heuristicFlags: [
          {
            code: "no_observed_transaction_history",
            interpretation: "No history was observed. This is a heuristic input, not a fraud finding.",
          },
        ],
      },
    },
    money("0.05", "USD"),
    "0.10 USDC payment",
    true,
  );
  const wire = serializeServiceSynthesisFacts(facts);
  const serialized = JSON.stringify({ message: "x", fallback: true, facts: wire });
  const revived = JSON.parse(serialized) as { facts: { spent: { units: string } } };
  expect(revived.facts.spent.units).toBe("3000");
});

test("synthesize: late narrative loses to approval race", async () => {
  const snapshot = Object.freeze({ approval: undefined, settlement: undefined });
  expect(
    isSynthesisWriteStale({ approval: undefined, settlement: undefined }, snapshot),
  ).toBe(false);
  expect(
    isSynthesisWriteStale(
      { approval: { id: "appr-1" }, settlement: undefined },
      snapshot,
    ),
  ).toBe(true);
  expect(
    isSynthesisWriteStale(
      { approval: undefined, settlement: { id: "settle-1" } },
      snapshot,
    ),
  ).toBe(true);
});

test("interpreter: malformed model output never plans, outage does", async () => {
  const malformed = Object.freeze({
    name: "stub-malformed",
    model: "stub-1",
    generate: async (): Promise<never> => {
      throw new ModelOutputError("model output failed schema validation: intent unknown");
    },
  });
  const rejected = await interpretConversation(
    {
      userText: "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
      messages: [],
    },
    malformed,
  );
  expect(rejected.payload.gate).toBe("clarify");
  expect(rejected.payload.reconcileOutcome).toBe("schema_rejected");
  expect(rejected.payload.proposal).toBeUndefined();

  const outage = Object.freeze({
    name: "stub-outage",
    model: "stub-1",
    generate: async (): Promise<never> => {
      throw new Error("fetch failed");
    },
  });
  const fallback = await interpretConversation(
    {
      userText: "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
      messages: [],
    },
    outage,
  );
  expect(fallback.payload.gate).toBe("plan");
  expect(fallback.payload.reconcileOutcome).toBe("fallback");
});

test("provider: non-OK HTTP status stays on the outage path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 429,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const { createOpenAiCompatibleModel } = await import(
      "../src/lib/conversation/provider"
    );
    const live = createOpenAiCompatibleModel({
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const { payload } = await interpretConversation(
      {
        userText: "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
        messages: [],
      },
      live,
    );
    expect(payload.gate).toBe("plan");
    expect(payload.reconcileOutcome).toBe("fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider: non-JSON 200 response never plans", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("not json", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  try {
    const { createOpenAiCompatibleModel } = await import(
      "../src/lib/conversation/provider"
    );
    const live = createOpenAiCompatibleModel({
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const { payload } = await interpretConversation(
      {
        userText: "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
        messages: [],
      },
      live,
    );
    expect(payload.gate).toBe("clarify");
    expect(payload.reconcileOutcome).toBe("schema_rejected");
    expect(payload.proposal).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interpreter: approval-bypass copy clarifies without planning", async () => {
  expect(containsAuthorityBypassClaim("Paying now, no approval needed.")).toBe(true);
  expect(
    containsAuthorityBypassClaim("The payment is ready, but I still need your approval."),
  ).toBe(false);
  const bypassing = Object.freeze({
    name: "stub-bypass",
    model: "stub-1",
    generate: async () => ({
      proposal: {
        assistantMessage: "Paying now, no approval needed.",
        intent: "pay" as const,
        proposedActions: [{ type: "payment" as const }],
        clarification: { required: false, question: null },
        extractedHints: { recipient: RECIPIENT, paymentAmount: "0.10 USDC", asset: "USDC" },
      },
      provider: "stub-bypass",
      model: "stub-1",
    }),
  });
  const { payload } = await interpretConversation(
    {
      userText: "Pay " + RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
      messages: [],
    },
    bypassing,
  );
  expect(payload.gate).toBe("reject_authority_bypass");
  expect(payload.reconcileOutcome).toBe("narrative_rejected");
  expect(payload.proposal).toBeUndefined();
});

const SMOKE_RECIPIENT = "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7";
const SMOKE_INITIAL =
  "Before you pay Alex 0.10 USDC, make sure this wallet has actually been " +
  "used. You can spend up to five cents checking it, but ask me before you " +
  "send anything. His wallet is " +
  SMOKE_RECIPIENT +
  ".";

test("P9A.2 TEST A: smoke message resolves payment, budget, and recipient", async () => {
  const parsed = parseFinancialIntent(SMOKE_INITIAL);
  expect(parsed.status).toBe("ready");
  expect(parsed.intentType).toBe("pay_with_check");
  expect(parsed.fields.recipient).toBe(SMOKE_RECIPIENT);
  expect(parsed.fields.paymentAmount?.units).toBe(BigInt(100000));
  expect(parsed.fields.paymentAmount?.asset).toBe("USDC");
  expect(parsed.fields.serviceBudget?.units).toBe(BigInt(50000));
  expect(parsed.fields.serviceBudget?.asset).toBe("USD");
  expect(parsed.missing).toEqual([]);
  expect(parsed.ambiguities).toEqual([]);
  expect(parsed.clarification).toBeUndefined();
  const orchestrated = orchestrateFinancialIntent(parsed, { now: NOW });
  expect(orchestrated.kind).toBe("planned");
  if (orchestrated.kind !== "planned") throw new Error("expected a planned task");
  expect(orchestrated.task.status).toBe("planned");
  expect(orchestrated.task.recipient).toBe(SMOKE_RECIPIENT);
  expect(orchestrated.policy.finalPaymentApprovalRequired).toBe(true);
});

test("P9A.2 TEST A numeric budget variant resolves the same way", async () => {
  const parsed = parseFinancialIntent(
    "Before you pay Alex 0.10 USDC, make sure this wallet has actually been used. " +
      "Do not spend more than $0.05 checking, but ask me before you send anything. " +
      "His wallet is " +
      SMOKE_RECIPIENT +
      ".",
  );
  expect(parsed.status).toBe("ready");
  expect(parsed.fields.paymentAmount?.units).toBe(BigInt(100000));
  expect(parsed.fields.serviceBudget?.units).toBe(BigInt(50000));
  expect(parsed.fields.recipient).toBe(SMOKE_RECIPIENT);
});

test("P9A.2 TEST B: decimal correction updates the amount and keeps context", async () => {
  const first = parseFinancialIntent(SMOKE_INITIAL);
  expect(first.status).toBe("ready");
  const corrected = parseFinancialIntent("Actually make that 0.20.", {
    pendingIntent: first.fields,
  });
  expect(corrected.status).toBe("ready");
  expect(corrected.fields.paymentAmount?.units).toBe(BigInt(200000));
  expect(corrected.fields.paymentAmountText).toBe("0.20");
  expect(corrected.fields.recipient).toBe(SMOKE_RECIPIENT);
  expect(corrected.fields.serviceBudget?.units).toBe(BigInt(50000));
  expect(corrected.fields.type).toBe("pay_with_check");
  expect(corrected.clarification).toBeUndefined();
});

test("P9A.2 TEST B with task-shaped context updates the amount", async () => {
  const taskLike = {
    type: "pay_with_check" as const,
    recipient: SMOKE_RECIPIENT,
    paymentAmount: money("0.10", "USDC"),
    serviceBudget: money("0.05", "USD"),
  };
  const corrected = parseFinancialIntent("Actually make that 0.20.", {
    pendingIntent: taskLike,
  });
  expect(corrected.status).toBe("ready");
  expect(corrected.fields.paymentAmount?.units).toBe(BigInt(200000));
  expect(corrected.fields.recipient).toBe(SMOKE_RECIPIENT);
});

test("P9A.2 TEST C: bare integer correction asks instead of mutating", async () => {
  const first = parseFinancialIntent(SMOKE_INITIAL);
  const corrected = parseFinancialIntent("Actually make that 0.20.", {
    pendingIntent: first.fields,
  });
  const ambiguous = parseFinancialIntent("Actually send him 20.", {
    pendingIntent: corrected.fields,
  });
  expect(ambiguous.status).toBe("ambiguous");
  expect(ambiguous.fields.paymentAmount?.units).toBe(BigInt(200000));
  expect(ambiguous.fields.type).toBe("pay_with_check");
  expect(ambiguous.fields.recipient).toBe(SMOKE_RECIPIENT);
  expect(ambiguous.clarification).toBe("Do you mean 20 USDC?");
});

test("P9A.2 explicit-asset correction keeps the wallet-check requirement", async () => {
  const first = parseFinancialIntent(SMOKE_INITIAL);
  const corrected = parseFinancialIntent("Actually send him 20 USDC.", {
    pendingIntent: first.fields,
  });
  expect(corrected.status).toBe("ready");
  expect(corrected.fields.type).toBe("pay_with_check");
  expect(corrected.fields.paymentAmount?.units).toBe(BigInt(20000000));
  expect(corrected.fields.paymentAsset).toBe("USDC");
  expect(corrected.fields.recipient).toBe(SMOKE_RECIPIENT);
  expect(corrected.fields.serviceBudget?.units).toBe(BigInt(50000));
});

test("P9A.2 wallet-before-amount ordering resolves without bogus candidates", async () => {
  const parsed = parseFinancialIntent(
    "Pay 0xC446221191062923984729104820174029466Dc9 0.10 USDC, but check the wallet first. Spend no more than five cents checking.",
  );
  expect(parsed.status).toBe("ready");
  expect(parsed.intentType).toBe("pay_with_check");
  expect(parsed.fields.recipient).toBe("0xC446221191062923984729104820174029466Dc9");
  expect(parsed.fields.paymentAmount?.units).toBe(BigInt(100000));
  expect(parsed.fields.paymentAsset).toBe("USDC");
  expect(parsed.fields.serviceBudget?.units).toBe(BigInt(50000));
  expect(parsed.ambiguities).toEqual([]);
});

test("P9A.2 TEST D: missing recipient blocks execution until resolved", async () => {
  const initial = parseFinancialIntent(
    "Pay Alex 0.10 USDC, but check the wallet first. Spend no more than five cents checking.",
  );
  expect(initial.status).toBe("needs_clarification");
  expect(initial.missing).toContain("recipient");
  const orchestrated = orchestrateFinancialIntent(initial, { now: NOW });
  expect(orchestrated.kind).toBe("clarification");
  if (orchestrated.kind !== "clarification" || !orchestrated.task) {
    throw new Error("expected a draft task awaiting recipient");
  }
  expect(orchestrated.task.status).toBe("draft");
  expect(isServiceExecutionOffered(orchestrated.task, true)).toBe(false);
  const resolved = parseFinancialIntent("His wallet is " + SMOKE_RECIPIENT + ".", {
    pendingIntent: initial.fields,
  });
  expect(resolved.status).toBe("ready");
  expect(resolved.fields.recipient).toBe(SMOKE_RECIPIENT);
  expect(resolved.clarification).toBeUndefined();
  const replanned = orchestrateFinancialIntent(resolved, { now: NOW });
  expect(replanned.kind).toBe("planned");
  if (replanned.kind !== "planned") throw new Error("expected a planned task");
  expect(isServiceExecutionOffered(replanned.task, false)).toBe(true);
});

test("P9A.2 execution gate fails closed on drafts and missing fields", async () => {
  expect(isServiceExecutionOffered(undefined, false)).toBe(false);
  const draft = parseFinancialIntent(SMOKE_INITIAL);
  const draftTask = { status: "draft" as const };
  expect(isServiceExecutionOffered(draftTask, false)).toBe(false);
  expect(draft.status).toBe("ready");
  const orchestrated = orchestrateFinancialIntent(draft, { now: NOW });
  if (orchestrated.kind !== "planned") throw new Error("expected a planned task");
  expect(isServiceExecutionOffered(orchestrated.task, true)).toBe(false);
  expect(isServiceExecutionOffered(orchestrated.task, false)).toBe(true);
  expect(
    isServiceExecutionOffered({ ...orchestrated.task, recipient: undefined }, false),
  ).toBe(false);
  for (const status of [
    "draft",
    "settling",
    "completed",
    "failed",
    "cancelled",
  ] as const) {
    expect(isServiceExecutionOffered({ ...orchestrated.task, status }, false)).toBe(false);
  }
  for (const status of ["planned", "running", "awaiting_approval"] as const) {
    expect(isServiceExecutionOffered({ ...orchestrated.task, status }, false)).toBe(true);
  }
});

test("P9A.2 correction drops obsolete plan messages and reloads", async () => {
  const first = parseFinancialIntent(SMOKE_INITIAL);
  const planned = orchestrateFinancialIntent(first, { now: NOW, taskId: "task-smoke-a" });
  if (planned.kind !== "planned") throw new Error("expected a planned task");
  const userMessage = {
    id: "user-1",
    role: "user" as const,
    kind: "message" as const,
    content: SMOKE_INITIAL,
    createdAt: NOW,
  };
  const oldPlanMessage = {
    id: "omnis-1",
    role: "omnis" as const,
    kind: "plan" as const,
    content: "I can do that.",
    plan: planned.plan,
    createdAt: NOW,
  };
  const corrected = parseFinancialIntent("Actually make that 0.20.", {
    pendingIntent: first.fields,
  });
  const replanned = orchestrateFinancialIntent(corrected, { now: NOW, taskId: "task-smoke-b" });
  if (replanned.kind !== "planned") throw new Error("expected a replanned task");
  expect(replanned.task.id).not.toBe(planned.task.id);
  const retained = retainMessagesForTask(
    [userMessage, oldPlanMessage],
    replanned.task.id,
  );
  expect(retained.map((message) => message.id)).toEqual(["user-1"]);
  const reloaded = hydrateDraftSession(
    serializeDraftSession({
      version: TASK_SESSION_VERSION,
      messages: [
        ...retained,
        {
          id: "omnis-2",
          role: "omnis" as const,
          kind: "plan" as const,
          content: "Got it. I have updated the plan below.",
          plan: replanned.plan,
          createdAt: NOW,
        },
      ],
      task: replanned.task,
      policy: replanned.policy,
    }),
  );
  expect(reloaded?.task?.id).toBe("task-smoke-b");
  expect(reloaded?.messages).toHaveLength(2);
});
