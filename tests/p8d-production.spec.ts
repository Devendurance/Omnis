import { expect, test } from "@playwright/test";
import {
  createFinancialTask,
  createTaskPolicy,
  money,
  transitionTask,
} from "../src/lib/domain";
import {
  assertWalletActivityEndpoint,
  inspectP4AEnvironment,
  readPublicOrigin,
  resolveWalletActivityEndpoint,
} from "../src/lib/services/hedera-x402/config";
import {
  checkAndRecordDemoPurchase,
  isDemoSubjectAllowlisted,
  isP4ADemoGateOpen,
  resetDemoCountersForTests,
  resolveP4ALiveServiceStatus,
} from "../src/lib/services/server/demo-guard";
import { createLiveServiceRegistry } from "../src/lib/services/registry";
import {
  resolveRequiredCapability,
  selectServiceCandidate,
} from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
  WALLET_ACTIVITY_QUOTE,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  authorizeServicePurchase,
  executeServicePurchase,
} from "../src/lib/tasks/service-execution";

// Production P8D flagship regression: the exact contractor prompt from the
// live observation must resolve to the executable Hedera wallet-activity
// service when the production demo is properly configured, and must fall
// back to non-executable catalog entries otherwise. No test here performs a
// live request or a real payment.

const NOW = "2026-09-11T12:00:00.000Z";
const CONTRACTOR_WALLET = "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7";
const JUDGE_DID = "did:privy:production-judge";
const STRANGER_DID = "did:privy:production-stranger";
const PAYER_ACCOUNT = "0.0.5678";
const SERVICE_ACCOUNT = "0.0.1234";
const ECDSA_PRIVATE_KEY = `0x${"11".repeat(32)}`;
const PUBLIC_ORIGIN = "https://useomnis.vercel.app";

function productionEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    OMNIS_DEMO_PURCHASES_ENABLED: "true",
    OMNIS_DEMO_ACCESS_MODE: "allowlist",
    OMNIS_DEMO_ALLOWLIST: JUDGE_DID,
    OMNIS_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    HEDERA_TESTNET_PAYER_ACCOUNT_ID: PAYER_ACCOUNT,
    HEDERA_TESTNET_PAYER_PRIVATE_KEY: ECDSA_PRIVATE_KEY,
    HEDERA_X402_SERVICE_ACCOUNT_ID: SERVICE_ACCOUNT,
    BLOCKY402_TESTNET_URL: "https://api.testnet.blocky402.com",
    ...extra,
  };
}

function makeTaskAndPolicy(taskId: string, serviceBudget = "0.05") {
  const policy = createTaskPolicy({
    taskId,
    maxServiceSpend: money(serviceBudget, "USD"),
    maxPerService: money(serviceBudget, "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: ["local-preview", HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
  });
  const task = transitionTask(
    createFinancialTask(
      {
        id: taskId,
        ownerId: JUDGE_DID,
        ownerSubject: JUDGE_DID,
        type: "pay_with_check",
        originalIntent: `Pay this contractor ${CONTRACTOR_WALLET} 0.10 USDC, but check the wallet first. Spend no more than $0.05 checking.`,
        recipient: CONTRACTOR_WALLET,
        paymentAmount: money("0.10", "USDC"),
        purpose: "contractor payment",
        serviceBudget: policy.maxServiceSpend,
        perServiceCap: policy.maxPerService,
        finalPaymentApprovalRequired: true,
      },
      NOW,
    ),
    "planned",
    { now: NOW },
  );
  return { task, policy };
}

function canStartFor(descriptor: {
  id: string;
  status: string;
  catalogOnly: boolean;
}): boolean {
  return (
    descriptor.id === WALLET_ACTIVITY_SERVICE_ID &&
    descriptor.status === "available" &&
    !descriptor.catalogOnly
  );
}

test.beforeEach(() => {
  resetDemoCountersForTests();
});

test.describe("P8D production flagship service discovery", () => {
  test("properly configured production resolves the live $0.003 Hedera service", () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("live requests are not allowed in this test");
    }) as typeof fetch;
    try {
      const env = productionEnv();
      const inspection = inspectP4AEnvironment(env);
      expect(inspection.configured).toBe(true);
      const registry = createLiveServiceRegistry(
        resolveP4ALiveServiceStatus(env, inspection.configured),
      );
      const live = registry.getService(WALLET_ACTIVITY_SERVICE_ID);
      expect(live?.status).toBe("available");
      expect(live?.catalogOnly).toBe(false);
      expect(live?.environment).toBe("testnet");
      expect(live?.network).toBe("hedera:testnet");
      expect(live?.paymentProtocol).toBe("x402");
      expect(live?.price.units).toBe(WALLET_ACTIVITY_QUOTE.units);
      expect(live?.price.asset).toBe("USD");
      expect(live?.paymentAmount?.units).toBe(BigInt(3000));
      expect(live?.paymentAmount?.asset).toBe("USDC");
      expect(canStartFor(live!)).toBe(true);

      const { task, policy } = makeTaskAndPolicy("task-p8d-prod-live");
      expect(resolveRequiredCapability(task)).toBe("wallet-activity");
      const selection = selectServiceCandidate({
        task,
        policy,
        existingPurchases: [],
        registry,
        requiredCapability: "wallet-activity",
      });
      expect(selection.selected?.descriptor.id).toBe(
        WALLET_ACTIVITY_SERVICE_ID,
      );
      expect(selection.selected?.descriptor.network).toBe("hedera:testnet");
      expect(selection.selected?.descriptor.paymentProtocol).toBe("x402");
      expect(selection.selected?.price.units).toBe(BigInt(3000));
      expect(selection.selected?.capabilityMatch).toBe("required");

      const endpoint = resolveWalletActivityEndpoint(
        `${PUBLIC_ORIGIN}/app`,
        env,
      );
      expect(endpoint).toBe(`${PUBLIC_ORIGIN}/api/services/wallet-activity`);
      expect(assertWalletActivityEndpoint(endpoint, env).origin).toBe(
        PUBLIC_ORIGIN,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("production without the demo flag reproduces the catalog-only observation", () => {
    const env = productionEnv({ OMNIS_DEMO_PURCHASES_ENABLED: "false" });
    const inspection = inspectP4AEnvironment(env);
    expect(inspection.configured).toBe(true);
    const status = resolveP4ALiveServiceStatus(env, inspection.configured);
    expect(status).toBe("unavailable");
    const registry = createLiveServiceRegistry(status);

    const { task, policy } = makeTaskAndPolicy("task-p8d-prod-catalog");
    const selection = selectServiceCandidate({
      task,
      policy,
      existingPurchases: [],
      registry,
      requiredCapability: "wallet-activity",
    });
    expect(selection.selected?.descriptor.id).toBe("catalog-wallet-activity");
    expect(selection.selected?.descriptor.network).toBe("local-preview");
    expect(selection.selected?.price.units).toBe(BigInt(4000));
    expect(selection.selected?.descriptor.catalogOnly).toBe(true);
    expect(canStartFor(selection.selected!.descriptor)).toBe(false);
    expect(
      selection.discovery.selectableCandidates.map(
        (entry) => entry.descriptor.id,
      ),
    ).toEqual(["catalog-wallet-activity", "catalog-wallet-risk"]);
  });

  test("production with demo gate open but Hedera misconfigured stays unavailable", () => {
    const env = productionEnv({
      HEDERA_TESTNET_PAYER_PRIVATE_KEY: undefined,
    });
    const inspection = inspectP4AEnvironment(env);
    expect(inspection.configured).toBe(false);
    expect(resolveP4ALiveServiceStatus(env, inspection.configured)).toBe(
      "unavailable",
    );
  });

  test("P2 authorization runs before payment and catalog stays non-executable", async () => {
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("live requests are not allowed in this test");
    }) as typeof fetch;
    try {
      const env = productionEnv();
      const inspection = inspectP4AEnvironment(env);
      const registry = createLiveServiceRegistry(
        resolveP4ALiveServiceStatus(env, inspection.configured),
      );
      const { task, policy } = makeTaskAndPolicy("task-p8d-prod-p2");
      const selection = selectServiceCandidate({
        task,
        policy,
        existingPurchases: [],
        registry,
        requiredCapability: "wallet-activity",
      });
      const outcome = await authorizeServicePurchase({
        task,
        policy,
        servicePurchases: [],
        registry,
        discovery: {
          requiredCapability: "wallet-activity",
          selectedServiceId: selection.selected!.descriptor.id,
          discoveredAt: NOW,
          registryVersion: registry.version,
        },
        wallet: CONTRACTOR_WALLET,
      });
      expect(outcome.kind).toBe("approved");

      const catalogRegistry = createLiveServiceRegistry("unavailable");
      const catalogSelection = selectServiceCandidate({
        task,
        policy,
        existingPurchases: [],
        registry: catalogRegistry,
        requiredCapability: "wallet-activity",
      });
      await expect(
        authorizeServicePurchase({
          task,
          policy,
          servicePurchases: [],
          registry: catalogRegistry,
          discovery: {
            requiredCapability: "wallet-activity",
            selectedServiceId: catalogSelection.selected!.descriptor.id,
            discoveredAt: NOW,
            registryVersion: catalogRegistry.version,
          },
          wallet: CONTRACTOR_WALLET,
        }),
      ).rejects.toThrow(/not the executable/);

      const tight = makeTaskAndPolicy("task-p8d-prod-p2-deny", "0.001");
      let paymentCalls = 0;
      await expect(
        executeServicePurchase({
          task: tight.task,
          policy: tight.policy,
          servicePurchases: [],
          registry,
          discovery: {
            requiredCapability: "wallet-activity",
            selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
            discoveredAt: NOW,
            registryVersion: registry.version,
          },
          wallet: CONTRACTOR_WALLET,
          executePayment: async () => {
            paymentCalls += 1;
            throw new Error("payment must not run after a P2 denial");
          },
        }),
      ).rejects.toThrow();
      expect(paymentCalls).toBe(0);

      expect(WALLET_ACTIVITY_PRICE.units).toBe(BigInt(3000));
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(fetchCalls).toBe(0);
  });

  test("non-allowlisted subjects remain unable to spend", () => {
    const env = productionEnv();
    expect(isDemoSubjectAllowlisted(JUDGE_DID, env)).toBe(true);
    expect(isDemoSubjectAllowlisted(STRANGER_DID, env)).toBe(false);
    expect(checkAndRecordDemoPurchase(JUDGE_DID, env)).toEqual({ ok: true });
    expect(checkAndRecordDemoPurchase(STRANGER_DID, env)).toEqual({
      ok: false,
      error: "demo purchases are restricted to allowlisted judges",
      status: 403,
    });
  });

  test("unavailable cause is exact and name-only, values stay secret", () => {
    const gateClosed = productionEnv({ OMNIS_DEMO_PURCHASES_ENABLED: "false" });
    const gateInspection = inspectP4AEnvironment(gateClosed);
    expect(gateInspection.configured).toBe(true);
    expect(gateInspection.missing).toEqual([]);
    expect(isP4ADemoGateOpen(gateClosed)).toBe(false);
    expect(
      resolveP4ALiveServiceStatus(gateClosed, gateInspection.configured),
    ).toBe("unavailable");

    const malformed = productionEnv({ OMNIS_DEMO_ALLOWLIST: " , " });
    expect(isP4ADemoGateOpen(malformed)).toBe(false);
    expect(resolveP4ALiveServiceStatus(malformed, true)).toBe("unavailable");

    const hederaBroken = productionEnv({
      HEDERA_TESTNET_PAYER_PRIVATE_KEY: undefined,
    });
    const hederaInspection = inspectP4AEnvironment(hederaBroken);
    expect(hederaInspection.configured).toBe(false);
    expect(hederaInspection.missing).toEqual([
      "HEDERA_TESTNET_PAYER_PRIVATE_KEY",
    ]);
    expect(JSON.stringify(hederaInspection)).not.toContain("1111");
    expect(
      resolveP4ALiveServiceStatus(hederaBroken, hederaInspection.configured),
    ).toBe("unavailable");

    const badOrigin = productionEnv({
      OMNIS_PUBLIC_ORIGIN: "https://useomnis.vercel.app/app",
    });
    expect(isP4ADemoGateOpen(badOrigin)).toBe(true);
    expect(inspectP4AEnvironment(badOrigin).configured).toBe(true);
    expect(
      resolveP4ALiveServiceStatus(badOrigin, true),
    ).toBe("unavailable");
    expect(() => readPublicOrigin(badOrigin)).toThrow(/OMNIS_PUBLIC_ORIGIN/);
    expect(() =>
      resolveWalletActivityEndpoint(`${PUBLIC_ORIGIN}/app`, badOrigin),
    ).toThrow(/OMNIS_PUBLIC_ORIGIN/);

    const missingOrigin = productionEnv({ OMNIS_PUBLIC_ORIGIN: undefined });
    expect(
      resolveP4ALiveServiceStatus(missingOrigin, true),
    ).toBe("unavailable");
  });

  test("stale catalog discovery stays fail-closed after the gate opens", async () => {
    const env = productionEnv();
    const inspection = inspectP4AEnvironment(env);
    const registry = createLiveServiceRegistry(
      resolveP4ALiveServiceStatus(env, inspection.configured),
    );
    const { task, policy } = makeTaskAndPolicy("task-p8d-prod-stale");
    const staleDiscovery = {
      requiredCapability: "wallet-activity",
      selectedServiceId: "catalog-wallet-activity",
      discoveredAt: NOW,
      registryVersion: registry.version,
    } as const;
    await expect(
      authorizeServicePurchase({
        task,
        policy,
        servicePurchases: [],
        registry,
        discovery: staleDiscovery,
        wallet: CONTRACTOR_WALLET,
      }),
    ).rejects.toThrow(/not the executable/);
    const fresh = selectServiceCandidate({
      task,
      policy,
      existingPurchases: [],
      registry,
      requiredCapability: "wallet-activity",
    });
    expect(fresh.selected?.descriptor.id).toBe(WALLET_ACTIVITY_SERVICE_ID);
    expect(canStartFor(fresh.selected!.descriptor)).toBe(true);
  });
});
