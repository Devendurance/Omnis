export const P4A_DIAGNOSTICS_HEADER = "x-omnis-p4a-diagnostics" as const;

export type P4AHandshakeStage =
  | "challenge_received"
  | "payment_signed"
  | "verification_sent"
  | "verification_confirmed"
  | "verification_failed"
  | "resource_execution"
  | "settlement_sent"
  | "settlement_confirmed"
  | "settlement_failed"
  | "resource_released"
  | "outcome_unknown";

export type P4AVerificationDiagnostics = Readonly<{
  httpStatus?: number;
  isValid?: boolean;
  invalidReason?: string;
  invalidMessage?: string;
}>;

export type P4AResourceDiagnostics = Readonly<{
  attempted: boolean;
  success: boolean;
  status?: number;
  errorCode?: string;
  upstreamStatus?: number;
}>;

export type P4ASettlementDiagnostics = Readonly<{
  attempted: boolean;
  httpStatus?: number;
  success?: boolean;
  errorReason?: string;
  errorMessage?: string;
  transaction?: string;
}>;

export type P4AHandshakeDiagnostics = Readonly<{
  resourceHttpStatus?: number;
  paymentRequiredPresent: boolean;
  paymentResponsePresent: boolean;
  resource: P4AResourceDiagnostics;
  settlement: P4ASettlementDiagnostics;
  verification?: P4AVerificationDiagnostics;
  recoveryStage: P4AHandshakeStage;
}>;

const MAX_DIAGNOSTIC_TEXT_LENGTH = 256;
const MAX_DIAGNOSTIC_TRANSACTION_LENGTH = 256;
const BASE64_LIKE_TEXT = /^[A-Za-z0-9+/=_-]{80,}$/;
const ECDSA_PRIVATE_KEY = /0x[a-f0-9]{64}/i;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function status(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

export function sanitizeP4ADiagnosticText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (
    !text ||
    text.length > MAX_DIAGNOSTIC_TEXT_LENGTH ||
    BASE64_LIKE_TEXT.test(text) ||
    ECDSA_PRIVATE_KEY.test(text) ||
    PEM_PRIVATE_KEY.test(text)
  ) {
    return undefined;
  }
  return text;
}

function diagnosticTransaction(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_DIAGNOSTIC_TRANSACTION_LENGTH ||
    BASE64_LIKE_TEXT.test(value) ||
    /^0x[a-f0-9]{64,}$/i.test(value)
  ) {
    return undefined;
  }
  return value;
}

function sanitizeVerification(value: unknown): P4AVerificationDiagnostics | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const invalidReason = sanitizeP4ADiagnosticText(candidate.invalidReason);
  const invalidMessage = sanitizeP4ADiagnosticText(candidate.invalidMessage);
  const httpStatus = status(candidate.httpStatus);
  const sanitized: P4AVerificationDiagnostics = {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(typeof candidate.isValid === "boolean" ? { isValid: candidate.isValid } : {}),
    ...(invalidReason ? { invalidReason } : {}),
    ...(invalidMessage ? { invalidMessage } : {}),
  };
  return Object.keys(sanitized).length > 0 ? Object.freeze(sanitized) : undefined;
}

function sanitizeResource(value: unknown): P4AResourceDiagnostics | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.attempted !== "boolean" ||
    typeof candidate.success !== "boolean"
  ) {
    return undefined;
  }
  const errorCode = sanitizeP4ADiagnosticText(candidate.errorCode);
  const statusCode = status(candidate.status);
  const upstreamStatus = status(candidate.upstreamStatus);
  return Object.freeze({
    attempted: candidate.attempted,
    success: candidate.success,
    ...(statusCode !== undefined ? { status: statusCode } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
  });
}

function sanitizeSettlement(value: unknown): P4ASettlementDiagnostics | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const attempted =
    candidate.attempted === true ||
    typeof candidate.success === "boolean" ||
    typeof candidate.errorReason === "string" ||
    typeof candidate.errorMessage === "string" ||
    typeof candidate.transaction === "string";
  const errorReason = sanitizeP4ADiagnosticText(candidate.errorReason);
  const errorMessage = sanitizeP4ADiagnosticText(candidate.errorMessage);
  const transaction = diagnosticTransaction(candidate.transaction);
  const httpStatus = status(candidate.httpStatus);
  const sanitized: P4ASettlementDiagnostics = {
    attempted,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(typeof candidate.success === "boolean" ? { success: candidate.success } : {}),
    ...(errorReason ? { errorReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(transaction ? { transaction } : {}),
  };
  return Object.freeze(sanitized);
}
export function sanitizeP4ADiagnostics(value: unknown): P4AHandshakeDiagnostics | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const recoveryStage = candidate.recoveryStage;
  if (
    recoveryStage !== "challenge_received" &&
    recoveryStage !== "payment_signed" &&
    recoveryStage !== "verification_sent" &&
    recoveryStage !== "verification_confirmed" &&
    recoveryStage !== "verification_failed" &&
    recoveryStage !== "resource_execution" &&
    recoveryStage !== "settlement_sent" &&
    recoveryStage !== "settlement_confirmed" &&
    recoveryStage !== "settlement_failed" &&
    recoveryStage !== "resource_released" &&
    recoveryStage !== "outcome_unknown"
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(status(candidate.resourceHttpStatus) !== undefined
      ? { resourceHttpStatus: status(candidate.resourceHttpStatus) }
      : {}),
    paymentRequiredPresent: candidate.paymentRequiredPresent === true,
    paymentResponsePresent: candidate.paymentResponsePresent === true,
    resource:
      sanitizeResource(candidate.resource) ??
      Object.freeze({ attempted: false, success: false }),
    settlement:
      sanitizeSettlement(candidate.settlement) ??
      Object.freeze({ attempted: false }),
    ...(sanitizeVerification(candidate.verification)
      ? { verification: sanitizeVerification(candidate.verification) }
      : {}),
    recoveryStage,
  });
}

export function encodeP4ADiagnostics(value: P4AHandshakeDiagnostics): string {
  const sanitized = sanitizeP4ADiagnostics(value);
  if (!sanitized) throw new Error("invalid P4A diagnostics");
  return Buffer.from(JSON.stringify(sanitized), "utf8").toString("base64");
}

export function decodeP4ADiagnostics(
  value: string | null | undefined,
): P4AHandshakeDiagnostics | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return sanitizeP4ADiagnostics(JSON.parse(decoded));
  } catch {
    return undefined;
  }
}
