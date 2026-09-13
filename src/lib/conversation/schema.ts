import type { SemanticExtraction } from "../intent/semantic";
import { validateSemanticExtraction } from "../intent/semantic";
import { isRecordObject } from "./guard";

export const PROPOSAL_INTENTS = [
  "pay",
  "pay_with_check",
  "research",
  "clarify",
  "status",
] as const;
export type ProposalIntent = (typeof PROPOSAL_INTENTS)[number];

export const PROPOSAL_ACTION_TYPES = [
  "wallet_check",
  "payment",
  "research",
] as const;
export type ProposalActionType = (typeof PROPOSAL_ACTION_TYPES)[number];

export type ConversationalProposal = Readonly<{
  assistantMessage: string;
  intent: ProposalIntent;
  proposedActions: ReadonlyArray<
    Readonly<{
      type: ProposalActionType;
    }>
  >;
  clarification: Readonly<{
    required: boolean;
    question: string | null;
  }>;
  extractedHints: Readonly<{
    recipient?: string;
    paymentAmount?: string;
    asset?: string;
    serviceBudget?: string;
  }>;
  semantic?: SemanticExtraction;
}>;

// Strict JSON Schema form of ConversationalProposal for Groq structured
// outputs. Single source of truth alongside PROPOSAL_INTENTS and
// PROPOSAL_ACTION_TYPES: provider.ts must import this, never redefine it.
// extractedHints members are nullable so strict mode can require stable
// object shape; the Groq adapter strips wire nulls before the unchanged
// runtime validator below.
// extractedHints is legacy and non-authoritative: it carries no evidence
// spans, is skipped by reconciliation whenever semantic is present, and
// never triggers promotion on its own.
export const CONVERSATIONAL_PROPOSAL_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "assistantMessage",
    "intent",
    "proposedActions",
    "clarification",
    "extractedHints",
    "semantic",
  ],
  properties: Object.freeze({
    assistantMessage: Object.freeze({ type: "string", minLength: 1, maxLength: 2000 }),
    intent: Object.freeze({ type: "string", enum: [...PROPOSAL_INTENTS] }),
    proposedActions: Object.freeze({
      type: "array",
      maxItems: 4,
      items: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: Object.freeze({
          type: Object.freeze({ type: "string", enum: [...PROPOSAL_ACTION_TYPES] }),
        }),
      }),
    }),
    clarification: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["required", "question"],
      properties: Object.freeze({
        required: Object.freeze({ type: "boolean" }),
        question: Object.freeze({ type: ["string", "null"] }),
      }),
    }),
    extractedHints: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["recipient", "paymentAmount", "asset", "serviceBudget"],
      properties: Object.freeze({
        recipient: Object.freeze({ type: ["string", "null"] }),
        paymentAmount: Object.freeze({ type: ["string", "null"] }),
        asset: Object.freeze({ type: ["string", "null"] }),
        serviceBudget: Object.freeze({ type: ["string", "null"] }),
      }),
    }),
    semantic: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: [
        "intent",
        "recipientAddress",
        "recipientEvidence",
        "recipientLabel",
        "paymentAmount",
        "paymentAsset",
        "paymentEvidence",
        "serviceBudgetAmount",
        "serviceBudgetAsset",
        "serviceBudgetEvidence",
        "requiresWalletCheck",
      ],
      properties: Object.freeze({
        intent: Object.freeze({ type: ["string", "null"] }),
        recipientAddress: Object.freeze({ type: ["string", "null"] }),
        recipientEvidence: Object.freeze({ type: ["string", "null"] }),
        recipientLabel: Object.freeze({ type: ["string", "null"] }),
        paymentAmount: Object.freeze({ type: ["string", "null"] }),
        paymentAsset: Object.freeze({ type: ["string", "null"] }),
        paymentEvidence: Object.freeze({ type: ["string", "null"] }),
        serviceBudgetAmount: Object.freeze({ type: ["string", "null"] }),
        serviceBudgetAsset: Object.freeze({ type: ["string", "null"] }),
        serviceBudgetEvidence: Object.freeze({ type: ["string", "null"] }),
        requiresWalletCheck: Object.freeze({ type: ["boolean", "null"] }),
      }),
    }),
  }),
});

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function validateConversationalProposal(
  value: unknown,
): { ok: true; proposal: ConversationalProposal } | { ok: false; error: string } {
  if (!isRecordObject(value)) return { ok: false, error: "proposal must be an object" };
  const assistantMessage = asTrimmedString(value.assistantMessage);
  if (!assistantMessage || assistantMessage.length > 2000) {
    return { ok: false, error: "assistantMessage must be non-empty text" };
  }
  if (
    typeof value.intent !== "string" ||
    !(PROPOSAL_INTENTS as readonly string[]).includes(value.intent)
  ) {
    return { ok: false, error: "intent must be a known proposal intent" };
  }
  if (!Array.isArray(value.proposedActions) || value.proposedActions.length > 4) {
    return { ok: false, error: "proposedActions must be an array of at most 4" };
  }
  for (const action of value.proposedActions) {
    if (
      !isRecordObject(action) ||
      typeof action.type !== "string" ||
      !(PROPOSAL_ACTION_TYPES as readonly string[]).includes(action.type)
    ) {
      return { ok: false, error: "proposedActions entries need a known type" };
    }
  }
  if (!isRecordObject(value.clarification)) {
    return { ok: false, error: "clarification must be an object" };
  }
  if (typeof value.clarification.required !== "boolean") {
    return { ok: false, error: "clarification.required must be boolean" };
  }
  const question = value.clarification.question;
  if (question !== null && (typeof question !== "string" || question.trim().length === 0)) {
    return { ok: false, error: "clarification.question must be null or text" };
  }
  if (
    value.clarification.required &&
    (typeof question !== "string" || question.trim().length === 0)
  ) {
    return { ok: false, error: "clarification.required needs a question" };
  }
  if (!isRecordObject(value.extractedHints)) {
    return { ok: false, error: "extractedHints must be an object" };
  }
  const hints = value.extractedHints;
  const recipient =
    hints.recipient === undefined ? undefined : asTrimmedString(hints.recipient);
  const paymentAmount =
    hints.paymentAmount === undefined ? undefined : asTrimmedString(hints.paymentAmount);
  const asset = hints.asset === undefined ? undefined : asTrimmedString(hints.asset);
  const serviceBudget =
    hints.serviceBudget === undefined ? undefined : asTrimmedString(hints.serviceBudget);
  if (
    (hints.recipient !== undefined && recipient === undefined) ||
    (hints.paymentAmount !== undefined && paymentAmount === undefined) ||
    (hints.asset !== undefined && asset === undefined) ||
    (hints.serviceBudget !== undefined && serviceBudget === undefined)
  ) {
    return { ok: false, error: "extractedHints entries must be text" };
  }
  const semanticCheck =
    value.semantic === undefined ? undefined : validateSemanticExtraction(value.semantic);
  if (semanticCheck && !semanticCheck.ok) return { ok: false, error: semanticCheck.error };
  const semantic =
    semanticCheck && semanticCheck.ok ? semanticCheck.proposal : undefined;
  return {
    ok: true,
    proposal: Object.freeze({
      assistantMessage,
      intent: value.intent as ProposalIntent,
      proposedActions: Object.freeze(
        (value.proposedActions as Array<{ type: ProposalActionType }>).map((action) =>
          Object.freeze({ type: action.type }),
        ),
      ),
      clarification: Object.freeze({
        required: value.clarification.required as boolean,
        question:
          typeof question === "string" && question.trim().length > 0
            ? question.trim().slice(0, 500)
            : null,
      }),
      extractedHints: Object.freeze({
        ...(recipient ? { recipient } : {}),
        ...(paymentAmount ? { paymentAmount } : {}),
        ...(asset ? { asset } : {}),
        ...(serviceBudget ? { serviceBudget } : {}),
      }),
      ...(semantic ? { semantic } : {}),
    }),
  };
}
