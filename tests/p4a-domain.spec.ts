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
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  P4A_PROTOCOL,
  P4AConfigError,
  inspectP4AEnvironment,
  readHederaX402RuntimeConfig,
} from "../src/lib/services/hedera-x402/config";
import {
  parseBlocky402Support,
  type Blocky402Support,
} from "../src/lib/services/hedera-x402/facilitator";
import {
  P4A_PREFLIGHT_ERROR_CODES,
  runP4APreflight,
} from "../src/lib/services/hedera-x402/preflight";
import { handleWalletActivityRequest } from "../src/lib/services/hedera-x402/http";
import {
  validateWalletActivityPaymentRequirement,
} from "../src/lib/services/hedera-x402/requirements";
import {
  createWalletActivityRuntime,
  verifyHederaTestnetUsdc,
  type HederaUsdcMetadata,
} from "../src/lib/services/hedera-x402/resource";
import {
  inspectWalletActivity,
  WalletActivitySourceError,
} from "../src/lib/services/hedera-x402/wallet-activity";
import { handleP4ADevRequest } from "../src/lib/services/hedera-x402/dev-route";
import {
  createLiveServiceRegistry,
} from "../src/lib/services/registry";
import {
  createServiceDescriptor,
  money,
  SERVICE_ENVIRONMENTS,
} from "../src/lib/domain";

const SERVICE_ACCOUNT = "0.0.1234";
const FEE_PAYER = "0.0.7162784";
const PAYER_ACCOUNT = "0.0.5678";
const VALID_WALLET = "0x0000000000000000000000000000000000000001";
const ECDSA_PRIVATE_KEY = `0x${"11".repeat(32)}`;

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

const P4A_ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "OMNIS_P4A_SPIKE_TOKEN",
  "HEDERA_TESTNET_PAYER_ACCOUNT_ID",
  "HEDERA_TESTNET_PAYER_PRIVATE_KEY",
  "HEDERA_X402_SERVICE_ACCOUNT_ID",
  "BLOCKY402_TESTNET_URL",
] as const;

async function withProcessEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  action: () => Promise<T>,
): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const previous = new Map(
    P4A_ENVIRONMENT_KEYS.map((key) => [key, env[key]]),
  );
  for (const key of P4A_ENVIRONMENT_KEYS) {
    const value = values[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const key of P4A_ENVIRONMENT_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

function supportedResponse(feePayer = FEE_PAYER): SupportedResponse {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
        extra: { feePayer },
      },
    ],
    extensions: [],
    signers: { "hedera:*": [feePayer] },
  };
}

class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  realNetworkSettlementCalls = 0;

  async getSupported(): Promise<SupportedResponse> {
    return supportedResponse();
  }
  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    return { isValid: true, payer: PAYER_ACCOUNT };
  }

  async settle(
    _payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    void _payload;
    this.settleCalls += 1;
    return {
      success: true,
      transaction: "0.0.7162784@1700000000.000000000",
      network: requirements.network,
      payer: FEE_PAYER,
    };
  }
}

function baseRequirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.429274",
    amount: "3000",
    payTo: SERVICE_ACCOUNT,
    maxTimeoutSeconds: 180,
    extra: { feePayer: FEE_PAYER },
    ...overrides,
  };
}

async function runtimeWithFake(facilitator = new FakeFacilitator()) {
  const runtime = await createWalletActivityRuntime({
    config,
    facilitatorClient: facilitator,
    support,
    token,
  });
  return { runtime, facilitator };
}

type PreflightFixture = Readonly<{
  payerAccountStatus?: number;
  receiverAccountStatus?: number;
  payerRelationship?: Readonly<Record<string, unknown>> | null;
  receiverRelationship?: Readonly<Record<string, unknown>> | null;
}>;

function readyRelationship(
  balance = "3000",
): Readonly<Record<string, unknown>> {
  return {
    token_id: token.asset,
    balance,
    freeze_status: "UNFROZEN",
    kyc_status: "GRANTED",
  };
}

function mirrorResponse(
  status: number,
  body: unknown,
): Response {
  return status === 200
    ? Response.json(body)
    : new Response(null, { status });
}

function preflightFetch(fixture: PreflightFixture = {}): typeof fetch {
  const payerRelationship =
    fixture.payerRelationship === undefined
      ? readyRelationship()
      : fixture.payerRelationship;
  const receiverRelationship =
    fixture.receiverRelationship === undefined
      ? readyRelationship()
      : fixture.receiverRelationship;

  return async (input) => {
    const url = String(input);
    if (url.includes(`/accounts/${PAYER_ACCOUNT}/tokens?`)) {
      return mirrorResponse(
        200,
        payerRelationship === null
          ? { tokens: [] }
          : { tokens: [payerRelationship] },
      );
    }
    if (url.includes(`/accounts/${SERVICE_ACCOUNT}/tokens?`)) {
      return mirrorResponse(
        200,
        receiverRelationship === null
          ? { tokens: [] }
          : { tokens: [receiverRelationship] },
      );
    }
    if (url.endsWith(`/accounts/${PAYER_ACCOUNT}`)) {
      const status = fixture.payerAccountStatus ?? 200;
      return mirrorResponse(status, {
        account: PAYER_ACCOUNT,
        deleted: false,
      });
    }
    if (url.endsWith(`/accounts/${SERVICE_ACCOUNT}`)) {
      const status = fixture.receiverAccountStatus ?? 200;
      return mirrorResponse(status, {
        account: SERVICE_ACCOUNT,
        deleted: false,
      });
    }
    throw new Error(`unexpected preflight URL: ${url}`);
  };
}

function runPreflightFixture(
  fixture: PreflightFixture = {},
  overrides: Readonly<{
    token?: HederaUsdcMetadata;
    support?: Blocky402Support;
  }> = {},
) {
  return runP4APreflight({
    config,
    token: overrides.token ?? token,
    support: overrides.support ?? support,
    fetchImpl: preflightFetch(fixture),
  });
}

const DRY_RUN_SECRET = "p4a-test-spike-secret";

function dryRunRequest(): Request {
  return new Request(
    "http://127.0.0.1:3000/api/dev/x402-wallet-activity",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-omnis-p4a-token": DRY_RUN_SECRET,
      },
      body: JSON.stringify({ action: "dry-run" }),
    },
  );
}

async function runInjectedDryRun(): Promise<{
  body: Record<string, unknown>;
  facilitator: FakeFacilitator;
  response: Response;
}> {
  const { runtime, facilitator } = await runtimeWithFake();
  const response = await withProcessEnv(
    {
      NODE_ENV: "development",
      OMNIS_P4A_SPIKE_TOKEN: DRY_RUN_SECRET,
      HEDERA_TESTNET_PAYER_ACCOUNT_ID: PAYER_ACCOUNT,
      HEDERA_TESTNET_PAYER_PRIVATE_KEY: ECDSA_PRIVATE_KEY,
      HEDERA_X402_SERVICE_ACCOUNT_ID: SERVICE_ACCOUNT,
      BLOCKY402_TESTNET_URL: config.blocky402Url,
    },
    () =>
      handleP4ADevRequest(dryRunRequest(), {
        createRuntime: async () => runtime,
        runPreflight: async (options) =>
          runP4APreflight({
            ...options,
            fetchImpl: preflightFetch(),
          }),
      }),
  );
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
    facilitator,
  };
}



test.describe("P4A Hedera x402 safety boundary", () => {
  test("Blocky402 supported response accepts Hedera testnet exact v2", () => {
    expect(parseBlocky402Support(supportedResponse())).toEqual(support);
  });

  test("missing Hedera support fails closed", () => {
    expect(() =>
      parseBlocky402Support({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:80002" }],
      }),
    ).toThrow(/does not advertise/);
  });

  test("feePayer is taken from current supported response", () => {
    const current = parseBlocky402Support(supportedResponse("0.0.9999"));
    expect(current.feePayer).toBe("0.0.9999");
    expect(current.feePayer).not.toBe(FEE_PAYER);
  });

  test("payer rejects wrong network, token, payTo, and excessive amount", () => {
    const cases: Array<[RegExp, PaymentRequirements]> = [
      [/wrong network/, baseRequirement({ network: "hedera:mainnet" as never })],
      [/wrong asset/, baseRequirement({ asset: "0.0.9999" })],
      [/wrong service account/, baseRequirement({ payTo: "0.0.9999" })],
      [/exact wallet activity price/, baseRequirement({ amount: "3001" })],
      [/exact wallet activity price/, baseRequirement({ amount: "2999" })],
      [
        /unexpected timeout/,
        baseRequirement({ maxTimeoutSeconds: 179 }),
      ],
    ];
    for (const [message, requirement] of cases) {
      expect(() =>
        validateWalletActivityPaymentRequirement(requirement, config, support),
      ).toThrow(message);
    }
  });

  test("USDC application price uses six-decimal smallest units", () => {
    expect(P4A_PROTOCOL.decimals).toBe(6);
    expect(baseRequirement().amount).toBe("3000");
  });
  test("Mirror Node token metadata is checked against the Hedera USDC allowlist", async () => {
    let requestedUrl = "";
    const metadata = await verifyHederaTestnetUsdc(async (input) => {
      requestedUrl = String(input);
      return Response.json({
        token_id: "0.0.429274",
        decimals: "6",
        symbol: "USDC",
      });
    });
    expect(requestedUrl).toContain("/api/v1/tokens/0.0.429274");
    expect(metadata).toEqual(token);
  });

  test("associated accounts with sufficient USDC are ready for one paid test", async () => {
    const result = await runPreflightFixture();
    expect(result).toMatchObject({
      network: "hedera:testnet",
      asset: { tokenId: "0.0.429274", symbol: "USDC", decimals: 6 },
      priceAtomic: "3000",
      payer: {
        accountId: PAYER_ACCOUNT,
        exists: true,
        associated: true,
        balanceAtomic: "3000",
        sufficientBalance: true,
        ready: true,
      },
      receiver: {
        accountId: SERVICE_ACCOUNT,
        exists: true,
        associated: true,
        ready: true,
      },
      facilitator: { supported: true, feePayer: FEE_PAYER },
      readyForOnePaidTest: true,
    });
    expect(result.error).toBeUndefined();
  });

  test("payer without USDC association fails the preflight", async () => {
    const result = await runPreflightFixture({ payerRelationship: null });
    expect(result).toMatchObject({
      error: P4A_PREFLIGHT_ERROR_CODES.payerNotAssociated,
      readyForOnePaidTest: false,
      payer: { exists: true, associated: false, ready: false },
    });
  });

  test("payer below the exact USDC price fails the preflight", async () => {
    const result = await runPreflightFixture({
      payerRelationship: readyRelationship("2999"),
    });
    expect(result).toMatchObject({
      error: P4A_PREFLIGHT_ERROR_CODES.payerInsufficient,
      readyForOnePaidTest: false,
      payer: {
        balanceAtomic: "2999",
        sufficientBalance: false,
        ready: false,
      },
    });
  });

  test("receiver association and HTS restrictions fail closed", async () => {
    const notAssociated = await runPreflightFixture({
      receiverRelationship: null,
    });
    expect(notAssociated).toMatchObject({
      error: P4A_PREFLIGHT_ERROR_CODES.serviceNotAssociated,
      readyForOnePaidTest: false,
      receiver: { exists: true, associated: false, ready: false },
    });

    const frozen = await runPreflightFixture({
      receiverRelationship: {
        ...readyRelationship(),
        freeze_status: "FROZEN",
      },
    });
    expect(frozen).toMatchObject({
      error: P4A_PREFLIGHT_ERROR_CODES.serviceNotReady,
      readyForOnePaidTest: false,
      receiver: {
        associated: true,
        freezeStatus: "FROZEN",
        ready: false,
      },
    });

    const revoked = await runPreflightFixture({
      receiverRelationship: {
        ...readyRelationship(),
        kyc_status: "REVOKED",
      },
    });
    expect(revoked).toMatchObject({
      error: P4A_PREFLIGHT_ERROR_CODES.serviceNotReady,
      readyForOnePaidTest: false,
      receiver: {
        associated: true,
        kycStatus: "REVOKED",
        ready: false,
      },
    });
  });

  test("missing payer or receiver account fails the preflight", async () => {
    const result = await runPreflightFixture({ payerAccountStatus: 404 });
    expect(result).toMatchObject({
      error: P4A_PREFLIGHT_ERROR_CODES.accountNotFound,
      readyForOnePaidTest: false,
      payer: { exists: false, ready: false },
    });
  });

  test("token metadata mismatch fails the preflight before account reads", async () => {
    const result = await runPreflightFixture(
      {},
      { token: { ...token, decimals: 18 } },
    );
    expect(result).toMatchObject({
      error: P4A_PREFLIGHT_ERROR_CODES.tokenMetadataInvalid,
      readyForOnePaidTest: false,
      facilitator: { supported: true, feePayer: FEE_PAYER },
    });
  });

  test("facilitator support mismatch fails the preflight before account reads", async () => {
    const result = await runPreflightFixture(
      {},
      {
        support: {
          ...support,
          network: "hedera:mainnet",
        } as unknown as Blocky402Support,
      },
    );
    expect(result).toMatchObject({
      error: P4A_PREFLIGHT_ERROR_CODES.facilitatorUnsupported,
      readyForOnePaidTest: false,
      facilitator: { supported: false, feePayer: null },
    });
  });

  test("dry-run never signs a payment", async () => {
    const { body, facilitator, response } = await runInjectedDryRun();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: "dry-run",
      signing: "not performed",
      readyForOnePaidTest: true,
    });
    expect(facilitator.verifyCalls).toBe(0);
  });

  test("dry-run never settles a payment", async () => {
    const { body, facilitator, response } = await runInjectedDryRun();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: "dry-run",
      settlement: "not performed",
      readyForOnePaidTest: true,
    });
    expect(facilitator.settleCalls).toBe(0);
  });

  test("dry-run response excludes private payment configuration", async () => {
    const { body } = await runInjectedDryRun();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ECDSA_PRIVATE_KEY);
    expect(serialized).not.toContain(DRY_RUN_SECRET);
    expect(serialized).not.toContain("HEDERA_TESTNET_PAYER_PRIVATE_KEY");
    expect(serialized).not.toContain("OMNIS_P4A_SPIKE_TOKEN");
  });


  test("wallet activity uses a public read-only Ethereum RPC and factual observations", async () => {
    let requestedUrl = "";
    const snapshot = await inspectWalletActivity(VALID_WALLET, {
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return Response.json([
          { jsonrpc: "2.0", id: 1, result: "0x" },
          { jsonrpc: "2.0", id: 2, result: "0x2" },
        ]);
      },
    });
    expect(requestedUrl).toBe("https://ethereum.publicnode.com");
    expect(snapshot.observations).toMatchObject({
      chain: "ethereum:mainnet",
      accountType: "eoa",
      transactionCount: "2",
      transactionActivityObserved: true,
    });
    expect(snapshot.disclaimer).toContain("No authoritative fraud score");
    expect(snapshot.observations).not.toHaveProperty("fraudScore");
    expect(snapshot.observations).not.toHaveProperty("riskScore");
    expect(snapshot.observations).not.toHaveProperty("activity");
  });
  test("wallet activity upstream timeout has a stable source error", async () => {
    const error = await inspectWalletActivity(VALID_WALLET, {
      fetchImpl: async () => {
        throw new Error("upstream timeout");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WalletActivitySourceError);
    expect((error as WalletActivitySourceError).code).toBe(
      "WALLET_ACTIVITY_SOURCE_UNAVAILABLE",
    );
    expect((error as WalletActivitySourceError).message).toBe(
      "Ethereum public RPC request timed out",
    );
  });

  test("malformed wallet activity upstream responses fail closed", async () => {
    const error = await inspectWalletActivity(VALID_WALLET, {
      fetchImpl: async () =>
        Response.json([
          { jsonrpc: "2.0", id: 1, result: "0x" },
          { jsonrpc: "1.0", id: 2, result: "0x0" },
        ]),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WalletActivitySourceError);
    expect((error as WalletActivitySourceError).code).toBe(
      "WALLET_ACTIVITY_SOURCE_UNAVAILABLE",
    );
    expect((error as WalletActivitySourceError).message).toContain(
      "invalid JSON-RPC response metadata",
    );
  });

  test("dev paid requests preserve resource failures instead of outcome-unknown", async () => {
    const endpoint = "http://127.0.0.1:3000/api/services/wallet-activity";
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: {
        url: endpoint,
        description: "wallet activity",
        mimeType: "application/json",
      },
      accepts: [baseRequirement()],
    };
    const originalFetch = globalThis.fetch;
    let serviceCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/supported")) {
        return Response.json(supportedResponse());
      }
      if (url === endpoint) {
        serviceCalls += 1;
        const headers = new Headers(init?.headers);
        if (!headers.has("PAYMENT-SIGNATURE")) {
          return new Response(null, {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
            },
          });
        }
        return Response.json(
          {
            error: "P4A_RESOURCE_EXECUTION_FAILED",
            message: "protected resource execution failed",
            settlementSent: false,
            paymentSettled: false,
            retryable: true,
          },
          { status: 502 },
        );
      }
      throw new Error(`unexpected P4A dev-route fetch: ${url}`);
    };
    try {
      const response = await withProcessEnv(
        {
          NODE_ENV: "development",
          OMNIS_P4A_SPIKE_TOKEN: DRY_RUN_SECRET,
          HEDERA_TESTNET_PAYER_ACCOUNT_ID: PAYER_ACCOUNT,
          HEDERA_TESTNET_PAYER_PRIVATE_KEY: ECDSA_PRIVATE_KEY,
          HEDERA_X402_SERVICE_ACCOUNT_ID: SERVICE_ACCOUNT,
          BLOCKY402_TESTNET_URL: config.blocky402Url,
        },
        () =>
          handleP4ADevRequest(
            new Request("http://127.0.0.1:3000/api/dev/x402-wallet-activity", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-omnis-p4a-token": DRY_RUN_SECRET,
              },
              body: JSON.stringify({
                action: "pay",
                confirm: "settle-one-testnet-payment",
                wallet: VALID_WALLET,
                requestId: "p4a-dev-resource-failure",
              }),
            }),
          ),
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: "P4A_RESOURCE_EXECUTION_FAILED",
        recovery: {
          stage: "resource_execution",
          retryable: true,
        },
        settlementSent: false,
        paymentSettled: false,
        retryable: true,
      });
      expect(serviceCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unpaid resource request returns a valid 402 without settlement", async () => {
    const { runtime, facilitator } = await runtimeWithFake();
    const response = await handleWalletActivityRequest(
      new Request("http://127.0.0.1:3000/api/services/wallet-activity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: VALID_WALLET }),
      }),
      {
        getRuntime: async () => runtime,
        inspect: async () => {
          throw new Error("unpaid requests must not invoke the data source");
        },
      },
    );
    expect(response.status).toBe(402);
    const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
    expect(paymentRequiredHeader).toBeTruthy();
    const body = paymentRequiredHeader
      ? decodePaymentRequiredHeader(paymentRequiredHeader)
      : await response.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.429274",
      amount: "3000",
      payTo: SERVICE_ACCOUNT,
      extra: { feePayer: FEE_PAYER },
    });
    expect(facilitator.settleCalls).toBe(0);
  });

  test("verified paid request returns service result through mocked facilitator", async () => {
    const facilitator = new FakeFacilitator();
    const { runtime } = await runtimeWithFake(facilitator);
    const unpaid = await handleWalletActivityRequest(
      new Request("http://127.0.0.1:3000/api/services/wallet-activity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: VALID_WALLET }),
      }),
      { getRuntime: async () => runtime },
    );
    const unpaidBody = await unpaid.json();
    const paymentRequiredHeader = unpaid.headers.get("PAYMENT-REQUIRED");
    const paymentRequired = paymentRequiredHeader
      ? decodePaymentRequiredHeader(paymentRequiredHeader)
      : unpaidBody;
    const payload = {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: paymentRequired.accepts[0],
      payload: { transaction: "mock-partially-signed-transaction" },
    };
    const paid = await handleWalletActivityRequest(
      new Request("http://127.0.0.1:3000/api/services/wallet-activity", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omnis-idempotency-key": "p4a-test-request-1",
          "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload),
        },
        body: JSON.stringify({ wallet: VALID_WALLET }),
      }),
      {
        getRuntime: async () => runtime,
        inspect: async () => ({
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
        }),
      },
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({
      requestId: "p4a-test-request-1",
      observations: { accountType: "eoa", transactionActivityObserved: true },
    });
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);
    expect(facilitator.realNetworkSettlementCalls).toBe(0);
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  });

  test("invalid empty config fails closed without exposing a private key", () => {
    let caught: unknown;
    try {
      readHederaX402RuntimeConfig({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(P4AConfigError);
    expect(JSON.stringify(caught)).not.toContain(ECDSA_PRIVATE_KEY);
  });

  test("testnet is a valid service environment", () => {
    expect(SERVICE_ENVIRONMENTS).toEqual([
      "development",
      "testnet",
      "production",
    ]);
    const descriptor = createServiceDescriptor({
      id: "testnet-service",
      name: "Testnet service",
      capability: "wallet-activity",
      category: "wallet-risk",
      description: "A bounded Hedera testnet service.",
      endpoint: "/api/services/testnet-service",
      price: money("0.003", "USDC", 6),
      network: "hedera:testnet",
      paymentProtocol: "x402",
      inputSchema: {},
      outputSchema: {},
      environment: "testnet",
      catalogOnly: false,
      payerPrivateKey: ECDSA_PRIVATE_KEY,
    } as Parameters<typeof createServiceDescriptor>[0] & {
      payerPrivateKey: string;
    });
    expect(descriptor.environment).toBe("testnet");
    expect(descriptor).not.toHaveProperty("payerPrivateKey");
    expect(descriptor.catalogOnly).toBe(false);
  });

  test("disabled development route reports an explicit error code", async () => {
    const response = await withProcessEnv(
      { NODE_ENV: "development" },
      () =>
        handleP4ADevRequest(
          new Request("http://127.0.0.1:3000/api/dev/x402-wallet-activity", {
            method: "POST",
            body: JSON.stringify({ action: "dry-run" }),
          }),
        ),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "P4A_SPIKE_DISABLED",
    });
  });

  test("invalid development config reports an explicit error code", async () => {
    const response = await withProcessEnv(
      {
        NODE_ENV: "development",
        OMNIS_P4A_SPIKE_TOKEN: "p4a-test-token",
      },
      () =>
        handleP4ADevRequest(
          new Request("http://127.0.0.1:3000/api/dev/x402-wallet-activity", {
            method: "POST",
            headers: { "x-omnis-p4a-token": "p4a-test-token" },
            body: JSON.stringify({ action: "dry-run" }),
          }),
        ),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "P4A_CONFIG_INVALID",
      configured: false,
    });
  });

  test("service route distinguishes invalid config with a JSON error code", async () => {
    const response = await handleWalletActivityRequest(
      new Request("http://127.0.0.1:3000/api/services/wallet-activity", {
        method: "POST",
        body: JSON.stringify({ wallet: VALID_WALLET }),
      }),
      {
        getRuntime: async () => {
          throw new P4AConfigError("missing P4A configuration");
        },
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "P4A_CONFIG_INVALID",
      moneyMoved: "no settlement was requested",
    });
  });

  test("live registry descriptor is unavailable when runtime config is absent", () => {
    const inspection = inspectP4AEnvironment({});
    const live = createLiveServiceRegistry(
      inspection.configured ? "available" : "unavailable",
    );
    const descriptor = live.getService("useomnis-wallet-activity-x402");
    expect(descriptor).toMatchObject({
      status: "unavailable",
      environment: "testnet",
      catalogOnly: false,
      network: "hedera:testnet",
      paymentProtocol: "x402",
    });
  });

  test("configured live descriptor stays local and truthful", () => {
    let fetchCalls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("remote health checks are not allowed in this test");
    }) as typeof fetch;
    try {
      const inspection = inspectP4AEnvironment({
        HEDERA_TESTNET_PAYER_ACCOUNT_ID: PAYER_ACCOUNT,
        HEDERA_TESTNET_PAYER_PRIVATE_KEY: ECDSA_PRIVATE_KEY,
        HEDERA_X402_SERVICE_ACCOUNT_ID: SERVICE_ACCOUNT,
        BLOCKY402_TESTNET_URL: "https://api.testnet.blocky402.com",
      });
      const live = createLiveServiceRegistry(
        inspection.configured ? "available" : "unavailable",
      );
      expect(live.getService("useomnis-wallet-activity-x402")).toMatchObject({
        status: "available",
        environment: "testnet",
        catalogOnly: false,
        network: "hedera:testnet",
        paymentProtocol: "x402",
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(fetchCalls).toBe(0);
  });

  test("server-only payment values do not appear in the client service page", async ({
    page,
  }) => {
    await page.goto("/app/services");
    const content = await page.content();
    expect(content).not.toContain(ECDSA_PRIVATE_KEY);
    expect(content).not.toContain("HEDERA_TESTNET_PAYER_PRIVATE_KEY");
    expect(content).not.toContain("OMNIS_P4A_SPIKE_TOKEN");
    const clientBundle = await page.evaluate(async () => {
      const scripts = Array.from(document.scripts)
        .map((script) => script.src)
        .filter(Boolean);
      const sources = await Promise.all(
        scripts.map(async (src) => (await fetch(src)).text()),
      );
      return sources.join("\n");
    });
    for (const forbidden of [
      "@x402/core/server",
      "@x402/hedera",
      "@hiero-ledger/sdk",
      "Blocky402FacilitatorClient",
      "createClientHederaSigner",
      "HEDERA_TESTNET_PAYER_PRIVATE_KEY",
      "HEDERA_X402_SERVICE_ACCOUNT_ID",
      "OMNIS_P4A_SPIKE_TOKEN",
      "BLOCKY402_TESTNET_URL",
    ]) {
      expect(clientBundle).not.toContain(forbidden);
    }
  });
});
