import { expect, test } from "@playwright/test";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  P4AResourceExecutionError,
  P4APaymentFailureError,
  P4APayerError,
  payWalletActivityService,
} from "../src/lib/services/hedera-x402/payer";
import {
  Blocky402FacilitatorClient,
  type Blocky402Support,
} from "../src/lib/services/hedera-x402/facilitator";
import {
  WalletActivitySourceError,
  type WalletActivitySnapshot,
} from "../src/lib/services/hedera-x402/wallet-activity";
import {
  decodeP4ADiagnostics,
  encodeP4ADiagnostics,
  P4A_DIAGNOSTICS_HEADER,
} from "../src/lib/services/hedera-x402/diagnostics";
import {
  createWalletActivityRuntime,
  type HederaUsdcMetadata,
} from "../src/lib/services/hedera-x402/resource";
import { handleWalletActivityRequest } from "../src/lib/services/hedera-x402/http";

const SERVICE_ACCOUNT = "0.0.1234";
const FEE_PAYER = "0.0.7162784";
const PAYER_ACCOUNT = "0.0.5678";
const VALID_WALLET = "0x0000000000000000000000000000000000000001";
const ECDSA_PRIVATE_KEY = `0x${"11".repeat(32)}`;
const RESOURCE_URL = "http://127.0.0.1:3000/api/services/wallet-activity";

const support: Blocky402Support = Object.freeze({
  x402Version: 2,
  scheme: "exact",
  network: "hedera:testnet",
  feePayer: FEE_PAYER,
});

const token: HederaUsdcMetadata = Object.freeze({
  asset: "0.0.429274",
  decimals: 6,
  symbol: "USDC",
});

const config = Object.freeze({
  payerAccountId: PAYER_ACCOUNT,
  payerPrivateKey: ECDSA_PRIVATE_KEY,
  serviceAccountId: SERVICE_ACCOUNT,
  blocky402Url: "https://api.testnet.blocky402.com",
});

function supportedResponse(): SupportedResponse {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
        extra: { feePayer: FEE_PAYER },
      },
    ],
    extensions: [],
    signers: { "hedera:*": [FEE_PAYER] },
  };
}

function requirement(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.429274",
    amount: "3000",
    payTo: SERVICE_ACCOUNT,
    maxTimeoutSeconds: 180,
    extra: { feePayer: FEE_PAYER },
  };
}

function paymentRequired(resource = RESOURCE_URL): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: resource,
      description: "wallet activity",
      mimeType: "application/json",
    },
    accepts: [requirement()],
  };
}

function payloadFrom(challenge: PaymentRequired): PaymentPayload {
  return {
    x402Version: 2,
    resource: challenge.resource,
    accepted: challenge.accepts[0],
    payload: { transaction: "mock-partially-signed-transaction" },
  };
}

async function activitySnapshot(): Promise<WalletActivitySnapshot> {
  return {
    observations: {
      wallet: VALID_WALLET,
      chain: "ethereum:mainnet",
      source: "mock://ethereum-rpc",
      addressValidity: "valid",
      accountType: "eoa",
      transactionCount: "1",
      transactionActivityObserved: true,
    },
    heuristicFlags: [],
    disclaimer: "mocked data source",
  };
}
type FakeFacilitatorOptions = Readonly<{
  verify?: VerifyResponse;
  settle?: SettleResponse;
  settleError?: Error;
}>;

class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  lastPayload?: PaymentPayload;
  readonly options: FakeFacilitatorOptions;

  constructor(options: FakeFacilitatorOptions = {}) {
    this.options = options;
  }

  async getSupported(): Promise<SupportedResponse> {
    return supportedResponse();
  }

  async verify(payload: PaymentPayload): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    this.lastPayload = payload;
    return this.options.verify ?? { isValid: true, payer: PAYER_ACCOUNT };
  }

  async settle(
    _payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    void _payload;
    this.settleCalls += 1;
    if (this.options.settleError) throw this.options.settleError;
    return (
      this.options.settle ?? {
        success: true,
        transaction: "0.0.7162784@1700000000.000000000",
        network: requirements.network,
        payer: FEE_PAYER,
      }
    );
  }
}

async function runtimeFor(fake: FakeFacilitator) {
  return createWalletActivityRuntime({
    config,
    facilitatorClient: fake,
    support,
    token,
  });
}

async function challengeFor(runtime: Awaited<ReturnType<typeof runtimeFor>>) {
  const response = await handleWalletActivityRequest(
    new Request(RESOURCE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: VALID_WALLET }),
    }),
    { getRuntime: async () => runtime },
  );
  const header = response.headers.get("PAYMENT-REQUIRED");
  expect(response.status).toBe(402);
  expect(header).toBeTruthy();
  return {
    response,
    paymentRequired: decodePaymentRequiredHeader(header ?? ""),
  };
}

async function paidRequest(
  runtime: Awaited<ReturnType<typeof runtimeFor>>,
  payload: PaymentPayload,
  inspect = activitySnapshot,
): Promise<Response> {
  return handleWalletActivityRequest(
    new Request(RESOURCE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-omnis-idempotency-key": "p4a-handshake-test",
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload),
      },
      body: JSON.stringify({ wallet: VALID_WALLET }),
    }),
    { getRuntime: async () => runtime, inspect },
  );
}

test.describe("P4A Hedera x402 v2 settlement handshake", () => {
  test("uses PAYMENT-REQUIRED, PAYMENT-SIGNATURE, and PAYMENT-RESPONSE", async () => {
    const fake = new FakeFacilitator();
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    expect(paymentRequired.resource.url).toBe(RESOURCE_URL);

    const paid = await paidRequest(runtime, payloadFrom(paymentRequired));
    expect(paid.status).toBe(200);
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(paid.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
    expect(fake.verifyCalls).toBe(1);
    expect(fake.settleCalls).toBe(1);
    expect(fake.lastPayload?.x402Version).toBe(2);
    expect(await paid.json()).toMatchObject({
      observations: { transactionActivityObserved: true },
    });
  });

  test("valid verification and settlement execute exactly once", async () => {
    const fake = new FakeFacilitator();
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(runtime, payloadFrom(paymentRequired));

    expect(paid.status).toBe(200);
    expect(fake.verifyCalls).toBe(1);
    expect(fake.settleCalls).toBe(1);
    expect(decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE") ?? "")).toEqual(
      expect.objectContaining({
        success: true,
        transaction: "0.0.7162784@1700000000.000000000",
        network: "hedera:testnet",
        payer: FEE_PAYER,
      }),
    );
    expect(decodeP4ADiagnostics(
      paid.headers.get("x-omnis-p4a-diagnostics"),
    )).toMatchObject({
      resource: { attempted: true, success: true, status: 200 },
      settlement: {
        attempted: true,
        success: true,
        transaction: "0.0.7162784@1700000000.000000000",
      },
      recoveryStage: "resource_released",
      paymentResponsePresent: true,
    });
  });

  test("preserves the Hedera settlement.transaction exactly", async () => {
    const transaction = "0.0.7162784@1700000001.123456789";
    const fake = new FakeFacilitator({
      settle: {
        success: true,
        transaction,
        network: "hedera:testnet",
        payer: FEE_PAYER,
      },
    });
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(runtime, payloadFrom(paymentRequired));
    expect(decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE") ?? "").transaction).toBe(
      transaction,
    );
  });

  test("settle.success=false is deterministic and not unknown", async () => {
    const fake = new FakeFacilitator({
      settle: {
        success: false,
        errorReason: "insufficient_balance",
        errorMessage: "payer balance was insufficient",
        transaction: "",
        network: "hedera:testnet",
      },
    });
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(runtime, payloadFrom(paymentRequired));
    const body = await paid.text();
    expect(JSON.parse(body)).toMatchObject({
      error: "PAYMENT_SETTLEMENT_FAILED",
      stage: "settlement_failed",
      settlementSent: true,
      paymentSettled: false,
    });
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });

  test("invalid verification never calls settle", async () => {
    const fake = new FakeFacilitator({
      verify: {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_signature_invalid",
        invalidMessage: "payer signature is invalid",
      },
    });
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(runtime, payloadFrom(paymentRequired));
    expect(paid.status).toBe(402);
    expect(fake.verifyCalls).toBe(1);
    expect(fake.settleCalls).toBe(0);
    expect(paid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const diagnostics = decodeP4ADiagnostics(
      paid.headers.get("x-omnis-p4a-diagnostics"),
    );
    expect(diagnostics).toMatchObject({
      recoveryStage: "verification_failed",
      verification: {
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_signature_invalid",
        invalidMessage: "payer signature is invalid",
      },
    });
    const diagnosticsText = JSON.stringify(diagnostics);
    expect(diagnosticsText).not.toContain(ECDSA_PRIVATE_KEY);
    expect(diagnosticsText).not.toContain("mock-partially-signed-transaction");
  });

  test("a second 402 cannot become false success", async () => {
    let calls = 0;
    const fakeFacilitator: Pick<FacilitatorClient, "getSupported"> = {
      getSupported: async () => supportedResponse(),
    };
    const response = await payWalletActivityService({
      wallet: VALID_WALLET,
      serviceEndpoint: RESOURCE_URL,
      requestId: "p4a-second-402",
      config,
      facilitatorClient: fakeFacilitator,
      fetchImpl: async (_input, init) => {
        calls += 1;
        expect(init?.headers).toBeTruthy();
        if (calls === 1) {
          return new Response(null, {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()),
            },
          });
        }
        return new Response(JSON.stringify({ error: "verify_invalid" }), {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
              ...paymentRequired(),
              error: "invalid_exact_hedera_payload_signature_invalid",
            }),
          },
        });
      },
    }).catch((error: unknown) => error);
    expect(response).toBeInstanceOf(P4APaymentFailureError);
    expect((response as P4APaymentFailureError).code).not.toBe(
      "P4A_PAYMENT_OUTCOME_UNKNOWN",
    );
    expect(calls).toBe(2);
  });

  test("resource execution timeout before settle is a safe deterministic failure", async () => {
    const fake = new FakeFacilitator();
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(
      runtime,
      payloadFrom(paymentRequired),
      async (): Promise<WalletActivitySnapshot> => {
        throw new Error("wallet activity timeout before settlement");
      },
    );
    const body = await paid.text();
    expect(JSON.parse(body)).toMatchObject({
      error: "P4A_RESOURCE_EXECUTION_FAILED",
      stage: "resource_execution",
      settlementSent: false,
      paymentSettled: false,
      retryable: true,
    });
    expect(fake.settleCalls).toBe(0);
    expect(body).not.toContain("PAYMENT_OUTCOME_UNKNOWN");
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(decodeP4ADiagnostics(
      paid.headers.get("x-omnis-p4a-diagnostics"),
    )).toMatchObject({
      resource: {
        attempted: true,
        success: false,
        status: 502,
      },
      settlement: { attempted: false },
      recoveryStage: "resource_execution",
      paymentResponsePresent: false,
    });
  });
  test("wallet activity source failures expose safe structured diagnostics", async () => {
    const fake = new FakeFacilitator();
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(
      runtime,
      payloadFrom(paymentRequired),
      async (): Promise<WalletActivitySnapshot> => {
        throw new WalletActivitySourceError(
          "Ethereum public RPC failed the eth_getCode request",
          { upstreamStatus: 200 },
        );
      },
    );
    expect(await paid.json()).toMatchObject({
      error: "P4A_RESOURCE_EXECUTION_FAILED",
      settlementSent: false,
      paymentSettled: false,
    });
    expect(fake.settleCalls).toBe(0);
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(decodeP4ADiagnostics(
      paid.headers.get("x-omnis-p4a-diagnostics"),
    )).toMatchObject({
      resource: {
        attempted: true,
        success: false,
        status: 502,
        errorCode: "WALLET_ACTIVITY_SOURCE_UNAVAILABLE",
        upstreamStatus: 200,
      },
      settlement: { attempted: false },
    });
  });

  test("known pre-settlement resource failure is retryable after fixing the cause", async () => {
    let calls = 0;
    const settlement: SettleResponse = {
      success: true,
      transaction: "0.0.7162784@1700000000.000000000",
      network: "hedera:testnet",
      payer: FEE_PAYER,
    };
    const resourceFailureDiagnostics = encodeP4ADiagnostics({
      resourceHttpStatus: 502,
      paymentRequiredPresent: false,
      paymentResponsePresent: false,
      resource: {
        attempted: true,
        success: false,
        status: 502,
        errorCode: "WALLET_ACTIVITY_SOURCE_UNAVAILABLE",
        upstreamStatus: 200,
      },
      settlement: { attempted: false },
      verification: { httpStatus: 200, isValid: true },
      recoveryStage: "resource_execution",
    });
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls % 2 === 1) {
        return new Response(null, {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()),
          },
        });
      }
      if (calls === 2) {
        return new Response(
          JSON.stringify({
            error: "P4A_RESOURCE_EXECUTION_FAILED",
            message: "protected resource unavailable",
          }),
          {
            status: 502,
            headers: {
              "content-type": "application/json",
              [P4A_DIAGNOSTICS_HEADER]: resourceFailureDiagnostics,
            },
          },
        );
      }
      return new Response(JSON.stringify(await activitySnapshot()), {
        status: 200,
        headers: {
          "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
        },
      });
    };
    const first = await payWalletActivityService({
      wallet: VALID_WALLET,
      serviceEndpoint: RESOURCE_URL,
      requestId: "p4a-retryable-resource",
      config,
      facilitatorClient: { getSupported: async () => supportedResponse() },
      fetchImpl,
    }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(P4AResourceExecutionError);
    expect((first as P4AResourceExecutionError).recovery).toMatchObject({
      stage: "resource_execution",
      retryable: true,
    });
    const second = await payWalletActivityService({
      wallet: VALID_WALLET,
      serviceEndpoint: RESOURCE_URL,
      requestId: "p4a-retryable-resource-fixed",
      config,
      facilitatorClient: { getSupported: async () => supportedResponse() },
      fetchImpl,
    });
    expect(second.paymentIdentifier).toBe(settlement.transaction);
    expect(second.diagnostics).toMatchObject({
      recoveryStage: "resource_released",
      settlement: { attempted: false },
    });
    expect(calls).toBe(4);
  });

  test("settlement timeout after request is unknown and never retried", async () => {
    const fake = new FakeFacilitator({ settleError: new Error("settle timeout") });
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(runtime, payloadFrom(paymentRequired));
    expect(paid.status).toBe(502);
    expect(await paid.json()).toMatchObject({ error: "PAYMENT_OUTCOME_UNKNOWN" });
    expect(fake.settleCalls).toBe(1);
    expect(decodeP4ADiagnostics(paid.headers.get("x-omnis-p4a-diagnostics"))).toMatchObject({
      recoveryStage: "outcome_unknown",
      settlement: { success: false },
    });
  });

  test("relative resource URLs are rejected before signing", async () => {
    let calls = 0;
    const error = await payWalletActivityService({
      wallet: VALID_WALLET,
      serviceEndpoint: RESOURCE_URL,
      config,
      facilitatorClient: { getSupported: async () => supportedResponse() },
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
              paymentRequired("/api/services/wallet-activity"),
            ),
          },
        });
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(P4APayerError);
    expect((error as P4APayerError).message).toContain("absolute URL");
    expect(calls).toBe(1);
  });
  test("malformed resource URLs are rejected before signing", async () => {
    let calls = 0;
    const error = await payWalletActivityService({
      wallet: VALID_WALLET,
      serviceEndpoint: RESOURCE_URL,
      config,
      facilitatorClient: { getSupported: async () => supportedResponse() },
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired("not-a-url")),
          },
        });
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(P4APayerError);
    expect((error as P4APayerError).message).toContain("absolute URL");
    expect(calls).toBe(1);
  });

  test("development diagnostics omit secrets and signed transaction bytes", async () => {
    const diagnostics = {
      resourceHttpStatus: 502,
      paymentRequiredPresent: true,
      paymentResponsePresent: false,
      resource: { attempted: false, success: false },
      settlement: { attempted: false },
      verification: {
        httpStatus: 200,
        isValid: false,
        invalidReason: "invalid_exact_hedera_payload_signature_invalid",
        invalidMessage: "signature rejected",
      },
      recoveryStage: "verification_failed" as const,
    };
    const encoded = encodeP4ADiagnostics(diagnostics);
    const serialized = JSON.stringify(decodeP4ADiagnostics(encoded));
    expect(serialized).not.toContain(ECDSA_PRIVATE_KEY);
    expect(serialized).not.toContain("mock-partially-signed-transaction");
    expect(serialized).not.toContain("HEDERA_TESTNET_PAYER_PRIVATE_KEY");
  });

  test("Blocky402 adapter sends the canonical v2 facilitator envelope", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json(
        String(input).endsWith("/verify")
          ? { isValid: true, payer: PAYER_ACCOUNT }
          : {
              success: true,
              transaction: "0.0.7162784@1700000000.000000000",
              network: "hedera:testnet",
              payer: FEE_PAYER,
            },
      );
    }) as typeof fetch;
    try {
      const client = new Blocky402FacilitatorClient("https://blocky.example");
      const payload = payloadFrom(paymentRequired());
      const requirements = requirement();
      await client.verify(payload, requirements);
      await client.settle(payload, requirements);
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.body).toMatchObject({
        x402Version: 2,
        paymentPayload: payloadFrom(paymentRequired()),
        paymentRequirements: requirement(),
      });
    }
    expect(requests.map((request) => request.url)).toEqual([
      "https://blocky.example/verify",
      "https://blocky.example/settle",
    ]);
  });

  test("payer sends PAYMENT-SIGNATURE and never X-PAYMENT", async () => {
    let paidHeaders: Headers | undefined;
    let calls = 0;
    const settlement: SettleResponse = {
      success: true,
      transaction: "0.0.7162784@1700000000.000000000",
      network: "hedera:testnet",
      payer: FEE_PAYER,
    };
    const result = await payWalletActivityService({
      wallet: VALID_WALLET,
      serviceEndpoint: RESOURCE_URL,
      config,
      facilitatorClient: { getSupported: async () => supportedResponse() },
      fetchImpl: async (_input, init) => {
        calls += 1;
        if (calls === 2) paidHeaders = new Headers(init?.headers);
        return calls === 1
          ? new Response(null, {
              status: 402,
              headers: {
                "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()),
              },
            })
          : new Response(JSON.stringify(activitySnapshot()), {
              status: 200,
              headers: {
                "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
              },
            });
      },
    });
    expect(result.paymentIdentifier).toBe(settlement.transaction);
    expect(paidHeaders?.get("PAYMENT-SIGNATURE")).toBeTruthy();
    expect(paidHeaders?.get("X-PAYMENT")).toBeNull();
    expect(decodePaymentSignatureHeader(paidHeaders?.get("PAYMENT-SIGNATURE") ?? "").x402Version).toBe(2);
  });

  test("settlement success without transaction is deterministic failure", async () => {
    const fake = new FakeFacilitator({
      settle: {
        success: true,
        transaction: "",
        network: "hedera:testnet",
        payer: FEE_PAYER,
      },
    });
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(runtime, payloadFrom(paymentRequired));
    const body = await paid.text();
    expect(JSON.parse(body)).toMatchObject({ error: "PAYMENT_SETTLEMENT_FAILED" });
    expect(body).not.toContain("P4A_PAYMENT_OUTCOME_UNKNOWN");
  });
  test("non-boolean settlement success never releases the resource", async () => {
    const fake = new FakeFacilitator({
      settle: {
        success: "true" as never,
        transaction: "0.0.7162784@1700000000.000000000",
        network: "hedera:testnet",
        payer: FEE_PAYER,
      },
    });
    const runtime = await runtimeFor(fake);
    const { paymentRequired } = await challengeFor(runtime);
    const paid = await paidRequest(runtime, payloadFrom(paymentRequired));
    expect(paid.status).toBe(402);
    expect(await paid.json()).toMatchObject({
      error: "PAYMENT_SETTLEMENT_FAILED",
    });
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });
});
