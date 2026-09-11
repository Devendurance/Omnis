import { expect, test } from "@playwright/test";
import {
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  money,
  transitionTask,
} from "../src/lib/domain";
import {
  createLiveServiceRegistry,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
} from "../src/lib/services/wallet-activity-descriptor";
import { DRAFT_SESSION_STORAGE_KEY, serializeDraftSession } from "../src/lib/tasks/persistence";
import {
  beginTaskExecution,
  moveTaskToAwaitingApproval,
} from "../src/lib/tasks/runtime";

const NOW = "2026-09-07T12:00:00.000Z";
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

test("reloaded paid task keeps service proof visible without retrying", async ({ page }) => {
  const policy = createTaskPolicy({
    taskId: "p4b-browser-reload",
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
  });
  const draft = createFinancialTask(
    {
      id: policy.taskId,
      ownerId: "p4b-browser-owner",
      type: "pay_with_check",
      originalIntent:
        "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
      recipient: WALLET,
      paymentAmount: money("50", "USDC"),
      purpose: "contractor payment",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  const planned = transitionTask(draft, "planned", { now: NOW });
  const running = beginTaskExecution(planned, policy, NOW);
  const registry = createLiveServiceRegistry("available");
  const service = registry.getService(WALLET_ACTIVITY_SERVICE_ID);
  if (!service?.paymentAmount) throw new Error("live service fixture is incomplete");
  const purchase = createServicePurchase(
    {
      id: "purchase-p4b-browser-reload",
      taskId: policy.taskId,
      serviceId: service.id,
      quotedAmount: service.price,
      paymentAmount: service.paymentAmount,
      paidAmount: service.price,
      requestId: "p4b-browser-reload-request",
      paymentIdentifier: "0.0.123@1700000000.000000000",
      settlementNetwork: HEDERA_TESTNET_NETWORK,
      serviceResult: {
        observations: { wallet: WALLET, transactionCount: "3" },
        heuristicFlags: [],
        disclaimer: "Read-only fixture result.",
        requestId: "p4b-browser-reload-request",
      },
      policySnapshot: policy,
      status: "paid",
      createdAt: NOW,
      updatedAt: NOW,
    },
    NOW,
  );
  const task = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);
  const rawSession = serializeDraftSession(
    {
      version: 4,
      messages: [],
      task,
      policy,
      servicePurchases: [purchase],
      discovery: {
        requiredCapability: "wallet-activity",
        selectedServiceId: service.id,
        discoveredAt: NOW,
        registryVersion: registry.version,
      },
    },
    registry,
  );

  await page.route("**/api/services", (route) => route.abort());
  await page.goto("/app");
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [DRAFT_SESSION_STORAGE_KEY, rawSession],
  );
  await page.reload();

  await expect(
    page.getByText("Wallet activity purchase is persisted for this task.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("paid, read-only activity confirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("payment identifier", { exact: true })).toBeVisible();
  await expect(
    page.getByText("0.0.123@1700000000.000000000", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$0.047", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText(/50 USDC payment was not sent\./, { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "start wallet check", exact: true }),
  ).toHaveCount(0);
});
