import type { PaymentRequirements } from "@x402/core/types";
import {
  moneyFromUnits,
  moneyLessThanOrEqual,
  type Money,
} from "../../domain/money";
import {
  P4A_PROTOCOL,
  WALLET_ACTIVITY_MAX_TIMEOUT_SECONDS,
  type HederaX402RuntimeConfig,
} from "./config";
import type { Blocky402Support } from "./facilitator";
import { WALLET_ACTIVITY_PRICE } from "../wallet-activity-descriptor";

export const WALLET_ACTIVITY_MAX_AMOUNT = WALLET_ACTIVITY_PRICE.units;

export class P4APaymentSafetyError extends Error {
  readonly code = "P4A_PAYMENT_REQUIREMENT_REJECTED" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "P4APaymentSafetyError";
    this.field = field;
  }
}

function parseAtomicAmount(amount: unknown): bigint {
  if (typeof amount !== "string" || !/^(0|[1-9]\d*)$/.test(amount)) {
    throw new P4APaymentSafetyError(
      "amount",
      "x402 amount must be a non-negative integer string",
    );
  }
  try {
    return BigInt(amount);
  } catch {
    throw new P4APaymentSafetyError("amount", "x402 amount is not representable");
  }
}

function asUsdc(amount: bigint): Money {
  return moneyFromUnits(amount, "USDC", P4A_PROTOCOL.decimals);
}

export function expectedWalletActivityRequirements(
  config: Pick<HederaX402RuntimeConfig, "serviceAccountId">,
  support: Blocky402Support,
): PaymentRequirements {
  return Object.freeze({
    scheme: P4A_PROTOCOL.scheme,
    network: P4A_PROTOCOL.network,
    asset: P4A_PROTOCOL.asset,
    amount: WALLET_ACTIVITY_MAX_AMOUNT.toString(),
    payTo: config.serviceAccountId,
    maxTimeoutSeconds: WALLET_ACTIVITY_MAX_TIMEOUT_SECONDS,
    extra: Object.freeze({ feePayer: support.feePayer }),
  });
}

export function validateWalletActivityPaymentRequirement(
  requirement: PaymentRequirements,
  config: Pick<HederaX402RuntimeConfig, "serviceAccountId">,
  support: Blocky402Support,
): Money {
  if (requirement.scheme !== P4A_PROTOCOL.scheme) {
    throw new P4APaymentSafetyError(
      "scheme",
      "payer only accepts the exact x402 scheme",
    );
  }
  if (requirement.network !== P4A_PROTOCOL.network) {
    throw new P4APaymentSafetyError(
      "network",
      "payer rejected a payment requirement for the wrong network",
    );
  }
  if (requirement.asset !== P4A_PROTOCOL.asset) {
    throw new P4APaymentSafetyError(
      "asset",
      "payer rejected a payment requirement for the wrong asset",
    );
  }
  if (requirement.payTo !== config.serviceAccountId) {
    throw new P4APaymentSafetyError(
      "payTo",
      "payer rejected a payment requirement for the wrong service account",
    );
  }
  const feePayer = requirement.extra?.feePayer;
  if (feePayer !== support.feePayer) {
    throw new P4APaymentSafetyError(
      "extra.feePayer",
      "payer rejected a payment requirement with an unadvertised fee payer",
    );
  }
  if (requirement.maxTimeoutSeconds !== WALLET_ACTIVITY_MAX_TIMEOUT_SECONDS) {
    throw new P4APaymentSafetyError(
      "maxTimeoutSeconds",
      "payer rejected a payment requirement with an unexpected timeout",
    );
  }
  const units = parseAtomicAmount(requirement.amount);
  if (units !== WALLET_ACTIVITY_MAX_AMOUNT) {
    throw new P4APaymentSafetyError(
      "amount",
      "payer requires the exact wallet activity price",
    );
  }
  const amount = asUsdc(units);
  if (!moneyLessThanOrEqual(amount, WALLET_ACTIVITY_PRICE)) {
    throw new P4APaymentSafetyError(
      "amount",
      "payer rejected a payment amount above the wallet activity price",
    );
  }
  return amount;
}

export function validateWalletActivityPaymentRequired(
  paymentRequired: {
    x402Version: number;
    accepts: readonly PaymentRequirements[];
  },
  config: Pick<HederaX402RuntimeConfig, "serviceAccountId">,
  support: Blocky402Support,
): { requirement: PaymentRequirements; amount: Money } {
  if (paymentRequired.x402Version !== P4A_PROTOCOL.version) {
    throw new P4APaymentSafetyError(
      "x402Version",
      "payer only accepts x402 version 2",
    );
  }
  if (!Array.isArray(paymentRequired.accepts)) {
    throw new P4APaymentSafetyError(
      "accepts",
      "payer requires a list of x402 payment options",
    );
  }
  const matches: Array<{ requirement: PaymentRequirements; amount: Money }> = [];
  for (const requirement of paymentRequired.accepts) {
    try {
      const amount = validateWalletActivityPaymentRequirement(
        requirement,
        config,
        support,
      );
      matches.push({ requirement, amount });
    } catch {
      continue;
    }
  }
  if (matches.length !== 1) {
    throw new P4APaymentSafetyError(
      "accepts",
      "payer requires exactly one allowlisted wallet activity payment option",
    );
  }
  return matches[0];
}
