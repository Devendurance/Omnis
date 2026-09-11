import { expect, test } from "@playwright/test";
import {
  assertWalletActivityEndpoint,
  readPublicOrigin,
  resolveWalletActivityEndpoint,
} from "../src/lib/services/hedera-x402/config";
import {
  checkAndRecordDemoPurchase,
  isDemoPurchasesEnabled,
  isDemoSubjectAllowlisted,
  readDemoAllowlist,
  readDemoMaxPerSubject,
  resetDemoCountersForTests,
} from "../src/lib/services/server/demo-guard";

const JUDGE = "did:privy:judge-one";
const STRANGER = "did:privy:stranger";

function demoEnv(extra: Record<string, string> = {}) {
  return {
    NODE_ENV: "production",
    OMNIS_DEMO_PURCHASES_ENABLED: "true",
    OMNIS_DEMO_ALLOWLIST: JUDGE,
    OMNIS_PUBLIC_ORIGIN: "https://demo.example.com",
    ...extra,
  };
}

test.beforeEach(() => {
  resetDemoCountersForTests();
});

test.describe("P8A hosted-demo guard", () => {
  test("demo purchases stay disabled without the explicit server flag", () => {
    expect(isDemoPurchasesEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      isDemoPurchasesEnabled({ NODE_ENV: "production", OMNIS_DEMO_PURCHASES_ENABLED: "yes" }),
    ).toBe(false);
    expect(isDemoPurchasesEnabled(demoEnv())).toBe(true);
  });

  test("allowlist is exact-match and durable server configuration", () => {
    expect(readDemoAllowlist(demoEnv())).toEqual([JUDGE]);
    expect(isDemoSubjectAllowlisted(JUDGE, demoEnv())).toBe(true);
    expect(isDemoSubjectAllowlisted(STRANGER, demoEnv())).toBe(false);
    expect(isDemoSubjectAllowlisted("", demoEnv())).toBe(false);
    expect(
      isDemoSubjectAllowlisted(JUDGE, demoEnv({ OMNIS_DEMO_ALLOWLIST: ` ${JUDGE} , did:privy:judge-two ` })),
    ).toBe(true);
  });

  test("public users are rejected before any spend", () => {
    const result = checkAndRecordDemoPurchase(STRANGER, demoEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  test("allowlisted judges get a strict bounded allowance, then 429", () => {
    const env = demoEnv({ OMNIS_DEMO_MAX_PURCHASES_PER_SUBJECT: "2" });
    expect(readDemoMaxPerSubject(env)).toBe(2);
    expect(checkAndRecordDemoPurchase(JUDGE, env)).toEqual({ ok: true });
    expect(checkAndRecordDemoPurchase(JUDGE, env)).toEqual({ ok: true });
    const exhausted = checkAndRecordDemoPurchase(JUDGE, env);
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) {
      expect(exhausted.status).toBe(429);
    }
  });

  test("hourly window resets the rate counter but the lifetime cap holds", () => {
    const env = demoEnv({ OMNIS_DEMO_MAX_PURCHASES_PER_SUBJECT: "3" });
    const start = 1_700_000_000_000;
    expect(checkAndRecordDemoPurchase(JUDGE, env, start).ok).toBe(true);
    expect(checkAndRecordDemoPurchase(JUDGE, env, start + 3_601_000).ok).toBe(true);
    expect(checkAndRecordDemoPurchase(JUDGE, env, start + 3_602_000).ok).toBe(true);
    const exhausted = checkAndRecordDemoPurchase(JUDGE, env, start + 3_603_000);
    expect(exhausted.ok).toBe(false);
  });
});

test.describe("P8A production-origin endpoint contract", () => {
  test("public origin must be a bare https origin", () => {
    expect(readPublicOrigin({ OMNIS_PUBLIC_ORIGIN: "https://demo.example.com" })?.origin).toBe(
      "https://demo.example.com",
    );
    expect(readPublicOrigin({})).toBeNull();
    expect(() => readPublicOrigin({ OMNIS_PUBLIC_ORIGIN: "http://demo.example.com" })).toThrow();
    expect(() => readPublicOrigin({ OMNIS_PUBLIC_ORIGIN: "https://demo.example.com/app" })).toThrow();
  });

  test("production request origin resolves to the configured public endpoint", () => {
    const env = demoEnv();
    const resolved = resolveWalletActivityEndpoint("https://demo.example.com/app", env);
    expect(resolved).toBe("https://demo.example.com/api/services/wallet-activity");
    const accepted = assertWalletActivityEndpoint(resolved, env);
    expect(accepted.origin).toBe("https://demo.example.com");
  });

  test("unconfigured or foreign origins are rejected", () => {
    const env = demoEnv();
    expect(() =>
      assertWalletActivityEndpoint("https://evil.example.com/api/services/wallet-activity", env),
    ).toThrow();
    expect(() =>
      assertWalletActivityEndpoint("https://demo.example.com/api/services/other", env),
    ).toThrow();
    expect(() =>
      assertWalletActivityEndpoint(
        "https://demo.example.com/api/services/wallet-activity",
        { NODE_ENV: "production" },
      ),
    ).toThrow();
  });

  test("localhost endpoints keep working for local development", () => {
    const endpoint = assertWalletActivityEndpoint(
      "http://127.0.0.1:3000/api/services/wallet-activity",
      { NODE_ENV: "development" },
    );
    expect(endpoint.hostname).toBe("127.0.0.1");
  });
});
