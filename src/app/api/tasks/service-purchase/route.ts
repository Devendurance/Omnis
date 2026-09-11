import { isDomainError } from "@/lib/domain";
import {
  HEDERA_TESTNET_NETWORK,
  HEDERA_TESTNET_USDC_ASSET,
  WALLET_ACTIVITY_PRICE,
} from "@/lib/services/wallet-activity-descriptor";
import {
  readHederaX402RuntimeConfig,
  resolveWalletActivityEndpoint,
} from "@/lib/services/hedera-x402/config";
import {
  checkAndRecordDemoPurchase,
  isDemoPurchasesEnabled,
} from "@/lib/services/server/demo-guard";
import {
  getP4ALiveServiceRegistry,
  payWalletActivityService,
} from "@/lib/services/server/p4a";
import {
  executeServicePurchase,
  type ServiceExecutionOutcome,
  type ServiceExecutionState,
  type TrustedServicePayment,
} from "@/lib/tasks/service-execution";
import {
  hydrateDraftSession,
  serializeDraftSession,
} from "@/lib/tasks/persistence";
import type { TaskSession } from "@/lib/tasks/session";
import {
  extractBearerToken,
  verifyPrivyAccessToken,
} from "@/lib/auth/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inFlight = new Map<string, Promise<ServiceExecutionOutcome>>();
const completed = new Map<string, ServiceExecutionOutcome>();
const MAX_IDEMPOTENCY_ENTRIES = 100;

type RequestBody = Readonly<{
  action?: unknown;
  wallet?: unknown;
  requestId?: unknown;
  session?: unknown;
  ownerSubject?: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sessionWithState(
  session: TaskSession,
  state: ServiceExecutionState,
): TaskSession {
  return {
    ...session,
    task: state.task,
    policy: state.policy,
    servicePurchases: state.servicePurchases,
    budget: state.budget,
  };
}

function responsePurchase(
  purchase: ServiceExecutionOutcome["purchase"],
): Record<string, unknown> {
  return {
    id: purchase.id,
    taskId: purchase.taskId,
    serviceId: purchase.serviceId,
    quotedAmount: {
      amount: purchase.quotedAmount.units.toString(),
      asset: purchase.quotedAmount.asset,
      decimals: purchase.quotedAmount.decimals,
    },
    ...(purchase.paymentAmount
      ? {
          paymentAmount: {
            amount: purchase.paymentAmount.units.toString(),
            asset: purchase.paymentAmount.asset,
            decimals: purchase.paymentAmount.decimals,
          },
        }
      : {}),
    ...(purchase.paidAmount
      ? {
          paidAmount: {
            amount: purchase.paidAmount.units.toString(),
            asset: purchase.paidAmount.asset,
            decimals: purchase.paidAmount.decimals,
          },
        }
      : {}),
    ...(purchase.requestId ? { requestId: purchase.requestId } : {}),
    ...(purchase.paymentIdentifier
      ? { paymentIdentifier: purchase.paymentIdentifier }
      : {}),
    ...(purchase.settlementNetwork
      ? { settlementNetwork: purchase.settlementNetwork }
      : {}),
    ...(purchase.serviceResult ? { serviceResult: purchase.serviceResult } : {}),
    ...(purchase.recoveryState
      ? { recoveryState: purchase.recoveryState }
      : {}),
    status: purchase.status,
    createdAt: purchase.createdAt,
    updatedAt: purchase.updatedAt,
  };
}

function responseFor(
  session: TaskSession,
  outcome: ServiceExecutionOutcome,
  registry: ReturnType<typeof getP4ALiveServiceRegistry>,
): Response {
  const nextSession = sessionWithState(session, outcome.state);
  const serializedSession = serializeDraftSession(nextSession, registry);
  return Response.json(
    {
      ok: outcome.kind === "paid",
      outcome: outcome.kind,
      message:
        "message" in outcome
          ? outcome.message
          : "wallet activity service purchase is approved",
      session: JSON.parse(serializedSession),
      purchase: responsePurchase(outcome.purchase),
      budget: {
        confirmedSpend: {
          amount: outcome.state.budget.confirmedSpend.units.toString(),
          asset: outcome.state.budget.confirmedSpend.asset,
          decimals: outcome.state.budget.confirmedSpend.decimals,
        },
        reservedSpend: {
          amount: outcome.state.budget.reservedSpend.units.toString(),
          asset: outcome.state.budget.reservedSpend.asset,
          decimals: outcome.state.budget.reservedSpend.decimals,
        },
        remainingAvailable: {
          amount: outcome.state.budget.remainingAvailable.units.toString(),
          asset: outcome.state.budget.remainingAvailable.asset,
          decimals: outcome.state.budget.remainingAvailable.decimals,
        },
      },
      ...(outcome.kind === "failed" || outcome.kind === "recovery"
        ? {
            error:
              "message" in outcome
                ? outcome.message
                : "service purchase failed",
            errorCode:
              outcome.purchase.recoveryState?.stage ??
              (outcome.kind === "failed"
                ? "P4B_PRE_SETTLEMENT_FAILED"
                : "P4A_PAYMENT_OUTCOME_UNKNOWN"),
            stage:
              outcome.purchase.recoveryState?.stage ??
              (outcome.kind === "failed"
                ? "resource_execution"
                : "outcome_unknown"),
            settlementSent:
              outcome.purchase.recoveryState?.settlementSent ?? false,
            paymentSettled:
              outcome.purchase.recoveryState?.paymentSettled ?? false,
            retryable:
              outcome.kind === "failed" ||
              Boolean(outcome.purchase.recoveryState?.retryable),
            requestId:
              outcome.purchase.requestId ??
              outcome.purchase.recoveryState?.requestId,
          }
        : {}),
      ...(outcome.kind === "paid"
        ? {
            payment: {
              paymentIdentifier: outcome.purchase.paymentIdentifier,
              settlementNetwork: outcome.purchase.settlementNetwork,
            },
          }
        : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function remember(key: string, outcome: ServiceExecutionOutcome): void {
  if (outcome.kind === "failed") return;
  completed.set(key, outcome);
  while (completed.size > MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = completed.keys().next().value;
    if (!oldest) break;
    completed.delete(oldest);
  }
}

export async function POST(request: Request): Promise<Response> {

  const bearerToken = extractBearerToken(request);
  if (!bearerToken) {
    return Response.json(
      {
        ok: false,
        error: "authentication required: missing bearer access token",
      },
      { status: 401 },
    );
  }

  let serverSubject: string;
  try {
    const verified = await verifyPrivyAccessToken(bearerToken);
    serverSubject = verified.userId;
  } catch {
    return Response.json(
      {
        ok: false,
        error: "authentication failed: invalid or expired access token",
      },
      { status: 401 },
    );
  }
  let body: RequestBody;
  try {
    const parsed: unknown = await request.json();
    if (!isRecord(parsed)) {
      return Response.json({ ok: false, error: "request body must be an object" }, { status: 400 });
    }
    body = parsed;
  } catch {
    return Response.json({ ok: false, error: "request body must be valid JSON" }, { status: 400 });
  }

  if (body.action !== "start-wallet-check") {
    return Response.json(
      { ok: false, error: "an explicit start-wallet-check action is required" },
      { status: 400 },
    );
  }

  const clientOwnerSubject = text(body.ownerSubject);
  if (clientOwnerSubject && clientOwnerSubject !== serverSubject) {
    return Response.json(
      {
        ok: false,
        error: "client owner identity does not match authenticated token subject",
      },
      { status: 403 },
    );
  }

  const wallet = text(body.wallet);
  if (!wallet || !isRecord(body.session)) {
    return Response.json(
      { ok: false, error: "wallet and a persisted task session are required" },
      { status: 400 },
    );
  }

  const registry = getP4ALiveServiceRegistry();
  const session = hydrateDraftSession(JSON.stringify(body.session), registry, {
    expectedOwnerSubject: serverSubject,
  });
  if (!session || !session.task || !session.policy || !session.discovery) {
    return Response.json(
      {
        ok: false,
        error:
          "the persisted task, policy, and discovery state are invalid or not owned by the authenticated user",
      },
      { status: 403 },
    );
  }
  if (
    (session.ownerSubject && session.ownerSubject !== serverSubject) ||
    (session.task.ownerSubject && session.task.ownerSubject !== serverSubject) ||
    (session.task.ownerId !== serverSubject &&
      session.task.ownerSubject !== serverSubject)
  ) {
    return Response.json(
      { ok: false, error: "task is not owned by the authenticated user" },
      { status: 403 },
    );
  }
  if (process.env.NODE_ENV === "production") {
    if (!isDemoPurchasesEnabled()) {
      return Response.json(
        { ok: false, error: "live service purchases are disabled in production" },
        { status: 503 },
      );
    }
    const demoCheck = checkAndRecordDemoPurchase(serverSubject);
    if (!demoCheck.ok) {
      return Response.json(
        { ok: false, error: demoCheck.error },
        { status: demoCheck.status },
      );
    }
  }
  if (
    session.task.type !== "pay_with_check" ||
    !session.task.recipient ||
    session.task.recipient.toLowerCase() !== wallet.toLowerCase()
  ) {
    return Response.json(
      { ok: false, error: "the requested wallet does not match the task recipient" },
      { status: 400 },
    );
  }
  const selected = session.discovery.selectedServiceId
    ? registry.getService(session.discovery.selectedServiceId)
    : undefined;
  if (!selected || selected.status !== "available" || selected.catalogOnly) {
    return Response.json(
      { ok: false, error: "the selected wallet activity service is unavailable" },
      { status: 409 },
    );
  }

  const persistedRequestId = text(body.requestId);
  const activeExisting = session.servicePurchases?.find(
    (purchase) =>
      purchase.serviceId === selected.id &&
      ["approved", "paying", "paid"].includes(purchase.status) &&
      purchase.requestId,
  );
  const key = `p4b-wallet-activity-session-${serverSubject}:${session.task.id}:${selected.id}${
    activeExisting?.requestId ? `:${activeExisting.requestId}` : ""
  }`;
  const requestId = persistedRequestId ?? activeExisting?.requestId;
  const cached = completed.get(key);
  if (cached) return responseFor(session, cached, registry);

  let config: ReturnType<typeof readHederaX402RuntimeConfig>;
  try {
    config = readHederaX402RuntimeConfig();
  } catch {
    return Response.json(
      { ok: false, error: "Hedera x402 service configuration is unavailable" },
      { status: 503 },
    );
  }

  const execute = async (): Promise<ServiceExecutionOutcome> => {
    const serviceEndpoint = resolveWalletActivityEndpoint(request.url);
    const executePayment = async (input: {
      wallet: string;
      serviceEndpoint: string;
      requestId: string;
    }): Promise<TrustedServicePayment> => {
      const endpoint = new URL(input.serviceEndpoint, `${serviceEndpoint}/`).toString();
      const paid = await payWalletActivityService({
        wallet: input.wallet,
        serviceEndpoint: endpoint,
        requestId: input.requestId,
        config,
      });
      return paid as unknown as TrustedServicePayment;
    };
    return executeServicePurchase({
      task: session.task!,
      policy: session.policy!,
      servicePurchases: session.servicePurchases ?? [],
      registry,
      discovery: session.discovery,
      wallet,
      ...(requestId ? { requestId } : {}),
      executePayment,
      expectedPayment: {
        network: HEDERA_TESTNET_NETWORK,
        asset: HEDERA_TESTNET_USDC_ASSET,
        amount: WALLET_ACTIVITY_PRICE.units.toString(),
        payTo: config.serviceAccountId,
      },
    });
  };

  const pending = inFlight.get(key) ?? execute();
  if (!inFlight.has(key)) inFlight.set(key, pending);
  try {
    const outcome = await pending;
    remember(key, outcome);
    return responseFor(session, outcome, registry);
  } catch (error) {
    const code = isDomainError(error)
      ? error.code
      : text(isRecord(error) ? error.code : undefined);
    const message = error instanceof Error ? error.message : "service purchase failed";
    return Response.json(
      { ok: false, ...(code ? { code } : {}), error: message },
      {
        status:
          code?.startsWith("P2_") || code?.startsWith("DENY_") ? 403 : 422,
      },
    );
  } finally {
    inFlight.delete(key);
  }
}
