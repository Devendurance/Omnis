import "server-only";

import { NextResponse } from "next/server";
import { isRecordObject } from "@/lib/conversation/guard";
import { CONVERSATION_WINDOW_SIZE } from "@/lib/conversation/context";
import {
  interpretConversation,
  type InterpretMessage,
} from "@/lib/conversation/interpreter";
import {
  logConversationEvent,
  newConversationRequestId,
} from "@/lib/conversation/observability";
import { selectConversationalModel } from "@/lib/conversation/provider";
import {
  buildServiceSynthesisFacts,
  renderServiceSynthesisFallback,
  serializeServiceSynthesisFacts,
  validateSynthesisNarrative,
} from "@/lib/conversation/synthesize";
import { hydrateMoney } from "@/lib/domain/money";

const AVAILABLE_CAPABILITIES = Object.freeze([
  "wallet_check",
  "payment_planning",
  "research",
  "status_summary",
]);

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readMoneyField(value: unknown) {
  if (!isRecordObject(value)) return undefined;
  try {
    return hydrateMoney(value);
  } catch {
    return undefined;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newConversationRequestId();
  const startedAt = Date.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  if (!isRecordObject(body)) {
    return NextResponse.json({ error: "request body must be an object" }, { status: 400 });
  }
  const action = readStringField(body, "action") ?? "interpret";
  const userText = readStringField(body, "userText") ?? "";
  if (userText.length > 2000) {
    return NextResponse.json({ error: "userText is too long" }, { status: 400 });
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const history: InterpretMessage[] = rawMessages.flatMap((entry: unknown) => {
    if (!isRecordObject(entry)) return [];
    const role =
      entry.role === "user" ? "user" : entry.role === "assistant" ? "assistant" : undefined;
    const content =
      typeof entry.content === "string" ? entry.content.slice(0, 1000) : undefined;
    if (role === undefined || content === undefined) return [];
    const message: InterpretMessage =
      role === "user" ? { role: "user", content } : { role: "assistant", content };
    return [message];
  }).slice(-CONVERSATION_WINDOW_SIZE);

  if (action === "synthesize") {
    if (!isRecordObject(body.purchase)) {
      return NextResponse.json({ error: "purchase is required" }, { status: 400 });
    }
    const purchaseRecord = body.purchase;
    const paidAmount = readMoneyField(purchaseRecord.paidAmount);
    const paymentAmount = readMoneyField(purchaseRecord.paymentAmount);
    const status =
      typeof purchaseRecord.status === "string" ? purchaseRecord.status : "unknown";
    const serviceResult = isRecordObject(purchaseRecord.serviceResult)
      ? {
          observations: isRecordObject(purchaseRecord.serviceResult.observations)
            ? purchaseRecord.serviceResult.observations
            : {},
          heuristicFlags: Array.isArray(purchaseRecord.serviceResult.heuristicFlags)
            ? purchaseRecord.serviceResult.heuristicFlags
            : [],
        }
      : undefined;
    if (!paymentAmount) {
      return NextResponse.json({ error: "purchase amounts are required" }, { status: 400 });
    }
    const serviceBudget = isRecordObject(body.serviceBudget)
      ? readMoneyField(body.serviceBudget)
      : undefined;
    const paymentText = readStringField(body, "paymentText");
    const approvalStillRequired = body.approvalStillRequired !== false;
    const facts = buildServiceSynthesisFacts(
      {
        ...(paidAmount ? { paidAmount } : {}),
        paymentAmount,
        status,
        ...(serviceResult ? { serviceResult } : {}),
      },
      serviceBudget,
      paymentText,
      approvalStillRequired,
    );
    const fallback = renderServiceSynthesisFallback(facts);
    const wireFacts = serializeServiceSynthesisFacts(facts);
    const model = selectConversationalModel();
    if (model.name === "fallback") {
      logConversationEvent({
        requestId,
        provider: model.name,
        model: model.model,
        latencyMs: Date.now() - startedAt,
        schemaOk: true,
        reconcileOutcome: "synthesis_fallback",
        fallbackReason: "model_unavailable",
      });
      return NextResponse.json({ message: fallback, fallback: true, facts: wireFacts });
    }
    try {
      const result = await model.generate({
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          {
            role: "user",
            content: "Summarize this wallet check factually: " + JSON.stringify(wireFacts).slice(0, 2000),
          },
        ],
        taskContext: { mode: "synthesize" },
        availableCapabilities: [...AVAILABLE_CAPABILITIES],
      });
      const narrative = result.proposal.assistantMessage;
      if (!validateSynthesisNarrative(narrative, facts)) {
        logConversationEvent({
          requestId,
          provider: result.provider,
          model: result.model,
          latencyMs: Date.now() - startedAt,
          schemaOk: true,
          reconcileOutcome: "synthesis_rejected",
          fallbackReason: "narrative_failed_fact_check",
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
        });
        return NextResponse.json({ message: fallback, fallback: true, facts: wireFacts });
      }
      logConversationEvent({
        requestId,
        provider: result.provider,
        model: result.model,
        latencyMs: Date.now() - startedAt,
        schemaOk: true,
        reconcileOutcome: "synthesized",
        ...(result.providerRequestId
          ? { providerRequestId: result.providerRequestId }
          : {}),
      });
      return NextResponse.json({ message: narrative, fallback: false, facts: wireFacts });
    } catch (error) {
      logConversationEvent({
        requestId,
        provider: model.name,
        model: model.model,
        latencyMs: Date.now() - startedAt,
        schemaOk: false,
        reconcileOutcome: "synthesis_fallback",
        fallbackReason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      return NextResponse.json({ message: fallback, fallback: true, facts: wireFacts });
    }
  }

  const { payload, log } = await interpretConversation(
    {
      userText,
      messages: history,
      ...(isRecordObject(body.pendingIntent) ? { pendingIntent: body.pendingIntent } : {}),
      ...(typeof body.pendingField === "string" ? { pendingField: body.pendingField } : {}),
      ...(body.task !== undefined && body.task !== null ? { task: body.task } : {}),
      ...(body.policy !== undefined && body.policy !== null ? { policy: body.policy } : {}),
    },
    selectConversationalModel(),
  );
  logConversationEvent({
    requestId,
    provider: log.provider,
    model: log.model,
    latencyMs: Date.now() - startedAt,
    schemaOk: log.schemaOk,
    reconcileOutcome: log.reconcileOutcome,
    reconciliationStatus: log.reconciliationStatus,
    deterministicParseStatus: log.deterministicParseStatus,
    unresolvedFields: [...log.unresolvedFields],
    clarificationRequired: log.clarificationRequired,
    ...(log.proposalIntent ? { proposalIntent: log.proposalIntent } : {}),
    ...(log.fallbackReason ? { fallbackReason: log.fallbackReason } : {}),
    ...(log.providerRequestId ? { providerRequestId: log.providerRequestId } : {}),
    ...(log.evidenceValidation !== undefined
      ? { evidenceValidation: log.evidenceValidation }
      : {}),
    ...(log.semanticPromoted !== undefined ? { semanticPromoted: log.semanticPromoted } : {}),
  });
  return NextResponse.json(payload);
}
