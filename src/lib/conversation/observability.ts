export type ConversationLogFields = Readonly<{
  requestId: string;
  provider: string;
  model: string;
  latencyMs: number;
  schemaOk: boolean;
  reconcileOutcome?: string;
  reconciliationStatus?: string;
  deterministicParseStatus?: string;
  unresolvedFields?: readonly string[];
  clarificationRequired?: boolean;
  proposalIntent?: string;
  fallbackReason?: string;
  providerRequestId?: string;
  evidenceValidation?: boolean;
  semanticPromoted?: boolean;
}>;

export function logConversationEvent(fields: ConversationLogFields): void {
  console.log(
    JSON.stringify({
      event: "p9a_conversation",
      ...fields,
    }),
  );
}

export function newConversationRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "req-" + Date.now().toString(36);
}
