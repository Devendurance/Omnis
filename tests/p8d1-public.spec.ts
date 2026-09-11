import { expect, test } from "@playwright/test";
import {
  createFinancialTask,
  createServiceDescriptor,
  createTaskPolicy,
  money,
  transitionTask,
} from "../src/lib/domain";
import {
  inspectP4AEnvironment,
  resolveWalletActivityEndpoint,
} from "../src/lib/services/hedera-x402/config";
import {
  checkAndRecordDemoPurchase,
  isDemoSubjectAuthorized,
  isP4ADemoGateOpen,
  readDemoAccessMode,
  resetDemoCountersForTests,
  resolveP4ALiveServiceStatus,
} from "../src/lib/services/server/demo-guard";
import {
  createLiveServiceRegistry,
  createServiceRegistry,
} from "../src/lib/services/registry";
import {
  resolveRequiredCapability,
  selectServiceCandidate,
} from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  authorizeServicePurchase,
  executeServicePurchase,
} from "../src/lib/tasks/service-execution";

// P8D.1 public hackathon mode: an unknown authenticated judge can run the
// bounded wallet-activity check without an allowlist, while allowlist,
// disabled, and misconfigured states stay fail-closed. No test here performs
// a live request or a real payment.

const NOW = "2026-09-11T12:00:00.000Z";
const CONTRACTOR_WALLET = "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7";
const UNKNOWN_JUDGE = "did:privy:unknown-hackathon-judge";
const KNOWN_JUDGE = "did:privy:known-hackathon-judge";
const STRANGER = "did:privy:production-stranger";
const PAYER_ACCOUNT = "0.0.5678";
const SERVICE_ACCOUNT = "0.0.1234";
const ECDSA_PRIVATE_KEY = `0x${"11".repeat(32)}`;
const PUBLIC_ORIGIN = "https://useomnis.vercel.app";

type Env = Record<string, string | undefined>;

function baseEnv(extra: Env = {}): Env {
  return {
    NODE_ENV: "production",
    OMNIS_DEMO_PURCHASES_ENABLED: "true",
    OMNIS_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    HEDERA_TESTNET_PAYER_ACCOUNT_ID: PAYER_ACCOUNT,
    HEDERA_TESTNET_PAYER_PRIVATE_KEY: ECDSA_PRIVATE_KEY,
    HEDERA_X402_SERVICE_ACCOUNT_ID: SERVICE_ACCOUNT,
    BLOCKY402_TESTNET_URL: "https://api.testnet.blocky402.com",
    ...extra,
  };
}

function publicEnv(extra: Env = {}): Env {
  return baseEnv({ OMNIS_DEMO_ACCESS_MODE: "public", ...extra });
}

function allowlistEnv(extra: Env = {}): Env {
  return baseEnv({
    OMNIS_DEMO_ACCESS_MODE: "allowlist",
    OMNIS_DEMO_ALLOWLIST: KNOWN_JUDGE,
    ...extra,
  });
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
        ownerId: UNKNOWN_JUDGE,
        ownerSubject: UNKNOWN_JUDGE,
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

test.beforeEach(() => {
  resetDemoCountersForTests();
});

test.describe("P8D.1 public hackathon demo access", () => {
  test("1. public mode plus valid config keeps the live service available", () => {
    const env = publicEnv();
    expect(readDemoAccessMode(env)).toBe("public");
    expect(isP4ADemoGateOpen(env)).toBe(true);
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
    expect(live?.price.units).toBe(BigInt(3000));
    expect(live?.paymentAmount?.units).toBe(BigInt(3000));

    const { task, policy } = makeTaskAndPolicy("task-p8d1-live");
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
    expect(selection.selected?.remainingBudget?.units).toBe(BigInt(47000));
  });

  test("2 and 3. arbitrary subjects pass with no allowlist in public mode", () => {
    const env = publicEnv();
    expect(env.OMNIS_DEMO_ALLOWLIST).toBeUndefined();
    expect(isP4ADemoGateOpen(env)).toBe(true);
    expect(isDemoSubjectAuthorized(UNKNOWN_JUDGE, env)).toBe(true);
    expect(isDemoSubjectAuthorized(STRANGER, env)).toBe(true);
    expect(checkAndRecordDemoPurchase(UNKNOWN_JUDGE, env)).toEqual({
      ok: true,
    });
    const result = checkAndRecordDemoPurchase(STRANGER, env);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("allowlist");
  });

  test("4. allowlist mode still requires the exact subject", () => {
    const env = allowlistEnv();
    expect(readDemoAccessMode(env)).toBe("allowlist");
    expect(isP4ADemoGateOpen(env)).toBe(true);
    expect(isDemoSubjectAuthorized(KNOWN_JUDGE, env)).toBe(true);
    expect(isDemoSubjectAuthorized(UNKNOWN_JUDGE, env)).toBe(false);
    expect(checkAndRecordDemoPurchase(KNOWN_JUDGE, env)).toEqual({ ok: true });
    expect(checkAndRecordDemoPurchase(UNKNOWN_JUDGE, env)).toEqual({
      ok: false,
      error: "demo purchases are restricted to allowlisted judges",
      status: 403,
    });
    const emptyAllowlist = allowlistEnv({ OMNIS_DEMO_ALLOWLIST: "" });
    expect(isP4ADemoGateOpen(emptyAllowlist)).toBe(false);
  });

  test("5 and 6. invalid access mode and disabled purchases fail closed", () => {
    const invalidMode = publicEnv({ OMNIS_DEMO_ACCESS_MODE: "everyone" });
    expect(readDemoAccessMode(invalidMode)).toBeUndefined();
    expect(isP4ADemoGateOpen(invalidMode)).toBe(false);
    expect(isDemoSubjectAuthorized(UNKNOWN_JUDGE, invalidMode)).toBe(false);
    expect(resolveP4ALiveServiceStatus(invalidMode, true)).toBe("unavailable");
    expect(checkAndRecordDemoPurchase(UNKNOWN_JUDGE, invalidMode)).toEqual({
      ok: false,
      error: "live service purchases are disabled in production",
      status: 503,
    });

    const upperMode = publicEnv({ OMNIS_DEMO_ACCESS_MODE: "PUBLIC" });
    expect(readDemoAccessMode(upperMode)).toBeUndefined();
    expect(isP4ADemoGateOpen(upperMode)).toBe(false);
    expect(isDemoSubjectAuthorized(UNKNOWN_JUDGE, upperMode)).toBe(false);
    expect(resolveP4ALiveServiceStatus(upperMode, true)).toBe("unavailable");

    const invalidWithAllowlist = baseEnv({
      OMNIS_DEMO_ACCESS_MODE: "everyone",
      OMNIS_DEMO_ALLOWLIST: UNKNOWN_JUDGE,
    });
    expect(isDemoSubjectAuthorized(UNKNOWN_JUDGE, invalidWithAllowlist)).toBe(
      false,
    );
    expect(isP4ADemoGateOpen(invalidWithAllowlist)).toBe(false);
    const missingMode = baseEnv();
    expect(readDemoAccessMode(missingMode)).toBeUndefined();
    expect(isP4ADemoGateOpen(missingMode)).toBe(false);
    expect(isDemoSubjectAuthorized(UNKNOWN_JUDGE, missingMode)).toBe(false);
    expect(resolveP4ALiveServiceStatus(missingMode, true)).toBe("unavailable");

    const disabled = publicEnv({ OMNIS_DEMO_PURCHASES_ENABLED: "false" });
    expect(isP4ADemoGateOpen(disabled)).toBe(false);
    expect(isDemoSubjectAuthorized(UNKNOWN_JUDGE, disabled)).toBe(false);
    expect(isDemoSubjectAuthorized("", publicEnv())).toBe(false);
    expect(resolveP4ALiveServiceStatus(disabled, true)).toBe("unavailable");
    expect(checkAndRecordDemoPurchase(UNKNOWN_JUDGE, disabled)).toEqual({
      ok: false,
      error: "live service purchases are disabled in production",
      status: 503,
    });
  });

  test("7 and 8. malformed origin and invalid Hedera config fail closed", () => {
    const badOrigin = publicEnv({
      OMNIS_PUBLIC_ORIGIN: "https://useomnis.vercel.app/app",
    });
    expect(resolveP4ALiveServiceStatus(badOrigin, true)).toBe("unavailable");
    const missingOrigin = publicEnv({ OMNIS_PUBLIC_ORIGIN: undefined });
    expect(resolveP4ALiveServiceStatus(missingOrigin, true)).toBe(
      "unavailable",
    );

    const broken = publicEnv({
      HEDERA_TESTNET_PAYER_PRIVATE_KEY: undefined,
    });
    const inspection = inspectP4AEnvironment(broken);
    expect(inspection.configured).toBe(false);
    expect(inspection.missing).toEqual(["HEDERA_TESTNET_PAYER_PRIVATE_KEY"]);
    expect(JSON.stringify(inspection)).not.toContain("1111");
    expect(
      resolveP4ALiveServiceStatus(broken, inspection.configured),
    ).toBe("unavailable");
  });

  test("9 and 11. catalog stays non-executable and the price stays 3000", async () => {
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("live requests are not allowed in this test");
    }) as typeof fetch;
    try {
      const env = publicEnv();
      const inspection = inspectP4AEnvironment(env);
      const registry = createLiveServiceRegistry(
        resolveP4ALiveServiceStatus(env, inspection.configured),
      );
      const { task, policy } = makeTaskAndPolicy("task-p8d1-catalog");
      const catalogRegistry = createLiveServiceRegistry("unavailable");
      const catalogSelection = selectServiceCandidate({
        task,
        policy,
        existingPurchases: [],
        registry: catalogRegistry,
        requiredCapability: "wallet-activity",
      });
      expect(catalogSelection.selected?.descriptor.catalogOnly).toBe(true);
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

      const outcome = await authorizeServicePurchase({
        task,
        policy,
        servicePurchases: [],
        registry,
        discovery: {
          requiredCapability: "wallet-activity",
          selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
          discoveredAt: NOW,
          registryVersion: registry.version,
        },
        wallet: CONTRACTOR_WALLET,
      });
      expect(outcome.kind).toBe("approved");
      if (outcome.kind !== "approved") throw new Error("expected approval");
      expect(outcome.purchase.quotedAmount.units).toBe(BigInt(3000));
      expect(outcome.purchase.quotedAmount.asset).toBe("USD");
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(fetchCalls).toBe(0);
  });

  test("10 and 12. P2 denial precedes payment and client state cannot override", async () => {
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("live requests are not allowed in this test");
    }) as typeof fetch;
    try {
      const env = publicEnv();
      const inspection = inspectP4AEnvironment(env);
      const registry = createLiveServiceRegistry(
        resolveP4ALiveServiceStatus(env, inspection.configured),
      );
      const tight = makeTaskAndPolicy("task-p8d1-deny", "0.001");
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

      const { task, policy } = makeTaskAndPolicy("task-p8d1-tamper");
      await expect(
        authorizeServicePurchase({
          task,
          policy,
          servicePurchases: [],
          registry,
          discovery: {
            requiredCapability: "wallet-activity",
            selectedServiceId: "catalog-wallet-activity",
            discoveredAt: NOW,
            registryVersion: registry.version,
          },
          wallet: CONTRACTOR_WALLET,
        }),
      ).rejects.toThrow(/not the executable/);
      await expect(
        authorizeServicePurchase({
          task,
          policy,
          servicePurchases: [],
          registry,
          discovery: {
            requiredCapability: "wallet-activity",
            selectedServiceId: WALLET_ACTIVITY_SERVICE_ID,
            discoveredAt: NOW,
            registryVersion: "stale-registry-version",
          },
          wallet: CONTRACTOR_WALLET,
        }),
      ).rejects.toThrow(/stale/);

      const first = resolveWalletActivityEndpoint(
        "https://useomnis.vercel.app/app?debug=true",
        env,
      );
      const second = resolveWalletActivityEndpoint(
        "https://useomnis.vercel.app/other",
        env,
      );
      expect(first).toBe("https://useomnis.vercel.app/api/services/wallet-activity");
      expect(second).toBe(first);
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(fetchCalls).toBe(0);
  });

  test("13. exhausted public allowance points at evidence, never at policy", () => {
    const env = publicEnv({ OMNIS_DEMO_MAX_PURCHASES_PER_SUBJECT: "1" });
    expect(checkAndRecordDemoPurchase(UNKNOWN_JUDGE, env)).toEqual({
      ok: true,
    });
    expect(checkAndRecordDemoPurchase(UNKNOWN_JUDGE, env)).toEqual({
      ok: false,
      error:
        "Live demo allowance used. You can still inspect the verified demo evidence.",
      status: 429,
    });
  });

  test("12b. tampered live fields stay non-executable with no payment", async () => {
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("live requests are not allowed in this test");
    }) as typeof fetch;
    try {
      const base = {
        id: WALLET_ACTIVITY_SERVICE_ID,
        name: "Wallet activity check",
        capability: "wallet-activity",
        category: "wallet-risk",
        endpoint: "/api/services/wallet-activity",
        network: "hedera:testnet",
        paymentProtocol: "x402",
        inputSchema: { wallet: { type: "string" } },
        outputSchema: { observations: { type: "string" } },
        status: "available",
        environment: "testnet",
        catalogOnly: false,
      } as const;
      const mutations = [
        { name: "wrong network", override: { network: "hedera:mainnet" } },
        {
          name: "wrong token",
          override: { paymentAmount: money("0.003", "USD", 6) },
        },
        {
          name: "wrong amount",
          override: { paymentAmount: money("0.004", "USDC", 6) },
        },
        {
          name: "wrong quote",
          override: { price: money("0.004", "USD") },
        },
        {
          name: "wrong endpoint",
          override: { endpoint: "catalog://evil-wallet-activity" },
        },
        { name: "catalog-only", override: { catalogOnly: true } },
      ] as const;
      expect(mutations.length).toBe(6);
      for (const mutation of mutations) {
        const descriptor = createServiceDescriptor({
          ...base,
          description: `Tampered live descriptor: ${mutation.name}.`,
          price: money("0.003", "USD"),
          paymentAmount: money("0.003", "USDC", 6),
          ...mutation.override,
        });
        const registry = createServiceRegistry([descriptor]);
        const { task, policy } = makeTaskAndPolicy(
          `task-p8d1-tamper-${mutation.name.replace(/[^a-z]+/g, "-")}`,
        );
        let paymentCalls = 0;
        await expect(
          executeServicePurchase({
            task,
            policy,
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
              throw new Error("payment must not run for a tampered service");
            },
          }),
        ).rejects.toThrow(/not the executable|fixed allowlisted amount/);
        expect(paymentCalls).toBe(0);
      }
      expect(() =>
        createServiceDescriptor({
          ...base,
          description: "Tampered protocol.",
          price: money("0.003", "USD"),
          paymentProtocol: "other" as unknown as "x402",
        }),
      ).toThrow(/payment protocol must be x402/);
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(fetchCalls).toBe(0);
  });
});
