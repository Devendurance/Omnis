import { raiseDomainError, requireDomainCondition } from "./errors";

export const USDC_DECIMALS = 6;
export const USD_DECIMALS = 6;
export const MAX_MONEY_DECIMALS = 38;

const DEFAULT_DECIMALS: Readonly<Record<string, number>> = {
  USDC: USDC_DECIMALS,
  USD: USD_DECIMALS,
};
const TEN = BigInt(10);
const ZERO = BigInt(0);

export type Money = Readonly<{
  asset: string;
  units: bigint;
  decimals: number;
}>;

export type SerializedMoney = Readonly<{
  amount: string;
  units: string;
  asset: string;
  decimals: number;
}>;

export function normalizeAsset(asset: string): string {
  if (typeof asset !== "string") {
    return raiseDomainError("INVALID_ASSET", "asset must be a string");
  }
  const normalized = asset.trim().toUpperCase();
  if (!normalized) raiseDomainError("INVALID_ASSET", "asset is required");
  return normalized;
}

function resolveDecimals(asset: string, decimals?: number): number {
  const resolved = decimals ?? DEFAULT_DECIMALS[asset];
  if (
    resolved === undefined ||
    !Number.isInteger(resolved) ||
    resolved < 0 ||
    resolved > MAX_MONEY_DECIMALS
  ) {
    raiseDomainError(
      "INVALID_DECIMAL_SCALE",
      `a decimal scale from 0 to ${MAX_MONEY_DECIMALS} is required for ${asset}`,
    );
  }
  return resolved;
}

function powerOfTen(decimals: number): bigint {
  return TEN ** BigInt(decimals);
}

function validateUnits(units: bigint): void {
  if (typeof units !== "bigint" || units < ZERO) {
    raiseDomainError(
      "INVALID_MONEY",
      "money units must be a non-negative bigint",
    );
  }
}

export function parseMoney(
  amount: string,
  asset: string,
  decimals?: number,
): Money {
  const normalizedAsset = normalizeAsset(asset);
  const scale = resolveDecimals(normalizedAsset, decimals);
  if (typeof amount !== "string") {
    return raiseDomainError("INVALID_MONEY", "money amount must be a string");
  }

  const value = amount.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    return raiseDomainError(
      "INVALID_MONEY",
      `invalid non-negative decimal amount: ${amount}`,
    );
  }

  const fraction = match[2] ?? "";
  if (fraction.length > scale) {
    return raiseDomainError(
      "INVALID_MONEY_PRECISION",
      `${normalizedAsset} supports at most ${scale} decimal places`,
    );
  }

  const wholeUnits = BigInt(match[1]) * powerOfTen(scale);
  const fractionalUnits = fraction
    ? BigInt(fraction.padEnd(scale, "0"))
    : ZERO;
  return Object.freeze({
    asset: normalizedAsset,
    units: wholeUnits + fractionalUnits,
    decimals: scale,
  });
}

export const money = parseMoney;

export function moneyFromUnits(
  units: bigint,
  asset: string,
  decimals?: number,
): Money {
  const normalizedAsset = normalizeAsset(asset);
  const scale = resolveDecimals(normalizedAsset, decimals);
  validateUnits(units);
  return Object.freeze({
    asset: normalizedAsset,
    units,
    decimals: scale,
  });
}

export function assertMoney(value: Money): void {
  if (!value || typeof value !== "object") {
    raiseDomainError("INVALID_MONEY", "money value is required");
  }
  const candidate = value as {
    asset?: unknown;
    units?: unknown;
    decimals?: unknown;
  };
  if (typeof candidate.asset !== "string") {
    raiseDomainError("INVALID_MONEY", "money asset is required");
  }
  normalizeAsset(candidate.asset);
  if (typeof candidate.units !== "bigint") {
    raiseDomainError("INVALID_MONEY", "money units must be a bigint");
  }
  validateUnits(candidate.units);
  if (
    typeof candidate.decimals !== "number" ||
    !Number.isInteger(candidate.decimals) ||
    candidate.decimals < 0 ||
    candidate.decimals > MAX_MONEY_DECIMALS
  ) {
    raiseDomainError("INVALID_DECIMAL_SCALE", "money decimal scale is invalid");
  }
}

function assertComparable(left: Money, right: Money): [Money, Money] {
  assertMoney(left);
  assertMoney(right);
  const leftAsset = normalizeAsset(left.asset);
  const rightAsset = normalizeAsset(right.asset);
  if (leftAsset !== rightAsset) {
    raiseDomainError(
      "MONEY_ASSET_MISMATCH",
      `cannot compare ${leftAsset} with ${rightAsset}`,
    );
  }
  return [left, right];
}

function scaledUnits(value: Money, scale: number): bigint {
  return value.units * powerOfTen(scale - value.decimals);
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  const [checkedLeft, checkedRight] = assertComparable(left, right);
  const scale = Math.max(checkedLeft.decimals, checkedRight.decimals);
  const leftUnits = scaledUnits(checkedLeft, scale);
  const rightUnits = scaledUnits(checkedRight, scale);
  if (leftUnits < rightUnits) return -1;
  if (leftUnits > rightUnits) return 1;
  return 0;
}

export function moneyEquals(left: Money, right: Money): boolean {
  return compareMoney(left, right) === 0;
}

export function moneyLessThan(left: Money, right: Money): boolean {
  return compareMoney(left, right) < 0;
}

export function moneyLessThanOrEqual(left: Money, right: Money): boolean {
  return compareMoney(left, right) <= 0;
}

export function moneyGreaterThan(left: Money, right: Money): boolean {
  return compareMoney(left, right) > 0;
}

export function moneyGreaterThanOrEqual(left: Money, right: Money): boolean {
  return compareMoney(left, right) >= 0;
}

export function moneyZero(asset: string, decimals?: number): Money {
  return moneyFromUnits(ZERO, asset, decimals);
}

export function addMoney(left: Money, right: Money): Money {
  const [checkedLeft, checkedRight] = assertComparable(left, right);
  const scale = Math.max(checkedLeft.decimals, checkedRight.decimals);
  return moneyFromUnits(
    scaledUnits(checkedLeft, scale) + scaledUnits(checkedRight, scale),
    checkedLeft.asset,
    scale,
  );
}

export function subtractMoney(left: Money, right: Money): Money {
  const [checkedLeft, checkedRight] = assertComparable(left, right);
  const scale = Math.max(checkedLeft.decimals, checkedRight.decimals);
  const result =
    scaledUnits(checkedLeft, scale) - scaledUnits(checkedRight, scale);
  if (result < ZERO) {
    raiseDomainError(
      "MONEY_NEGATIVE_RESULT",
      `cannot subtract ${formatMoney(right)} from ${formatMoney(left)}`,
    );
  }
  return moneyFromUnits(result, checkedLeft.asset, scale);
}

export function formatMoney(value: Money | SerializedMoney): string {
  if (value && typeof value === "object") {
    if ("amount" in value && typeof value.amount === "string") {
      return value.amount;
    }
    if ("units" in value && typeof value.units === "string") {
      const unitsStr = value.units.trim();
      if (/^(0|[1-9]\d*)$/.test(unitsStr)) {
        const units = BigInt(unitsStr);
        const decimals = value.decimals ?? DEFAULT_DECIMALS[value.asset] ?? 6;
        if (units === ZERO) return "0";
        const digits = units.toString().padStart(decimals + 1, "0");
        if (decimals === 0) return digits;
        const splitAt = digits.length - decimals;
        const whole = digits.slice(0, splitAt);
        const fraction = digits.slice(splitAt).replace(/0+$/, "");
        return fraction ? `${whole}.${fraction}` : whole;
      }
    }
  }
  assertMoney(value as Money);
  if ((value as Money).units === ZERO) return "0";
  const digits = (value as Money).units.toString().padStart((value as Money).decimals + 1, "0");
  if ((value as Money).decimals === 0) return digits;
  const splitAt = digits.length - (value as Money).decimals;
  const whole = digits.slice(0, splitAt);
  const fraction = digits.slice(splitAt).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function serializeMoney(value: Money | SerializedMoney): SerializedMoney {
  if (value && typeof value === "object") {
    const candidate = value as unknown as Record<string, unknown>;
    if (
      typeof candidate.units === "string" &&
      typeof candidate.amount === "string" &&
      typeof candidate.asset === "string" &&
      typeof candidate.decimals === "number"
    ) {
      return value as SerializedMoney;
    }
  }
  assertMoney(value as Money);
  return Object.freeze({
    amount: formatMoney(value as Money),
    units: (value as Money).units.toString(),
    asset: normalizeAsset(value.asset),
    decimals: value.decimals,
  });
}

export function hydrateMoney(value: unknown, field = "money"): Money {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return raiseDomainError("INVALID_MONEY", `${field} must be a money object`);
  }
  const candidate = value as Record<string, unknown>;
  const asset = normalizeAsset(
    typeof candidate.asset === "string" ? candidate.asset : "",
  );
  const decimals = resolveDecimals(
    asset,
    typeof candidate.decimals === "number" ? candidate.decimals : undefined,
  );

  if (typeof candidate.units === "bigint") {
    validateUnits(candidate.units);
    return moneyFromUnits(candidate.units, asset, decimals);
  }

  if (candidate.units !== undefined) {
    if (typeof candidate.units !== "string") {
      return raiseDomainError(
        "INVALID_MONEY",
        `${field}.units must be a string`,
      );
    }
    const unitsStr = candidate.units.trim();
    if (!/^(0|[1-9]\d*)$/.test(unitsStr)) {
      return raiseDomainError(
        "INVALID_MONEY",
        `${field}.units must be a non-negative decimal integer string: got "${candidate.units}"`,
      );
    }
    const units = BigInt(unitsStr);
    return moneyFromUnits(units, asset, decimals);
  }

  if (candidate.amount !== undefined) {
    if (typeof candidate.amount !== "string") {
      return raiseDomainError(
        "INVALID_MONEY",
        `${field}.amount must be a string`,
      );
    }
    return parseMoney(candidate.amount, asset, decimals);
  }

  return raiseDomainError(
    "INVALID_MONEY",
    `${field} must have units or amount defined`,
  );
}

export function isZeroMoney(value: Money): boolean {
  assertMoney(value);
  return value.units === ZERO;
}

export function requireSameAsset(left: Money, right: Money): void {
  assertComparable(left, right);
}

export function requireNonEmptyMoney(value: Money, field: string): void {
  assertMoney(value);
  requireDomainCondition(
    value.units >= ZERO,
    "INVALID_MONEY",
    `${field} must be non-negative`,
  );
}
