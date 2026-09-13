import "server-only";

import { isRecordObject } from "@/lib/conversation/guard";
import { logConversationEvent, newConversationRequestId } from "@/lib/conversation/observability";
import {
  recommendService,
  selectRecommendationModel,
} from "@/lib/recommendation";
import { resolveRequiredCapability } from "@/lib/services/capabilities";
import { getP4ALiveServiceRegistry } from "@/lib/services/server/p4a";
import { hydrateDraftSession } from "@/lib/tasks/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// P9B recommendation endpoint. The client sends its serialized draft
// session; the server rehydrates it against the live runtime registry,
// evaluates bounded candidates deterministically, asks the model to compare
// them, verifies the answer, and falls back to deterministic selection on
// any failure. The model recommends; it never authorizes or spends.
export async function POST(request: Request): Promise<Response> {
  const requestId = newConversationRequestId();
  const startedAt = Date.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }
  if (!isRecordObject(body)) {
    return Response.json({ error: "request body must be an object" }, { status: 400 });
  }
  const serialized = body.session;
  if (typeof serialized !== "string" || serialized.length === 0) {
    return Response.json({ error: "session is required" }, { status: 400 });
  }
  const registry = getP4ALiveServiceRegistry();
  let session;
  try {
    session = hydrateDraftSession(serialized, registry);
  } catch {
    return Response.json({ error: "session is invalid" }, { status: 400 });
  }
  if (!session?.task || !session.policy) {
    return Response.json({ error: "a validated task and policy are required" }, { status: 422 });
  }
  const requiredCapability = resolveRequiredCapability(session.task);
  if (!requiredCapability) {
    return Response.json(
      { error: "the task has no service capability to evaluate" },
      { status: 422 },
    );
  }
  const hasPendingClarification = session.pendingIntent !== undefined;
  const model = selectRecommendationModel();
  let outcome;
  try {
    outcome = await recommendService({
      task: session.task,
      policy: session.policy,
      registry,
      requiredCapability,
      ...(session.servicePurchases ? { existingPurchases: session.servicePurchases } : {}),
      hasPendingClarification,
      model,
      now: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "recommendation failed" },
      { status: 500 },
    );
  }
  logConversationEvent({
    requestId,
    provider: outcome.recommendationProvider,
    model: outcome.recommendationModel,
    latencyMs: Date.now() - startedAt,
    schemaOk: !outcome.fallback,
    reconcileOutcome: outcome.fallback
      ? "recommendation_fallback"
      : "recommendation_verified",
  });
  return Response.json({
    ok: true,
    stored: outcome.stored,
    candidates: outcome.candidateSet.candidates,
    deterministicServiceId: outcome.deterministic.selected?.descriptor.id ?? null,
    deterministicReason: outcome.deterministic.selectionReason,
    recommendationProvider: outcome.recommendationProvider,
    recommendationModel: outcome.recommendationModel,
    recommendationVerified: outcome.recommendationVerified,
    fallback: outcome.fallback,
    ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
  });
}
