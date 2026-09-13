import { isRecordObject } from "../conversation/guard";

// P9B recommendation schema. Separate strict typed result; the existing
// conversational proposal schema is untouched (P9A frozen).
export type ServiceRecommendationComparison = Readonly<{
  serviceId: string;
  assessment: string;
}>;

export type ServiceRecommendation = Readonly<{
  recommendedServiceId: string | null;
  rationale: string;
  comparisons: readonly ServiceRecommendationComparison[];
  clarificationRequired: boolean;
  clarificationQuestion: string | null;
}>;

export const SERVICE_RECOMMENDATION_SCHEMA_NAME =
  "service_recommendation" as const;

export const SERVICE_RECOMMENDATION_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "recommendedServiceId",
    "rationale",
    "comparisons",
    "clarificationRequired",
    "clarificationQuestion",
  ],
  properties: Object.freeze({
    recommendedServiceId: Object.freeze({ type: ["string", "null"] }),
    rationale: Object.freeze({ type: "string", minLength: 1, maxLength: 1000 }),
    comparisons: Object.freeze({
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["serviceId", "assessment"],
        properties: Object.freeze({
          serviceId: Object.freeze({ type: "string", minLength: 1 }),
          assessment: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: 500,
          }),
        }),
      }),
    }),
    clarificationRequired: Object.freeze({ type: "boolean" }),
    clarificationQuestion: Object.freeze({ type: ["string", "null"] }),
  }),
});

export type RecommendationValidation =
  | Readonly<{ ok: true; recommendation: ServiceRecommendation }>
  | Readonly<{ ok: false; error: string }>;

function readComparisons(value: unknown): ServiceRecommendationComparison[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25) {
    return undefined;
  }
  const comparisons: ServiceRecommendationComparison[] = [];
  for (const entry of value) {
    if (!isRecordObject(entry)) return undefined;
    if (typeof entry.serviceId !== "string" || entry.serviceId.length < 1) {
      return undefined;
    }
    if (
      typeof entry.assessment !== "string" ||
      entry.assessment.length < 1 ||
      entry.assessment.length > 500
    ) {
      return undefined;
    }
    comparisons.push(
      Object.freeze({ serviceId: entry.serviceId, assessment: entry.assessment }),
    );
  }
  return comparisons;
}

export function validateServiceRecommendation(
  value: unknown,
): RecommendationValidation {
  if (!isRecordObject(value)) {
    return { ok: false, error: "recommendation must be an object" };
  }
  const recommendedServiceId =
    value.recommendedServiceId === null ? null : value.recommendedServiceId;
  if (recommendedServiceId !== null && typeof recommendedServiceId !== "string") {
    return { ok: false, error: "recommendedServiceId must be a string or null" };
  }
  if (typeof value.rationale !== "string" || value.rationale.length < 1) {
    return { ok: false, error: "rationale must be a non-empty string" };
  }
  const comparisons = readComparisons(value.comparisons);
  if (!comparisons) {
    return { ok: false, error: "comparisons must be a non-empty array" };
  }
  if (typeof value.clarificationRequired !== "boolean") {
    return { ok: false, error: "clarificationRequired must be a boolean" };
  }
  const clarificationQuestion =
    value.clarificationQuestion === null ? null : value.clarificationQuestion;
  if (clarificationQuestion !== null && typeof clarificationQuestion !== "string") {
    return {
      ok: false,
      error: "clarificationQuestion must be a string or null",
    };
  }
  return {
    ok: true,
    recommendation: Object.freeze({
      recommendedServiceId,
      rationale: value.rationale,
      comparisons: Object.freeze(comparisons),
      clarificationRequired: value.clarificationRequired,
      clarificationQuestion,
    }),
  };
}
