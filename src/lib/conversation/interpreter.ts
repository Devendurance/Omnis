import { buildAuthoritativeParseResult, parseFinancialIntent, pendingFieldForIntent } from "../intent";
import { semanticFieldsToIntentFields, validateSemanticEvidence } from "../intent/semantic";
import type { FinancialIntentFields, FinancialIntentParseResult } from "../intent/types";
import {
  buildBoundedTaskContext,
  isTaskLockedForChat,
  type ChatPolicySummary,
  type ChatTaskSummary,
} from "./context";
import {
  containsAuthorityBypassClaim,
  SECURITY_REFUSAL_MESSAGE,
} from "./authority";
import { isRecordObject } from "./guard";
import {
  ModelOutputError,
  type ConversationGenerateResult,
  type ConversationalModel,
} from "./provider";
import {
  reconcileProposalWithDeterministicParse,
  reconcileSemanticWithDeterministicParse,
  resolveInterpretationGate,
  type InterpretationGate,
} from "./reconcile";
import { validateConversationalProposal } from "./schema";
import { hydrateMoney } from "../domain/money";
import { serializePromotedIntent } from "./promoted";
import { readPendingField } from "./request";

export const INTERPRETER_CAPABILITIES = Object.freeze([
  "wallet_check",
  "payment_planning",
  "research",
  "status_summary",
]);
export const INVENTED_SUCCESS_PATTERNS = Object.freeze([
  /0x[0-9a-fA-F]{64}\b/,
  /\btx[_-]?hash\b/i,
  /\bsettled\b/i,
  /\bpaid[!?.]/,
  /\b(already|just|have been|has been|was|were|got|been) paid\b/i,
  /\bpaid (out|in full|successfully)\b/i,
  /\bpayment (is |was )?(complete|completed|confirmed|successful|done)\b/i,
  /\bsuccessfully (paid|sent|transferred|settled)\b/i,
  /\b(funds|money) (have |has )?(moved|been sent|sent|transferred)\b/i,
  /\btransaction (confirmed|complete|completed|successful|submitted)\b/i,
  /\breceipt\b/i,
  /\bproof (is )?ready\b/i,
]);

export function containsInventedSuccessClaim(text: string): boolean {
  return INVENTED_SUCCESS_PATTERNS.some((pattern) => pattern.test(text));
}

export {
  AUTHORITY_BYPASS_PATTERNS,
  containsAuthorityBypassClaim,
  SECURITY_REFUSAL_MESSAGE,
} from "./authority";

export type InterpretMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export type InterpretInput = Readonly<{
  userText: string;
  messages: ReadonlyArray<InterpretMessage>;
  pendingIntent?: unknown;
  pendingField?: unknown;
  task?: unknown;
  policy?: unknown;
}>;

export type InterpretPayload = Readonly<{
  message: string;
  fallback: boolean;
  locked?: boolean;
  reconcileOutcome: string;
  gate: InterpretationGate;
  proposal?: unknown;
  promotedIntent?: Readonly<Record<string, unknown>>;
  deterministic?: Readonly<{
    status: string;
    missing: ReadonlyArray<string>;
    clarification: string | null;
  }>;
}>;

export type InterpretLog = Readonly<{
  provider: string;
  model: string;
  schemaOk: boolean;
  reconcileOutcome: string;
  reconciliationStatus: string;
  deterministicParseStatus: string;
  unresolvedFields: readonly string[];
  clarificationRequired: boolean;
  proposalIntent?: string;
  fallbackReason?: string;
  providerRequestId?: string;
  evidenceValidation?: boolean;
  semanticPromoted?: boolean;
  latencyMs?: number;
}>;

export function readTaskSummary(value: unknown): ChatTaskSummary | undefined {
  if (!isRecordObject(value)) return undefined;
  if (typeof value.status !== "string") return undefined;
  const summary: {
    status: string;
    type?: string;
    recipient?: string | null;
    paymentAmount?: unknown;
    serviceBudget?: unknown;
  } = { status: value.status };
  if (typeof value.type === "string") summary.type = value.type;
  if (typeof value.recipient === "string") summary.recipient = value.recipient;
  if (value.paymentAmount !== undefined && value.paymentAmount !== null) {
    summary.paymentAmount = value.paymentAmount;
  }
  if (value.serviceBudget !== undefined && value.serviceBudget !== null) {
    summary.serviceBudget = value.serviceBudget;
  }
  return Object.freeze(summary);
}

export function readPolicySummary(value: unknown): ChatPolicySummary | undefined {
  if (!isRecordObject(value)) return undefined;
  if (typeof value.finalPaymentApprovalRequired === "boolean") {
    return Object.freeze({
      finalPaymentApprovalRequired: value.finalPaymentApprovalRequired,
    });
  }
  return Object.freeze({});
}

function readMoneyField(value: unknown) {
  if (!isRecordObject(value)) return undefined;
  try {
    return hydrateMoney(value);
  } catch {
    return undefined;
  }
}

export function sanitizePendingIntent(value: unknown): FinancialIntentFields | undefined {
  if (!isRecordObject(value)) return undefined;
  const out: {
    type?: "pay" | "pay_with_check" | "delegate";
    recipient?: string;
    paymentAmountText?: string;
    paymentAsset?: string;
    purpose?: string;
  } = {};
  if (
    value.type === "pay" ||
    value.type === "pay_with_check" ||
    value.type === "delegate"
  ) {
    out.type = value.type;
  }
  if (typeof value.recipient === "string" && value.recipient.trim().length > 0) {
    out.recipient = value.recipient;
  }
  if (typeof value.paymentAmountText === "string" && value.paymentAmountText.trim().length > 0) {
    out.paymentAmountText = value.paymentAmountText;
  }
  if (typeof value.paymentAsset === "string" && value.paymentAsset.trim().length > 0) {
    out.paymentAsset = value.paymentAsset;
  }
  if (typeof value.purpose === "string" && value.purpose.trim().length > 0) {
    out.purpose = value.purpose;
  }
  const paymentAmount = readMoneyField(value.paymentAmount);
  const serviceBudget = readMoneyField(value.serviceBudget);
  const perServiceCap = readMoneyField(value.perServiceCap);
  return Object.freeze({
    ...out,
    ...(paymentAmount ? { paymentAmount } : {}),
    ...(serviceBudget ? { serviceBudget } : {}),
    ...(perServiceCap ? { perServiceCap } : {}),
  });
}

function deterministicLogFields(
  status: string,
  missing: readonly string[],
  reconciliationStatus: string,
): {
  readonly reconciliationStatus: string;
  readonly deterministicParseStatus: string;
  readonly unresolvedFields: readonly string[];
  readonly clarificationRequired: boolean;
} {
  return {
    reconciliationStatus,
    deterministicParseStatus: status,
    unresolvedFields: Object.freeze([...missing]),
    clarificationRequired: status !== "ready",
  };
}
function buildPromotedFields(
  deterministic: FinancialIntentParseResult,
  task: ChatTaskSummary | undefined,
  semantic: FinancialIntentFields | undefined,
  requiresWalletCheck: boolean | undefined,
): FinancialIntentFields {
  const merged: {
    type?: FinancialIntentFields["type"];
    recipient?: string;
    paymentAmountText?: string;
    paymentAsset?: string;
    paymentAmount?: FinancialIntentFields["paymentAmount"];
    purpose?: string;
    serviceBudget?: FinancialIntentFields["serviceBudget"];
    perServiceCap?: FinancialIntentFields["perServiceCap"];
    finalPaymentApprovalRequired?: boolean;
    unsupportedAsset?: string;
  } = { ...deterministic.fields };
  if (merged.recipient === undefined && task?.recipient) {
    merged.recipient = task.recipient;
  }
  const taskType = task?.type;
  if (
    merged.type === undefined &&
    (taskType === "pay" || taskType === "pay_with_check" || taskType === "delegate")
  ) {
    merged.type = taskType;
  }
  if (semantic) {
    if (semantic.recipient !== undefined) merged.recipient = semantic.recipient;
    if (semantic.paymentAmountText !== undefined) {
      merged.paymentAmountText = semantic.paymentAmountText;
      merged.paymentAsset = semantic.paymentAsset;
      merged.paymentAmount = semantic.paymentAmount;
      if (merged.unsupportedAsset !== undefined && semantic.paymentAsset === "USDC") {
        merged.unsupportedAsset = undefined;
      }
    }
    if (semantic.serviceBudget !== undefined) merged.serviceBudget = semantic.serviceBudget;
    if (semantic.type !== undefined && merged.type === undefined) {
      merged.type = semantic.type;
    }
    if (semantic.type === "pay_with_check" && merged.type === "pay") {
      merged.type = "pay_with_check";
    }
    if (requiresWalletCheck === false && merged.type === "pay_with_check") {
      merged.type = "pay";
    }
  }
  if (requiresWalletCheck === true && merged.type === "pay") {
    merged.type = "pay_with_check";
  }
  if (
    merged.type !== undefined &&
    merged.finalPaymentApprovalRequired === undefined
  ) {
    merged.finalPaymentApprovalRequired = merged.type !== "delegate";
  }
  return Object.freeze(merged);
}
function toEvidenceValue(value: unknown): { units: bigint; asset: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.units === "bigint" && typeof record.asset === "string") {
    return { units: record.units, asset: record.asset };
  }
  try {
    const hydrated = hydrateMoney(value);
    return { units: hydrated.units, asset: hydrated.asset };
  } catch {
    return undefined;
  }
}

export async function interpretConversation(
  input: InterpretInput,
  model: ConversationalModel,
): Promise<{ payload: InterpretPayload; log: InterpretLog }> {
  const task = readTaskSummary(input.task);
  const policy = readPolicySummary(input.policy);

  if (isTaskLockedForChat(task)) {
    return {
      payload: Object.freeze({
        message:
          "This task is already underway or complete, so chat cannot rewrite it. Start a new task to change the payment.",
        fallback: true,
        locked: true,
        reconcileOutcome: "locked",
        gate: resolveInterpretationGate({ locked: true, fallback: true }),
      }),
      log: Object.freeze({
        provider: "deterministic",
        model: "locked-task-guard",
        schemaOk: true,
        reconcileOutcome: "locked",
        reconciliationStatus: "locked",
        deterministicParseStatus: "locked",
        unresolvedFields: Object.freeze(["task_locked"]),
        clarificationRequired: true,
      }),
    };
  }

  const pendingIntent = sanitizePendingIntent(input.pendingIntent);
  const pendingField = readPendingField(input.pendingField) ?? pendingFieldForIntent(pendingIntent);
  const deterministic = parseFinancialIntent(input.userText, {
    ...(pendingIntent ? { pendingIntent } : {}),
    ...(pendingField ? { pendingField } : {}),
  });
  const deterministicSummary = Object.freeze({
    status: deterministic.status,
    missing: deterministic.missing,
    clarification: deterministic.clarification ?? null,
  });
  const fallbackMessage =
    deterministic.clarification ?? "Tell Omnis what needs to be paid or researched.";

  // Deterministic user-text guard: approval-bypass phrasing fails closed
  // before any model call, so no provider (mock or real) can launder it.
  // P9A.4: the fixed refusal carries no amount, and the typed
  // reject_authority_bypass gate lets the composer short-circuit before
  // any financial parser or orchestrator sees this turn.
  if (containsAuthorityBypassClaim(input.userText)) {
    return {
      payload: Object.freeze({
        message: SECURITY_REFUSAL_MESSAGE,
        fallback: true,
        reconcileOutcome: "authority_bypass",
        gate: resolveInterpretationGate({
          fallback: true,
          reconcileOutcome: "authority_bypass",
        }),
        deterministic: deterministicSummary,
      }),
      log: Object.freeze({
        provider: "deterministic",
        model: "authority-bypass-guard",
        schemaOk: true,
        reconcileOutcome: "authority_bypass",
        ...deterministicLogFields(deterministic.status, deterministic.missing, "authority_bypass"),
        clarificationRequired: true,
      }),
    };
  }
  if (model.name === "fallback") {
    return {
      payload: Object.freeze({
        message: fallbackMessage,
        fallback: true,
        reconcileOutcome: "fallback",
        gate: resolveInterpretationGate({ fallback: true }),
        deterministic: deterministicSummary,
      }),
      log: Object.freeze({
        provider: model.name,
        model: model.model,
        schemaOk: true,
        reconcileOutcome: "fallback",
        ...deterministicLogFields(deterministic.status, deterministic.missing, "fallback"),
        fallbackReason: "model_unavailable",
      }),
    };
  }
  let modelLatencyMs: number | undefined;
  try {
    const taskContext = buildBoundedTaskContext(task, policy);
    const generateStart = Date.now();
    let result: ConversationGenerateResult;
    try {
      result = await model.generate({
        messages: [
          ...input.messages.slice(-8).map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: input.userText.slice(0, 1000) },
        ],
        taskContext: {
          ...taskContext,
          ...(pendingField ? { pendingField } : {}),
        },
        availableCapabilities: [...INTERPRETER_CAPABILITIES],
      });
    } finally {
      modelLatencyMs = Date.now() - generateStart;
    }
    const validated = validateConversationalProposal(result.proposal);
    if (!validated.ok) {
      return {
        payload: Object.freeze({
          message: fallbackMessage,
          fallback: true,
          reconcileOutcome: "schema_rejected",
          gate: resolveInterpretationGate({
            fallback: true,
            reconcileOutcome: "schema_rejected",
          }),
        }),
        log: Object.freeze({
          provider: result.provider,
          model: result.model,
          schemaOk: false,
          reconcileOutcome: "schema_rejected",
          ...deterministicLogFields(deterministic.status, deterministic.missing, "schema_rejected"),
          fallbackReason: validated.error,
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
          ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
        }),
      };
    }
    if (
      deterministic.status === "ambiguous" ||
      deterministic.status === "unsupported" ||
      deterministic.ambiguities.length > 0
    ) {
      return {
        payload: Object.freeze({
          message: fallbackMessage,
          fallback: true,
          reconcileOutcome: "disagree",
          gate: resolveInterpretationGate({ fallback: true, reconcileOutcome: "disagree" }),
          deterministic: deterministicSummary,
        }),
        log: Object.freeze({
          provider: result.provider,
          model: result.model,
          schemaOk: true,
          reconcileOutcome: "disagree",
          ...deterministicLogFields(deterministic.status, deterministic.missing, "disagree"),
          proposalIntent: validated.proposal.intent,
          evidenceValidation: false,
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
          ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
        }),
      };
    }
    const hasSemantic = validated.proposal.semantic !== undefined;
    const reconciliation = hasSemantic
      ? { outcome: "agree" as const }
      : reconcileProposalWithDeterministicParse(
          validated.proposal,
          deterministic,
          input.userText,
        );
    if (reconciliation.outcome === "disagree") {
      return {
        payload: Object.freeze({
          message: reconciliation.clarification,
          fallback: true,
          reconcileOutcome: "disagree",
          gate: resolveInterpretationGate({ fallback: true, reconcileOutcome: "disagree" }),
          deterministic: deterministicSummary,
        }),
        log: Object.freeze({
          provider: result.provider,
          model: result.model,
          schemaOk: true,
          reconcileOutcome: "disagree",
          ...deterministicLogFields(deterministic.status, deterministic.missing, "disagree"),
          proposalIntent: validated.proposal.intent,
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
          ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
        }),
      };
    }
    const semanticProposal = validated.proposal.semantic;
    let evidenceValidation: boolean | undefined;
    let semanticPromoted = false;
    let promotedSemantic: FinancialIntentFields | undefined;
    let promotedRequiresCheck: boolean | undefined;
    if (semanticProposal) {
      const pendingPayment = toEvidenceValue(pendingIntent?.paymentAmount);
      const pendingBudget = toEvidenceValue(pendingIntent?.serviceBudget);
      const taskPayment = toEvidenceValue(task?.paymentAmount);
      const taskBudget = toEvidenceValue(task?.serviceBudget);
      const deterministicPayment = toEvidenceValue(deterministic.fields.paymentAmount);
      const deterministicBudget = toEvidenceValue(deterministic.fields.serviceBudget);
      const evidence = validateSemanticEvidence(semanticProposal, {
        sourceText: input.userText,
        ...(pendingIntent?.recipient ? { pendingRecipient: pendingIntent.recipient } : {}),
        ...(pendingPayment ? { pendingPayment } : {}),
        ...(pendingBudget ? { pendingServiceBudget: pendingBudget } : {}),
        ...(task?.recipient ? { taskRecipient: task.recipient } : {}),
        ...(taskPayment ? { taskPayment } : {}),
        ...(taskBudget ? { taskServiceBudget: taskBudget } : {}),
        ...(deterministicPayment ? { deterministicPayment } : {}),
        ...(deterministicBudget ? { deterministicServiceBudget: deterministicBudget } : {}),
      });
      if (!evidence.ok) {
        return {
          payload: Object.freeze({
            message: fallbackMessage,
            fallback: true,
            reconcileOutcome: "disagree",
            gate: resolveInterpretationGate({ fallback: true, reconcileOutcome: "disagree" }),
            deterministic: deterministicSummary,
          }),
          log: Object.freeze({
            provider: result.provider,
            model: result.model,
            schemaOk: true,
            reconcileOutcome: "disagree",
            ...deterministicLogFields(deterministic.status, deterministic.missing, "disagree"),
            proposalIntent: validated.proposal.intent,
            evidenceValidation: false,
            ...(result.providerRequestId
              ? { providerRequestId: result.providerRequestId }
              : {}),
            ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
          }),
        };
      }
      evidenceValidation = true;
      const semanticReconciliation = reconcileSemanticWithDeterministicParse(
        evidence.fields,
        deterministic,
      );
      if (semanticReconciliation.outcome === "disagree") {
        return {
          payload: Object.freeze({
            message: semanticReconciliation.clarification,
            fallback: true,
            reconcileOutcome: "disagree",
            gate: resolveInterpretationGate({ fallback: true, reconcileOutcome: "disagree" }),
            deterministic: deterministicSummary,
          }),
          log: Object.freeze({
            provider: result.provider,
            model: result.model,
            schemaOk: true,
            reconcileOutcome: "disagree",
            ...deterministicLogFields(deterministic.status, deterministic.missing, "disagree"),
            proposalIntent: validated.proposal.intent,
            evidenceValidation: true,
            ...(result.providerRequestId
              ? { providerRequestId: result.providerRequestId }
              : {}),
            ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
          }),
        };
      }
      semanticPromoted =
        evidence.fields.recipient !== undefined ||
        evidence.fields.paymentAmountText !== undefined ||
        evidence.fields.serviceBudgetText !== undefined ||
        evidence.fields.requiresWalletCheck !== undefined;
      promotedSemantic = semanticFieldsToIntentFields(evidence.fields);
      promotedRequiresCheck = evidence.fields.requiresWalletCheck;
    }
    if (
      containsInventedSuccessClaim(validated.proposal.assistantMessage) ||
      containsAuthorityBypassClaim(validated.proposal.assistantMessage)
    ) {
      return {
        payload: Object.freeze({
          message: fallbackMessage,
          fallback: true,
          reconcileOutcome: "narrative_rejected",
          gate: resolveInterpretationGate({
            fallback: true,
            reconcileOutcome: "narrative_rejected",
          }),
        }),
        log: Object.freeze({
          provider: result.provider,
          model: result.model,
          schemaOk: false,
          reconcileOutcome: "narrative_rejected",
          ...deterministicLogFields(deterministic.status, deterministic.missing, "narrative_rejected"),
          proposalIntent: validated.proposal.intent,
          fallbackReason: "assistant message claimed unconfirmed success",
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
          ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
        }),
      };
    }
    const promotedFields: FinancialIntentFields = buildPromotedFields(
      deterministic,
      task,
      promotedSemantic,
      promotedRequiresCheck,
    );
    const hasFinancialPlan =
      promotedFields.type === "pay" ||
      promotedFields.type === "pay_with_check" ||
      promotedFields.type === "delegate";
    const authoritative =
      semanticPromoted === true && hasFinancialPlan
        ? buildAuthoritativeParseResult(promotedFields, {
            sourceText: input.userText,
            ...(pendingIntent !== undefined || task !== undefined ? { hadPending: true } : {}),
          })
        : undefined;
    if (authoritative !== undefined && authoritative.status !== "ready") {
      return {
        payload: Object.freeze({
          message: authoritative.clarification ?? fallbackMessage,
          fallback: true,
          reconcileOutcome: "promotion_rejected",
          gate: resolveInterpretationGate({
            fallback: true,
            reconcileOutcome: "promotion_rejected",
          }),
          deterministic: Object.freeze({
            status: authoritative.status,
            missing: authoritative.missing,
            clarification: authoritative.clarification ?? null,
          }),
        }),
        log: Object.freeze({
          provider: result.provider,
          model: result.model,
          schemaOk: true,
          reconcileOutcome: "promotion_rejected",
          ...deterministicLogFields(authoritative.status, authoritative.missing, "promotion_rejected"),
          proposalIntent: validated.proposal.intent,
          ...(evidenceValidation !== undefined ? { evidenceValidation } : {}),
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
          ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
        }),
      };
    }
    return {
      payload: Object.freeze({
        message: validated.proposal.assistantMessage,
        fallback: false,
        reconcileOutcome: reconciliation.outcome,
        gate: resolveInterpretationGate({
          fallback: false,
          reconcileOutcome: reconciliation.outcome,
        }),
        proposal: validated.proposal,
        ...(semanticPromoted
          ? { promotedIntent: serializePromotedIntent(promotedFields) }
          : {}),
        deterministic: deterministicSummary,
      }),
      log: Object.freeze({
        provider: result.provider,
        model: result.model,
        schemaOk: true,
        reconcileOutcome: reconciliation.outcome,
        ...deterministicLogFields(deterministic.status, deterministic.missing, reconciliation.outcome),
        proposalIntent: validated.proposal.intent,
        ...(evidenceValidation !== undefined ? { evidenceValidation } : {}),
        ...(semanticPromoted ? { semanticPromoted } : {}),
        ...(result.providerRequestId
          ? { providerRequestId: result.providerRequestId }
          : {}),
        ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
      }),
    };
  } catch (error) {
    if (error instanceof ModelOutputError) {
      return {
        payload: Object.freeze({
          message: fallbackMessage,
          fallback: true,
          reconcileOutcome: "schema_rejected",
          gate: resolveInterpretationGate({
            fallback: true,
            reconcileOutcome: "schema_rejected",
          }),
          deterministic: deterministicSummary,
        }),
        log: Object.freeze({
          provider: model.name,
          model: model.model,
          schemaOk: false,
          reconcileOutcome: "schema_rejected",
          ...deterministicLogFields(deterministic.status, deterministic.missing, "schema_rejected"),
          fallbackReason: error.message.slice(0, 200),
          ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
        }),
      };
    }
    return {
      payload: Object.freeze({
        message: fallbackMessage,
        fallback: true,
        reconcileOutcome: "fallback",
        gate: resolveInterpretationGate({ fallback: true }),
      }),
      log: Object.freeze({
        provider: model.name,
        model: model.model,
        schemaOk: false,
        reconcileOutcome: "fallback",
        ...deterministicLogFields(deterministic.status, deterministic.missing, "fallback"),
        fallbackReason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        ...(modelLatencyMs !== undefined ? { latencyMs: modelLatencyMs } : {}),
      }),
    };
  }
}
