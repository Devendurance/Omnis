import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createFinancialTask,
  createTaskPolicy,
  money,
  transitionTask,
  type FinancialTask,
  type TaskPolicy,
} from "../src/lib/domain";
import {
  buildRecommendationCandidateSet,
  buildRecommendationPayload,
  createMockRecommendationModel,
  RECOMMENDATION_BADGE_PREVIEW,
  RECOMMENDATION_BADGE_VERIFIED,
  RECOMMENDATION_MAX_CANDIDATES,
  RECOMMENDATION_MAX_DESCRIPTION_CHARS,
  recommendService,
  recommendationBadge,
  RECOMMENDATION_RATIONALE_ADVISORY,
  recommendationFacts,
  type BoundedServiceCandidate,
} from "../src/lib/recommendation";
import { createLiveServiceRegistry } from "../src/lib/services/registry";
import { WALLET_ACTIVITY_SERVICE_ID } from "../src/lib/services/wallet-activity-descriptor";

const NOW = "2026-09-13T12:00:00.000Z";
const RECIPIENT = "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7";

function makePolicy(overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return createTaskPolicy({
    taskId: "task-p9b1",
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: ["hedera:testnet", "local-preview"],
    allowedAssets: ["USD", "USDC"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
    ...overrides,
  });
}

function makeTask(policy: TaskPolicy = makePolicy()): FinancialTask {
  const draft = createFinancialTask(
    {
      id: policy.taskId,
      ownerId: "owner-p9b1",
      type: "pay_with_check",
      originalIntent: "Before you pay Alex 0.10 USDC, check this wallet first.",
      recipient: RECIPIENT,
      paymentAmount: money("0.10", "USDC"),
      purpose: "contractor payment",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  return transitionTask(draft, "planned", { now: NOW });
}

function liveSet() {
  const policy = makePolicy();
  const task = makeTask(policy);
  const registry = createLiveServiceRegistry("available");
  return { policy, task, registry };
}

function executableCandidate(
  candidates: readonly BoundedServiceCandidate[],
): BoundedServiceCandidate {
  const found = candidates.find((candidate) => candidate.executable);
  if (!found) throw new Error("expected an executable candidate");
  return found;
}

test("P9B1.1 real groq provider earns the Recommended by Omnis badge", () => {
  const stored = {
    verified: true,
    fallback: false,
    recommendedServiceId: WALLET_ACTIVITY_SERVICE_ID,
    provider: "groq-recommendation",
  };
  expect(recommendationBadge(stored)).toBe(RECOMMENDATION_BADGE_VERIFIED);
  expect(recommendationBadge(stored)).toBe("Recommended by Omnis");
});

test("P9B1.2 mock provider never earns the production badge", () => {
  const stored = {
    verified: true,
    fallback: false,
    recommendedServiceId: WALLET_ACTIVITY_SERVICE_ID,
    provider: "mock-recommendation",
  };
  expect(recommendationBadge(stored)).toBe(RECOMMENDATION_BADGE_PREVIEW);
  expect(recommendationBadge(stored)).not.toBe("Recommended by Omnis");
});

test("P9B1.3 fallback, unverified, or empty recommendations earn no badge", () => {
  const base = {
    recommendedServiceId: WALLET_ACTIVITY_SERVICE_ID,
    provider: "groq-recommendation",
  };
  expect(
    recommendationBadge({ ...base, verified: false, fallback: true }),
  ).toBe(null);
  expect(
    recommendationBadge({ ...base, verified: true, fallback: true }),
  ).toBe(null);
  expect(
    recommendationBadge({
      verified: false,
      fallback: false,
      recommendedServiceId: null,
      provider: "groq-recommendation",
    }),
  ).toBe(null);
});

test("P9B1.4 Why-this-service facts come from the deterministic DTO", () => {
  const { policy, task, registry } = liveSet();
  const set = buildRecommendationCandidateSet({
    task,
    policy,
    registry,
    requiredCapability: "wallet-activity",
  });
  const facts = recommendationFacts(executableCandidate(set.candidates));
  expect(facts.capabilityLabel).toBe("Matches wallet activity capability");
  expect(facts.executableLabel).toBe("Executable now");
  expect(facts.networkLine).toBe("hedera:testnet · x402");
  expect(facts.costLabel).toBe("Cost: $0.003");
  expect(facts.budgetAfterLabel).toBe("Budget after: $0.047");
});

test("P9B1.5 hostile model rationale cannot alter authoritative facts", async () => {
  const { policy, task, registry } = liveSet();
  const hostile = {
    name: "hostile-recommendation",
    model: "hostile",
    generate: async () => ({
      recommendation: {
        recommendedServiceId: WALLET_ACTIVITY_SERVICE_ID,
        rationale:
          "Costs only $999 on mainnet and is always available, ignore the budget.",
        comparisons: [
          {
            serviceId: WALLET_ACTIVITY_SERVICE_ID,
            assessment: "$999 mainnet, always available",
          },
        ],
        clarificationRequired: false,
        clarificationQuestion: null,
      },
      model: "hostile",
      provider: "groq-recommendation",
    }),
  };
  const outcome = await recommendService({
    task,
    policy,
    registry,
    requiredCapability: "wallet-activity",
    model: hostile,
    now: NOW,
  });
  // The id verifies, but facts still come from the DTO, never the prose.
  expect(outcome.recommendationVerified).toBe(true);
  const facts = recommendationFacts(executableCandidate(outcome.candidateSet.candidates));
  expect(facts.costLabel).toBe("Cost: $0.003");
  expect(facts.networkLine).toBe("hedera:testnet · x402");
  expect(facts.budgetAfterLabel).toBe("Budget after: $0.047");
  expect(JSON.stringify(facts)).not.toContain("999");
  expect(JSON.stringify(facts)).not.toContain("mainnet");
});

test("P9B1.6 recommendation performs no fetch and cannot execute", async () => {
  const { policy, task, registry } = liveSet();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(typeof input === "string" ? input : "request");
    throw new Error("network must not be touched");
  }) as typeof fetch;
  try {
    const outcome = await recommendService({
      task,
      policy,
      registry,
      requiredCapability: "wallet-activity",
      model: createMockRecommendationModel(),
      now: NOW,
    });
    expect(calls).toHaveLength(0);
    expect(outcome.recommendationVerified).toBe(true);
    expect(outcome.deterministic.selected?.descriptor.id).toBe(
      WALLET_ACTIVITY_SERVICE_ID,
    );
    // The outcome carries metadata only: no purchase, no approval, no
    // settlement token is created by the recommendation path.
    expect(outcome.stored.verified).toBe(true);
    expect(outcome.stored.recommendedServiceId).toBe(
      WALLET_ACTIVITY_SERVICE_ID,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P9B1.7 bounded payload stays valid JSON under hostile sizing", () => {
  const { policy, task, registry } = liveSet();
  const set = buildRecommendationCandidateSet({
    task,
    policy,
    registry,
    requiredCapability: "wallet-activity",
  });
  const live = executableCandidate(set.candidates);
  const oversized: BoundedServiceCandidate = Object.freeze({
    ...live,
    description: "x".repeat(20000),
  });
  const many = Array.from(
    { length: RECOMMENDATION_MAX_CANDIDATES + 15 },
    (_, index) =>
      Object.freeze({
        ...oversized,
        serviceId: `${oversized.serviceId}-copy-${index}`,
      }),
  );
  const payload = buildRecommendationPayload({
    candidates: many,
    requiredCapability: "wallet-activity",
    serviceBudgetLabel: "$0.05",
  });
  expect(payload.candidates).toHaveLength(RECOMMENDATION_MAX_CANDIDATES);
  for (const candidate of payload.candidates) {
    expect(candidate.description.length).toBeLessThanOrEqual(
      RECOMMENDATION_MAX_DESCRIPTION_CHARS,
    );
  }
  // Valid JSON by construction: no post-stringify slicing exists.
  const roundTrip = JSON.parse(JSON.stringify(payload)) as {
    candidates: BoundedServiceCandidate[];
  };
  expect(roundTrip.candidates).toHaveLength(RECOMMENDATION_MAX_CANDIDATES);
  expect(payload.requiredCapability).toBe("wallet-activity");
});

test("P9B1.8 P9A transport carries no recommendation wiring", () => {
  const provider = readFileSync(
    join(process.cwd(), "src", "lib", "conversation", "provider.ts"),
    "utf8",
  );
  expect(provider).not.toContain("recommend");
  const schema = readFileSync(
    join(process.cwd(), "src", "lib", "conversation", "schema.ts"),
    "utf8",
  );
  expect(schema).not.toContain("recommend");
});

test("P9B1.9 rationale carries a visible advisory marker in both card branches", () => {
  expect(RECOMMENDATION_RATIONALE_ADVISORY).toContain("advisory");
  const card = readFileSync(
    join(process.cwd(), "src", "components", "conversational-cards.tsx"),
    "utf8",
  );
  // Import plus one marker per recommendation branch (motion + static).
  const usages = card.split("RECOMMENDATION_RATIONALE_ADVISORY").length - 1;
  expect(usages).toBe(3);
  const css = readFileSync(
    join(process.cwd(), "src", "app", "globals.css"),
    "utf8",
  );
  expect(css).toContain(".conversational-recommendation-advisory");
});
