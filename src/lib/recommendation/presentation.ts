import { formatMoney } from "../domain";

import type { BoundedServiceCandidate } from "./dto";
import type { StoredServiceRecommendation } from "./verifier";

// P9B.1 presentation integrity. Badge wording and fact bullets derive from
// the verified candidate DTO and the recommendation provider, never from
// model prose. Only the real Groq provider earns "Recommended by Omnis";
// deterministic/mock output is labeled as a preview so it cannot imply
// real model judgment.
export const RECOMMENDATION_BADGE_VERIFIED = "Recommended by Omnis" as const;
export const RECOMMENDATION_BADGE_PREVIEW = "Recommendation preview" as const;
// Visible advisory marker rendered above model rationale so free-form prose
// can never read as authoritative product state. Deterministic facts below
// it always win on conflict.
export const RECOMMENDATION_RATIONALE_ADVISORY =
  "advisory · model suggestion" as const;

export function recommendationBadge(
  stored: Pick<
    StoredServiceRecommendation,
    "verified" | "fallback" | "recommendedServiceId" | "provider"
  >,
): string | null {
  if (
    !stored.verified ||
    stored.fallback ||
    stored.recommendedServiceId === null
  ) {
    return null;
  }
  return stored.provider === "groq-recommendation"
    ? RECOMMENDATION_BADGE_VERIFIED
    : RECOMMENDATION_BADGE_PREVIEW;
}

export type RecommendationFacts = Readonly<{
  capabilityLabel: string;
  executableLabel: string;
  networkLine: string;
  costLabel: string;
  budgetAfterLabel: string;
}>;

// Authoritative fact bullets, synthesized entirely from the verified
// candidate DTO. Model rationale is advisory prose only and never feeds
// these values, so a malicious or wrong rationale cannot alter them.
export function recommendationFacts(
  candidate: BoundedServiceCandidate,
): RecommendationFacts {
  return Object.freeze({
    capabilityLabel: `Matches ${candidate.capability.replaceAll("-", " ")} capability`,
    executableLabel: candidate.executable ? "Executable now" : "Not executable",
    networkLine: `${candidate.network} · ${candidate.paymentProtocol}`,
    costLabel: `Cost: $${formatMoney(candidate.price)}`,
    budgetAfterLabel: candidate.projectedRemainingBudget
      ? `Budget after: $${formatMoney(candidate.projectedRemainingBudget)}`
      : "Budget after: unavailable",
  });
}
