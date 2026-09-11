import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { isValidHederaEntityId } from "@x402/hedera";
import {
  BLOCKY402_DEFAULT_URL,
  P4A_PROTOCOL,
  type HederaX402RuntimeConfig,
} from "./config";
import {
  sanitizeP4ADiagnosticText,
  type P4ASettlementDiagnostics,
  type P4AVerificationDiagnostics,
} from "./diagnostics";

export type P4AFacilitatorTraceSnapshot = Readonly<{
  verificationSent: boolean;
  settlementSent: boolean;
  verification?: P4AVerificationDiagnostics;
  settlement?: P4ASettlementDiagnostics;
}>;

export type P4AFacilitatorTrace = Readonly<{
  snapshot(): P4AFacilitatorTraceSnapshot;
}>;

function errorField(error: unknown, field: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as Record<string, unknown>)[field];
}

function facilitatorStatus(error: unknown): number | undefined {
  const statusCode = errorField(error, "statusCode");
  if (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
  ) {
    return statusCode;
  }
  const message = error instanceof Error ? error.message : undefined;
  const match = message?.match(/Facilitator (?:verify|settle) failed \((\d{3})\)/);
  return match ? Number(match[1]) : undefined;
}

function errorReason(error: unknown): string | undefined {
  return sanitizeP4ADiagnosticText(
    errorField(error, "errorReason") ??
      errorField(error, "code") ??
      (error instanceof Error ? error.message : undefined),
  );
}

function errorMessage(error: unknown): string | undefined {
  return sanitizeP4ADiagnosticText(
    errorField(error, "errorMessage") ??
      (error instanceof Error ? error.message : undefined),
  );
}

export function createTracedFacilitator(
  facilitator: FacilitatorClient,
): Readonly<{
  facilitator: FacilitatorClient;
  trace: P4AFacilitatorTrace;
}> {
  let verificationSent = false;
  let settlementSent = false;
  let verification: P4AVerificationDiagnostics | undefined;
  let settlement: P4ASettlementDiagnostics | undefined;

  const traced: FacilitatorClient = {
    getSupported: () => facilitator.getSupported(),
    verify: async (paymentPayload, paymentRequirements) => {
      verificationSent = true;
      try {
        const result = await facilitator.verify(paymentPayload, paymentRequirements);
        verification = Object.freeze({
          httpStatus: 200,
          isValid: result.isValid,
          ...(result.invalidReason
            ? { invalidReason: result.invalidReason }
            : {}),
          ...(result.invalidMessage
            ? { invalidMessage: result.invalidMessage }
            : {}),
        });
        return result;
      } catch (error) {
        verification = Object.freeze({
          ...(facilitatorStatus(error) !== undefined
            ? { httpStatus: facilitatorStatus(error) }
            : {}),
          isValid: false,
          ...(errorReason(error) ? { invalidReason: errorReason(error) } : {}),
          ...(errorMessage(error) ? { invalidMessage: errorMessage(error) } : {}),
        });
        throw error;
      }
    },
    settle: async (paymentPayload, paymentRequirements) => {
      settlementSent = true;
      try {
        const result = await facilitator.settle(paymentPayload, paymentRequirements);
        settlement = Object.freeze({
          attempted: true,
          httpStatus: 200,
          success: result.success,
          ...(result.errorReason
            ? { errorReason: result.errorReason }
            : {}),
          ...(result.errorMessage
            ? { errorMessage: result.errorMessage }
            : {}),
          ...(result.transaction ? { transaction: result.transaction } : {}),
        });
        return result;
      } catch (error) {
        const transaction = errorField(error, "transaction");
        settlement = Object.freeze({
          attempted: true,
          ...(facilitatorStatus(error) !== undefined
            ? { httpStatus: facilitatorStatus(error) }
            : {}),
          success: false,
          ...(errorReason(error) ? { errorReason: errorReason(error) } : {}),
          ...(errorMessage(error) ? { errorMessage: errorMessage(error) } : {}),
          ...(typeof transaction === "string" ? { transaction } : {}),
        });
        throw error;
      }
    },
  };

  return {
    facilitator: traced,
    trace: {
      snapshot: () =>
        Object.freeze({
          verificationSent,
          settlementSent,
          ...(verification ? { verification } : {}),
          ...(settlement ? { settlement } : {}),
        }),
    },
  };
}


export type Blocky402Support = Readonly<{
  x402Version: 2;
  scheme: "exact";
  network: "hedera:testnet";
  feePayer: string;
}>;

export class Blocky402SupportError extends Error {
  readonly code = "BLOCKY402_HEDERA_SUPPORT_MISSING" as const;

  constructor(message: string) {
    super(message);
    this.name = "Blocky402SupportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBlocky402Support(response: unknown): Blocky402Support {
  if (!isRecord(response) || !Array.isArray(response.kinds)) {
    throw new Blocky402SupportError(
      "Blocky402 /supported returned no supported payment kinds",
    );
  }
  const kind = response.kinds.find((candidate) => {
    if (!isRecord(candidate)) return false;
    const extra = isRecord(candidate.extra) ? candidate.extra : undefined;
    return (
      candidate.x402Version === P4A_PROTOCOL.version &&
      candidate.scheme === P4A_PROTOCOL.scheme &&
      candidate.network === P4A_PROTOCOL.network &&
      typeof extra?.feePayer === "string"
    );
  });
  if (!isRecord(kind)) {
    throw new Blocky402SupportError(
      "Blocky402 does not advertise x402 v2 exact hedera:testnet support",
    );
  }
  const extra = kind.extra;
  const feePayer = isRecord(extra) ? extra.feePayer : undefined;
  if (typeof feePayer !== "string" || !isValidHederaEntityId(feePayer)) {
    throw new Blocky402SupportError(
      "Blocky402 advertised an invalid Hedera feePayer",
    );
  }
  return Object.freeze({
    x402Version: 2,
    scheme: "exact",
    network: "hedera:testnet",
    feePayer,
  });
}

export class Blocky402FacilitatorClient implements FacilitatorClient {
  private readonly http: HTTPFacilitatorClient;
  private supportedResponse?: SupportedResponse;
  private support?: Blocky402Support;
  private supportedPromise?: Promise<SupportedResponse>;

  constructor(url: string = BLOCKY402_DEFAULT_URL) {
    this.http = new HTTPFacilitatorClient({ url });
  }

  async getSupported(): Promise<SupportedResponse> {
    if (this.supportedResponse) return this.supportedResponse;
    if (!this.supportedPromise) {
      const pending = this.http.getSupported().then((response) => {
        this.support = parseBlocky402Support(response);
        this.supportedResponse = response;
        return response;
      });
      this.supportedPromise = pending.catch((error: unknown) => {
        this.supportedPromise = undefined;
        throw error;
      });
    }
    return this.supportedPromise;
  }

  getAdvertisedSupport(): Blocky402Support {
    if (!this.support) {
      throw new Blocky402SupportError(
        "Blocky402 support must be queried before payment requirements are used",
      );
    }
    return this.support;
  }

  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.http.verify(paymentPayload, paymentRequirements);
  }

  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.http.settle(paymentPayload, paymentRequirements);
  }
}

export async function fetchBlocky402Support(
  client: Pick<FacilitatorClient, "getSupported">,
): Promise<Blocky402Support> {
  return parseBlocky402Support(await client.getSupported());
}

export function createBlocky402Facilitator(
  config: Pick<HederaX402RuntimeConfig, "blocky402Url">,
): Blocky402FacilitatorClient {
  return new Blocky402FacilitatorClient(config.blocky402Url);
}
