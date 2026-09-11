// Server-side only: import exclusively from API routes and server modules.
// (Kept free of the server-only marker so unit tests can import it, matching
// the convention of the hedera-x402 modules it guards.)

import {
  readPublicOrigin,
  type P4AEnvironment,
} from "../hedera-x402/config";
export const DEMO_PURCHASES_ENV = "OMNIS_DEMO_PURCHASES_ENABLED" as const;
export const DEMO_ACCESS_MODE_ENV = "OMNIS_DEMO_ACCESS_MODE" as const;
export const DEMO_ALLOWLIST_ENV = "OMNIS_DEMO_ALLOWLIST" as const;
export const DEMO_MAX_PER_SUBJECT_ENV =
  "OMNIS_DEMO_MAX_PURCHASES_PER_SUBJECT" as const;

export type DemoAccessMode = "public" | "allowlist";

export function readDemoAccessMode(
  env: P4AEnvironment = process.env,
): DemoAccessMode | undefined {
  const raw = env[DEMO_ACCESS_MODE_ENV]?.trim();
  if (raw === "public" || raw === "allowlist") return raw;
  return undefined;
}

export const DEMO_DEFAULT_MAX_PER_SUBJECT = 3 as const;
export const DEMO_WINDOW_MS: number = 60 * 60 * 1000;

type DemoCounter = {
  total: number;
  windowStart: number;
  windowCount: number;
};
// Process-local defense-in-depth counter only. It is NOT the authoritative
// drain protection: serverless restarts or extra instances reset it. The
// authoritative safety boundary is the fixed wallet-activity service, the
// fixed 3000-unit testnet HTS USDC amount, the narrow payer endpoint
// allowlist, and a demo payer account funded with only a few cents of
// testnet USDC. The per-subject counter and the P2 per-task policy caps in
// executeServicePurchase are additional best-effort layers. Documented as
// non-authoritative by design.
const counters = new Map<string, DemoCounter>();
export function isP4ADemoGateOpen(
  env: P4AEnvironment = process.env,
): boolean {
  if (env[DEMO_PURCHASES_ENV]?.trim() !== "true") return false;
  const mode = readDemoAccessMode(env);
  if (mode === "public") return true;
  if (mode === "allowlist") return readDemoAllowlist(env).length > 0;
  return false;
}

export function isPublicOriginValid(
  env: P4AEnvironment = process.env,
): boolean {
  try {
    return readPublicOrigin(env) !== null;
  } catch {
    return false;
  }
}

export function resolveP4ALiveServiceStatus(
  env: P4AEnvironment,
  hederaConfigured: boolean,
): "available" | "unavailable" {
  if (env.NODE_ENV === "production") {
    if (!isP4ADemoGateOpen(env)) return "unavailable";
    if (!isPublicOriginValid(env)) return "unavailable";
  }
  return hederaConfigured ? "available" : "unavailable";
}

export function isDemoPurchasesEnabled(
  env: P4AEnvironment = process.env,
): boolean {
  return env[DEMO_PURCHASES_ENV]?.trim() === "true";
}

export function readDemoAllowlist(
  env: P4AEnvironment = process.env,
): readonly string[] {
  const raw = env[DEMO_ALLOWLIST_ENV]?.trim();
  if (!raw) return Object.freeze([]);
  return Object.freeze(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function isDemoSubjectAllowlisted(
  subject: string,
  env: P4AEnvironment = process.env,
): boolean {
  const clean = subject.trim();
  if (!clean) return false;
  return readDemoAllowlist(env).some((entry) => entry === clean);
}

export function isDemoSubjectAuthorized(
  subject: string,
  env: P4AEnvironment = process.env,
): boolean {
  if (env[DEMO_PURCHASES_ENV]?.trim() !== "true") return false;
  const clean = subject.trim();
  if (!clean) return false;
  const mode = readDemoAccessMode(env);
  if (mode === "public") return true;
  if (mode === "allowlist") return isDemoSubjectAllowlisted(clean, env);
  return false;
}

export function readDemoMaxPerSubject(
  env: P4AEnvironment = process.env,
): number {
  const raw = env[DEMO_MAX_PER_SUBJECT_ENV]?.trim();
  if (!raw) return DEMO_DEFAULT_MAX_PER_SUBJECT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEMO_DEFAULT_MAX_PER_SUBJECT;
  }
  return Math.min(parsed, 10);
}

export function checkAndRecordDemoPurchase(
  subject: string,
  env: P4AEnvironment = process.env,
  now = Date.now(),
): { ok: true } | { ok: false; error: string; status: number } {
  const mode = readDemoAccessMode(env);
  if (env[DEMO_PURCHASES_ENV]?.trim() !== "true" || mode === undefined) {
    return {
      ok: false,
      error: "live service purchases are disabled in production",
      status: 503,
    };
  }
  if (!isDemoSubjectAuthorized(subject, env)) {
    return {
      ok: false,
      error: "demo purchases are restricted to allowlisted judges",
      status: 403,
    };
  }
  const max = readDemoMaxPerSubject(env);
  const key = subject.trim();
  const existing = counters.get(key);
  const counter: DemoCounter = existing ?? {
    total: 0,
    windowStart: now,
    windowCount: 0,
  };
  if (now - counter.windowStart >= DEMO_WINDOW_MS) {
    counter.windowStart = now;
    counter.windowCount = 0;
  }
  if (counter.total >= max || counter.windowCount >= max) {
    return mode === "public"
      ? {
          ok: false,
          error:
            "Live demo allowance used. You can still inspect the verified demo evidence.",
          status: 429,
        }
      : {
          ok: false,
          error: "demo purchase allowance exhausted for this judge",
          status: 429,
        };
  }
  counter.total += 1;
  counter.windowCount += 1;
  counters.set(key, counter);
  return { ok: true };
}

export function resetDemoCountersForTests(): void {
  counters.clear();
}
