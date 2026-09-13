import { expect, test } from "@playwright/test";
import {
  createFinancialTask,
  createServiceDescriptor,
  createServicePurchase,
  formatMoney,
  money,
  type FinancialTask,
  type ServicePurchase,
  type TaskPolicy,
} from "../src/lib/domain";
import { selectServiceCandidate } from "../src/lib/services/selection";
import {
  createLiveServiceRegistry,
  createServiceRegistry,
  serializeServiceRegistry,
  serviceRegistry,
} from "../src/lib/services/registry";
import {
  createWalletActivityServiceDescriptor,
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  BUDGET_NOTE_CATALOG_ONLY,
  BUDGET_NOTE_PRE_PURCHASE,
  buildPlanConfirmation,
  hasExecutableServiceCandidate,
  modelCopyCarriesPlanFacts,
  resolveBudgetPrePurchaseNote,
  selectPlanConfirmation,
} from "../src/lib/tasks/presentation";
import { getTaskBudgetState } from "../src/lib/tasks/runtime";
import { orchestrateFinancialIntent } from "../src/lib/tasks/orchestrator";
import { parseFinancialIntent } from "../src/lib/intent";
const NOW = "2026-09-13T12:00:00.000Z";
const SMOKE_RECIPIENT = "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7";
const SMOKE_INITIAL =
  "Before you pay Alex 0.10 USDC, make sure this wallet has actually been used. " +
  "You can spend up to five cents checking it, but ask me before you send anything. " +
  "His wallet is " +
  SMOKE_RECIPIENT +
  ".";

function flagshipPlan(): { task: FinancialTask; policy: TaskPolicy } {
  const parsed = parseFinancialIntent(SMOKE_INITIAL);
  expect(parsed.status).toBe("ready");
  const orchestrated = orchestrateFinancialIntent(parsed, { now: NOW });
  expect(orchestrated.kind).toBe("planned");
  if (orchestrated.kind !== "planned") throw new Error("expected a planned task");
  return { task: orchestrated.task, policy: orchestrated.policy };
}

test("executable service with zero purchases never shows catalog-only copy", () => {
  const { task, policy } = flagshipPlan();
  const live = createLiveServiceRegistry("available");
  expect(
    hasExecutableServiceCandidate({ task, policy, registry: live, existingPurchases: [] }),
  ).toBe(true);
  expect(resolveBudgetPrePurchaseNote(true)).toBe(BUDGET_NOTE_PRE_PURCHASE);
  expect(resolveBudgetPrePurchaseNote(true)).not.toContain("Catalog-only");
  expect(resolveBudgetPrePurchaseNote(undefined)).toBe(BUDGET_NOTE_PRE_PURCHASE);
});

test("truly catalog-only discovery keeps catalog wording", () => {
  const { task, policy } = flagshipPlan();
  expect(
    hasExecutableServiceCandidate({
      task,
      policy,
      registry: serviceRegistry,
      existingPurchases: [],
    }),
  ).toBe(false);
  expect(
    hasExecutableServiceCandidate({
      task,
      policy,
      registry: createLiveServiceRegistry("unavailable"),
      existingPurchases: [],
    }),
  ).toBe(false);
  expect(resolveBudgetPrePurchaseNote(false)).toBe(BUDGET_NOTE_CATALOG_ONLY);
});
test("mixed registry with a cheaper catalog pick still reports executable", () => {
  const { task, policy } = flagshipPlan();
  const cheapCatalog = createServiceDescriptor({
    id: "catalog-cheap-wallet-activity",
    name: "Cheap catalog wallet activity",
    capability: "wallet-activity",
    category: "wallet-risk",
    description: "Cheaper catalog entry used to test the executable probe.",
    endpoint: "catalog://cheap-wallet-activity",
    price: money("0.001", "USD"),
    network: "local-preview",
    paymentProtocol: "x402",
    inputSchema: { wallet: { type: "string" } },
    outputSchema: { activity: { type: "array" } },
    status: "available",
    environment: "development",
    catalogOnly: true,
  });
  const mixed = createServiceRegistry(
    [cheapCatalog, createWalletActivityServiceDescriptor("available")],
    "copy-integrity-mixed-v1",
  );
  const selection = selectServiceCandidate({
    task,
    policy,
    requiredCapability: "wallet-activity",
    registry: mixed,
    existingPurchases: [],
  });
  expect(selection.selected?.descriptor.id).toBe("catalog-cheap-wallet-activity");
  expect(
    hasExecutableServiceCandidate({ task, policy, registry: mixed, existingPurchases: [] }),
  ).toBe(true);
  expect(resolveBudgetPrePurchaseNote(true)).toBe(BUDGET_NOTE_PRE_PURCHASE);
});
test("spent and remaining values after purchase are unchanged", () => {
  const { task, policy } = flagshipPlan();
  const purchase = createServicePurchase(
    {
      id: "purchase-copy-integrity",
      taskId: task.id,
      serviceId: WALLET_ACTIVITY_SERVICE_ID,
      quotedAmount: money("0.003", "USD"),
      paymentAmount: money("0.003", "USDC"),
      paidAmount: money("0.003", "USD"),
      policySnapshot: policy,
      status: "paid",
      requestId: "req-copy-integrity",
      paymentIdentifier: "0.0.7162784@1788908433.043020353",
      settlementNetwork: HEDERA_TESTNET_NETWORK,
    },
    NOW,
  );
  const state = getTaskBudgetState(task, policy, [purchase]);
  expect(formatMoney(state.confirmedSpend)).toBe("0.003");
  expect(formatMoney(state.remainingAvailable)).toBe("0.047");
  expect(formatMoney(state.configuredServiceBudget!)).toBe("0.05");
});

test("validated flagship task produces a specific confirmation", () => {
  const { task, policy } = flagshipPlan();
  const copy = buildPlanConfirmation(task, policy);
  expect(copy).toBeDefined();
  const text = copy!;
  expect(text).toMatch(/check .* wallet first/i);
  expect(text).toContain("$0.05");
  expect(text).toContain("0.1 USDC");
  expect(text).toMatch(/approval/i);
  expect(text).toContain("the recipient");
  expect(text).not.toMatch(/catalog-only/i);
});

test("confirmation never claims the check or payment already executed", () => {
  const { task, policy } = flagshipPlan();
  const text = buildPlanConfirmation(task, policy)!;
  expect(text).not.toMatch(/already checked|has been checked|was checked/i);
  expect(text).not.toMatch(/payment was sent|payment sent|settled|paid out|successfully paid/i);
  expect(text).not.toMatch(/recommend|purchased|running the check now|checking wallet\.\.\./i);
  expect(text).toMatch(/will check|will still require/i);
});

test("recipient name is used only when task metadata holds a real label", () => {
  const { policy } = flagshipPlan();
  const named = createFinancialTask(
    {
      id: "task-named-copy",
      ownerId: "owner-copy",
      type: "pay_with_check",
      recipient: "Alex",
      paymentAmount: money("0.10", "USDC"),
      serviceBudget: money("0.05", "USD"),
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  expect(buildPlanConfirmation(named, policy)).toContain("Alex's wallet");
  const addressOnly = createFinancialTask(
    {
      id: "task-address-copy",
      ownerId: "owner-copy",
      type: "pay_with_check",
      recipient: SMOKE_RECIPIENT,
      paymentAmount: money("0.10", "USDC"),
      serviceBudget: money("0.05", "USD"),
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  const neutral = buildPlanConfirmation(addressOnly, policy)!;
  expect(neutral).toContain("the recipient");
  expect(neutral).not.toContain(SMOKE_RECIPIENT);
});

test("generic model copy yields to the deterministic confirmation", () => {
  const { task, policy } = flagshipPlan();
  expect(modelCopyCarriesPlanFacts("i can help you plan that", task, policy)).toBe(false);
  expect(
    modelCopyCarriesPlanFacts(
      "I can do that. I will check the wallet before preparing the payment.",
      task,
      policy,
    ),
  ).toBe(false);
  const selected = selectPlanConfirmation({
    modelCopy: "i can help you plan that",
    task,
    policy,
    genericCopy: "I can do that.",
  });
  expect(selected).toBe(buildPlanConfirmation(task, policy));
  expect(selected).toContain("$0.05");
});

test("strong fact-bearing model copy is preserved", () => {
  const { task, policy } = flagshipPlan();
  const strong =
    "Got it. I will check the wallet first, using up to $0.05 for the check. " +
    "The 0.1 USDC payment will still require your approval.";
  expect(modelCopyCarriesPlanFacts(strong, task, policy)).toBe(true);
  expect(
    selectPlanConfirmation({ modelCopy: strong, task, policy, genericCopy: "I can do that." }),
  ).toBe(strong);
  const trailingZero =
    "Got it. I will check the wallet first, using up to $0.05 for the check. " +
    "The 0.10 USDC payment will still require your approval.";
  expect(modelCopyCarriesPlanFacts(trailingZero, task, policy)).toBe(true);
});

test("wrong asset or missing approval fails the fact gate", () => {
  const { task, policy } = flagshipPlan();
  expect(
    modelCopyCarriesPlanFacts(
      "Got it. I will check the wallet first, using up to $0.05 for the check. " +
        "The 0.1 HBAR payment will still require your approval.",
      task,
      policy,
    ),
  ).toBe(false);
  expect(
    modelCopyCarriesPlanFacts(
      "Got it. I will check the wallet first, using up to $0.05 for the check. " +
        "The 0.1 USDC payment is ready.",
      task,
      policy,
    ),
  ).toBe(false);
  expect(
    modelCopyCarriesPlanFacts(
      "The 0.1 USDC payment will still require your approval.",
      task,
      policy,
    ),
  ).toBe(false);
  const wrongAssetSelected = selectPlanConfirmation({
    modelCopy: "The 0.1 HBAR payment will still require your approval. Using up to $0.05.",
    task,
    policy,
    genericCopy: "I can do that.",
  });
  expect(wrongAssetSelected).toBe(buildPlanConfirmation(task, policy));
});

test("superstring amounts and negated approval fail the fact gate", () => {
  const { task, policy } = flagshipPlan();
  expect(
    modelCopyCarriesPlanFacts(
      "Got it. I will check the wallet first, using up to $0.05 for the check. " +
        "The 10.1 USDC payment will still require your approval.",
      task,
      policy,
    ),
  ).toBe(false);
  expect(
    modelCopyCarriesPlanFacts(
      "Got it. I will check the wallet first, using up to $10.05 for the check. " +
        "The 0.1 USDC payment will still require your approval.",
      task,
      policy,
    ),
  ).toBe(false);
  expect(
    modelCopyCarriesPlanFacts(
      "Got it. I will check the wallet first, using up to $0.05 for the check. " +
        "The 0.1 USDC payment is ready; approval is not required.",
      task,
      policy,
    ),
  ).toBe(false);
  expect(
    modelCopyCarriesPlanFacts(
      "The 0.1 USDC payment was disapproved, but I used $0.05 for the check.",
      task,
      policy,
    ),
  ).toBe(false);
});
test("copy helpers do not mutate inputs and write no purchases", () => {
  const { task, policy } = flagshipPlan();
  const snapshot = (value: unknown): string =>
    JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === "bigint" ? nested.toString() : (nested as Record<string, unknown>),
    );
  const before = snapshot({ task, policy });
  const frozenLedger = Object.freeze([]) as readonly ServicePurchase[];
  resolveBudgetPrePurchaseNote(true);
  hasExecutableServiceCandidate({
    task,
    policy,
    registry: createLiveServiceRegistry("available"),
    existingPurchases: frozenLedger,
  });
  buildPlanConfirmation(task, policy);
  selectPlanConfirmation({ task, policy, genericCopy: "generic" });
  expect(snapshot({ task, policy })).toBe(before);
  expect(frozenLedger).toHaveLength(0);
});

test("browser: live service shows truthful pre-purchase budget copy", async ({ page }) => {
  const liveRegistry = createLiveServiceRegistry("available");
  await page.route("**/api/services", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(serializeServiceRegistry(liveRegistry)),
    });
  });
  await page.goto("/app");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const input = page.getByRole("textbox", { name: "Your financial task" });
  await input.fill(
    "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
  );
  await page.getByRole("button", { name: "Submit task" }).click();
  await input.fill("0x1234567890abcdef");
  await page.getByRole("button", { name: "Submit task" }).click();

  const budgetCard = page.locator(".bounded-budget-card");
  await expect(budgetCard).toBeVisible({ timeout: 15000 });
  await expect(budgetCard.getByText(BUDGET_NOTE_PRE_PURCHASE, { exact: true })).toBeVisible();
  await expect(budgetCard.getByText(BUDGET_NOTE_CATALOG_ONLY, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Catalog-only. No service was purchased.", { exact: true }),
  ).toHaveCount(0);
});

test("browser: catalog-only registry keeps catalog wording", async ({ page }) => {
  await page.route("**/api/services", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(serializeServiceRegistry(serviceRegistry)),
    });
  });
  await page.goto("/app");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const input = page.getByRole("textbox", { name: "Your financial task" });
  await input.fill(
    "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
  );
  await page.getByRole("button", { name: "Submit task" }).click();
  await input.fill("0x1234567890abcdef");
  await page.getByRole("button", { name: "Submit task" }).click();

  const budgetCard = page.locator(".bounded-budget-card");
  await expect(budgetCard).toBeVisible({ timeout: 15000 });
  await expect(budgetCard.getByText(BUDGET_NOTE_CATALOG_ONLY, { exact: true })).toBeVisible();
});
