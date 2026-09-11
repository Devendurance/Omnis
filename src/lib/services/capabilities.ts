import type { FinancialTask } from "../domain";

export const SUPPORTED_SERVICE_CAPABILITIES = [
  "wallet-risk",
  "wallet-activity",
  "research",
] as const;
export type SupportedServiceCapability =
  (typeof SUPPORTED_SERVICE_CAPABILITIES)[number];

export type TaskCapabilityResolution = Readonly<{
  requiredCapability?: SupportedServiceCapability;
  secondaryCapabilities: readonly SupportedServiceCapability[];
}>;

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase();
}

export function isSupportedServiceCapability(
  value: string,
): value is SupportedServiceCapability {
  return SUPPORTED_SERVICE_CAPABILITIES.includes(
    normalizeCapability(value) as SupportedServiceCapability,
  );
}

export function validateServiceCapability(
  value: string,
): SupportedServiceCapability | undefined {
  const normalized = normalizeCapability(value);
  return isSupportedServiceCapability(normalized) ? normalized : undefined;
}

export function resolveTaskCapabilities(
  task: Pick<FinancialTask, "type">,
): TaskCapabilityResolution {
  if (task.type === "pay_with_check") {
    return Object.freeze({
      requiredCapability: "wallet-activity",
      secondaryCapabilities: Object.freeze(
        ["wallet-risk"] as const,
      ),
    });
  }
  if (task.type === "delegate") {
    return Object.freeze({
      requiredCapability: "research",
      secondaryCapabilities: Object.freeze([] as const),
    });
  }
  return Object.freeze({
    secondaryCapabilities: Object.freeze(
      [] as const,
    ),
  });
}

export function resolveRequiredCapability(
  task: Pick<FinancialTask, "type">,
): SupportedServiceCapability | undefined {
  return resolveTaskCapabilities(task).requiredCapability;
}

export function acceptedCapabilitiesFor(
  requiredCapability: SupportedServiceCapability,
): readonly SupportedServiceCapability[] {
  if (
    requiredCapability === "wallet-risk" ||
    requiredCapability === "wallet-activity"
  ) {
    return Object.freeze(["wallet-activity", "wallet-risk"]);
  }
  return Object.freeze([requiredCapability]);
}

export type CapabilityMatch = "required" | "secondary" | "none";

export function matchServiceCapability(
  requiredCapability: string,
  offeredCapability: string,
): CapabilityMatch {
  const required = validateServiceCapability(requiredCapability);
  const offered = validateServiceCapability(offeredCapability);
  if (!required || !offered) return "none";
  if (offered === required) return "required";
  return acceptedCapabilitiesFor(required).includes(offered)
    ? "secondary"
    : "none";
}
