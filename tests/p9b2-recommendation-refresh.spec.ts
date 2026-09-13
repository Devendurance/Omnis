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
  createMockRecommendationModel,
  decideRecommendationRefresh,
  fingerprintRecommendationContext,
  isRecommendationStale,
  isStoredRecommendationCurrent,
  liveRecommendationContext,
  recommendService,
  storedRecommendationContext,
  type StoredServiceRecommendation,
} from "../src/lib/recommendation";
import { createLiveServiceRegistry } from "../src/lib/services/registry";
import { WALLET_ACTIVITY_SERVICE_ID } from "../src/lib/services/wallet-activity-descriptor";
const NOW = "2026-09-13T12:00:00.000Z";
const RECIPIENT = "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7";
const CAPABILITY = "wallet-activity";

function makePolicy(overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return createTaskPolicy({
    taskId: "task-p9b2",
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
      ownerId: "owner-p9b2",
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

function contextOf(task: FinancialTask, policy: TaskPolicy, version: string) {
  return { task, policy, requiredCapability: CAPABILITY, registryVersion: version };
}

function isCurrent(
  stored: StoredServiceRecommendation,
  task: FinancialTask,
  policy: TaskPolicy,
  version: string,
) {
  return isStoredRecommendationCurrent(stored, task, policy, version, CAPABILITY);
}

function staleOf(
  stored: StoredServiceRecommendation,
  task: FinancialTask,
  policy: TaskPolicy,
  version: string,
  registryVersion = version,
) {
  const registry = createLiveServiceRegistry("available");
  const candidateSet = buildRecommendationCandidateSet({
    task,
    policy,
    registry,
    requiredCapability: CAPABILITY,
  });
  return isRecommendationStale({
    stored,
    task,
    policy,
    requiredCapability: CAPABILITY,
    registryVersion,
    candidateSet,
  });
}

// Coherent budget context: task boundaries must match the policy
// (assertTaskPolicyMatches), so a budget change always moves both sides
// together, exactly as task correction does in production.
function budgetedSet(spend: string, cap: string = spend) {
  const policy = makePolicy({
    maxServiceSpend: money(spend, "USD"),
    maxPerService: money(cap, "USD"),
  });
  const task = makeTask(policy);
  const registry = createLiveServiceRegistry("available");
  return { policy, task, registry };
}

async function recommend(task: FinancialTask, policy: TaskPolicy) {
  const registry = createLiveServiceRegistry("available");
  return recommendService({
    task,
    policy,
    registry,
    requiredCapability: CAPABILITY,
    model: createMockRecommendationModel(),
    now: NOW,
  });
}

test("P9B2.1 unchanged context does not refetch", async () => {
  const { policy, task, registry } = liveSet();
  const outcome = await recommend(task, policy);
  expect(outcome.recommendationVerified).toBe(true);
  const keyA = fingerprintRecommendationContext(
    contextOf(task, policy, registry.version),
  );
  const keyB = fingerprintRecommendationContext(
    contextOf(task, policy, registry.version),
  );
  expect(keyA).toBe(keyB);
  expect(isCurrent(outcome.stored, task, policy, registry.version)).toBe(true);
});

test("P9B2.2 service-budget change invalidates and refetches", async () => {
  const { policy, task, registry } = liveSet();
  const before = await recommend(task, policy);
  const keyBefore = fingerprintRecommendationContext(
    contextOf(task, policy, registry.version),
  );
  // Same version and task id; only the $0.05 -> $0.02 budget moves, on both
  // task and policy sides together as task correction does in production.
  const lean = budgetedSet("0.02");
  expect(isCurrent(before.stored, lean.task, lean.policy, registry.version)).toBe(
    false,
  );
  expect(staleOf(before.stored, lean.task, lean.policy, registry.version)).toBe(true);
  expect(
    fingerprintRecommendationContext(
      contextOf(lean.task, lean.policy, registry.version),
    ),
  ).not.toBe(keyBefore);
  const after = await recommend(lean.task, lean.policy);
  expect(isCurrent(after.stored, lean.task, lean.policy, registry.version)).toBe(
    true,
  );
  // Changing back restores the original identity exactly.
  expect(
    fingerprintRecommendationContext(contextOf(task, policy, registry.version)),
  ).toBe(keyBefore);
  expect(isCurrent(before.stored, task, policy, registry.version)).toBe(true);
});

test("P9B2.3 per-service cap change invalidates and refetches", async () => {
  const { policy, task, registry } = liveSet();
  const before = await recommend(task, policy);
  // Spend stays $0.05; only the per-service cap tightens to $0.02.
  const capped = budgetedSet("0.05", "0.02");
  expect(isCurrent(before.stored, capped.task, capped.policy, registry.version)).toBe(
    false,
  );
  expect(staleOf(before.stored, capped.task, capped.policy, registry.version)).toBe(
    true,
  );
  const after = await recommend(capped.task, capped.policy);
  expect(isCurrent(after.stored, capped.task, capped.policy, registry.version)).toBe(
    true,
  );
});

test("P9B2.4 service-network allowlist change invalidates and refetches", async () => {
  const { policy, task, registry } = liveSet();
  const before = await recommend(task, policy);
  const localOnly = makePolicy({ allowedServiceNetworks: ["local-preview"] });
  expect(isCurrent(before.stored, task, localOnly, registry.version)).toBe(false);
  expect(staleOf(before.stored, task, localOnly, registry.version)).toBe(true);
  const after = await recommend(task, localOnly);
  // The stored entry tracks the new context instead of the old one.
  expect(isCurrent(after.stored, task, localOnly, registry.version)).toBe(true);
  expect(isCurrent(before.stored, task, localOnly, registry.version)).toBe(false);
});

test("P9B2.5 category allowlist change invalidates and refetches", async () => {
  const { policy, task, registry } = liveSet();
  const before = await recommend(task, policy);
  const recategorized = makePolicy({ allowedServiceCategories: ["other"] });
  expect(isCurrent(before.stored, task, recategorized, registry.version)).toBe(
    false,
  );
  const after = await recommend(task, recategorized);
  expect(isCurrent(after.stored, task, recategorized, registry.version)).toBe(true);
});

test("P9B2.6 registry version change continues to invalidate", async () => {
  const { policy, task, registry } = liveSet();
  const before = await recommend(task, policy);
  expect(isCurrent(before.stored, task, policy, "p9b2-registry-v2")).toBe(false);
  expect(
    staleOf(before.stored, task, policy, registry.version, "p9b2-registry-v2"),
  ).toBe(true);
  expect(
    fingerprintRecommendationContext(contextOf(task, policy, "p9b2-registry-v2")),
  ).not.toBe(
    fingerprintRecommendationContext(contextOf(task, policy, registry.version)),
  );
});

test("P9B2.7 recipient and capability changes continue to invalidate", async () => {
  const { policy, task, registry } = liveSet();
  const before = await recommend(task, policy);
  const redirected = { ...task, recipient: "0x0000000000000000000000000000000000000001" };
  expect(isCurrent(before.stored, redirected, policy, registry.version)).toBe(false);
  expect(
    fingerprintRecommendationContext({
      task,
      policy,
      requiredCapability: "other-capability",
      registryVersion: registry.version,
    }),
  ).not.toBe(
    fingerprintRecommendationContext(contextOf(task, policy, registry.version)),
  );
});

test("P9B2.8 archived recommendation is historical-only, never current", async () => {
  const { policy, task, registry } = liveSet();
  const before = await recommend(task, policy);
  // A later task reuses nothing: the archived entry is foreign here.
  const nextPolicy = makePolicy({ taskId: "task-p9b2-next" });
  const nextTask = makeTask(nextPolicy);
  expect(isCurrent(before.stored, nextTask, nextPolicy, registry.version)).toBe(
    false,
  );
  expect(staleOf(before.stored, nextTask, nextPolicy, registry.version)).toBe(true);
  // Record views render the rationale as historical metadata only.
  expect(before.stored.verified).toBe(true);
  expect(before.stored.recommendedServiceId).toBe(WALLET_ACTIVITY_SERVICE_ID);
});

test("P9B2.9 successful new recommendation stops the request loop", async () => {
  const { policy, task, registry } = liveSet();
  const first = await recommend(task, policy);
  const key = fingerprintRecommendationContext(
    contextOf(task, policy, registry.version),
  );
  // Rerender with the stored entry: same key and current means suppress.
  expect(
    fingerprintRecommendationContext(contextOf(task, policy, registry.version)),
  ).toBe(key);
  expect(isCurrent(first.stored, task, policy, registry.version)).toBe(true);
  // After a budget change + refetch, the new entry is current for the new
  // context only: exactly one request per context, no loop either way.
  const lean = budgetedSet("0.02");
  const second = await recommend(lean.task, lean.policy);
  expect(isCurrent(second.stored, lean.task, lean.policy, registry.version)).toBe(
    true,
  );
  expect(isCurrent(second.stored, task, policy, registry.version)).toBe(false);
});
test("P9B2.10 invalidation refetch never executes or pays", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(typeof input === "string" ? input : "request");
    throw new Error("network must not be touched");
  }) as typeof fetch;
  try {
    const lean = budgetedSet("0.02");
    const outcome = await recommend(lean.task, lean.policy);
    expect(calls).toHaveLength(0);
    expect(outcome.recommendationVerified).toBe(true);
    expect(outcome.deterministic.selected?.descriptor.id).toBe(
      WALLET_ACTIVITY_SERVICE_ID,
    );
    // Metadata only: no purchase, approval, or settlement is produced.
    expect(outcome.stored.fallback).toBe(false);
    expect("servicePurchases" in outcome).toBe(false);
    expect("approval" in outcome).toBe(false);
    expect("settlement" in outcome).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P9B2.11 fetch decision matches the composer effect table", async () => {
  const { policy, task, registry } = liveSet();
  const base = {
    task,
    policy,
    requiredCapability: CAPABILITY,
    registryVersion: registry.version,
  };
  // No stored entry on first render: fetch.
  const first = decideRecommendationRefresh({
    ...base,
    stored: undefined,
    currentKey: null,
  });
  expect(first.fetch).toBe(true);
  const outcome = await recommend(task, policy);
  // Fresh mount with a current stored entry: suppress, adopt the key.
  const mounted = decideRecommendationRefresh({
    ...base,
    stored: outcome.stored,
    currentKey: null,
  });
  expect(mounted.fetch).toBe(false);
  expect(mounted.key).toBe(first.key);
  // Steady rerender with the same key: suppress.
  expect(
    decideRecommendationRefresh({ ...base, stored: outcome.stored, currentKey: first.key })
      .fetch,
  ).toBe(false);
  // Stale stored entry after a budget change: fetch under a new key.
  const lean = budgetedSet("0.02");
  const refetch = decideRecommendationRefresh({
    task: lean.task,
    policy: lean.policy,
    requiredCapability: CAPABILITY,
    registryVersion: registry.version,
    stored: outcome.stored,
    currentKey: first.key,
  });
  expect(refetch.fetch).toBe(true);
  expect(refetch.key).not.toBe(first.key);
});

test("P9B2.12 effect lifecycle issues exactly one request per context", async () => {
  const { policy, task, registry } = liveSet();
  const version = registry.version;
  // Mirror the composer effect: keyRef starts null, fetch decisions drive it.
  let keyRef: string | null = null;
  let fetches = 0;
  const render = (stored: StoredServiceRecommendation | undefined, t: FinancialTask, p: TaskPolicy) => {
    const decision = decideRecommendationRefresh({
      stored,
      task: t,
      policy: p,
      requiredCapability: CAPABILITY,
      registryVersion: version,
      currentKey: keyRef,
    });
    keyRef = decision.key;
    if (decision.fetch) fetches += 1;
    return decision;
  };
  expect(render(undefined, task, policy).fetch).toBe(true);
  const first = await recommend(task, policy);
  expect(render(first.stored, task, policy).fetch).toBe(false);
  expect(render(first.stored, task, policy).fetch).toBe(false);
  expect(fetches).toBe(1);
  const lean = budgetedSet("0.02");
  expect(render(first.stored, lean.task, lean.policy).fetch).toBe(true);
  const second = await recommend(lean.task, lean.policy);
  expect(render(second.stored, lean.task, lean.policy).fetch).toBe(false);
  expect(render(second.stored, lean.task, lean.policy).fetch).toBe(false);
  expect(fetches).toBe(2);
});

test("P9B2.13 stored and live contexts share one canonical record", async () => {
  const { policy, task, registry } = liveSet();
  const outcome = await recommend(task, policy);
  expect(storedRecommendationContext(outcome.stored)).toEqual(
    liveRecommendationContext(contextOf(task, policy, registry.version)),
  );
  const lean = budgetedSet("0.02");
  expect(storedRecommendationContext(outcome.stored)).not.toEqual(
    liveRecommendationContext(contextOf(lean.task, lean.policy, registry.version)),
  );
});

test("P9B2.14 composer has a single recommendation fetch gated by the predicate", () => {
  const composer = readFileSync(
    join(process.cwd(), "src", "components", "composer.tsx"),
    "utf8",
  );
  // Exactly one recommendation endpoint call site, inside the effect that
  // consults decideRecommendationRefresh.
  expect(composer.split("/api/services/recommendation").length - 1).toBe(1);
  expect(composer.split("decideRecommendationRefresh").length - 1).toBe(2);
});
