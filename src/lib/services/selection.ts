import type { ServiceSpendEvaluation } from "../domain/services/budget";
import {
  discoverServices,
  type DiscoverServicesInput,
  type ServiceDiscoveryCandidate,
  type ServiceDiscoveryResult,
} from "./discovery";

export type ServiceSelectionResult = Readonly<{
  selected?: ServiceDiscoveryCandidate;
  alternates: readonly ServiceDiscoveryCandidate[];
  selectionReason: string;
  policyEvaluation?: ServiceSpendEvaluation;
  discovery: ServiceDiscoveryResult;
}>;

export function selectServiceCandidate(
  input: DiscoverServicesInput,
): ServiceSelectionResult {
  const discovery = discoverServices(input);
  const selected = discovery.selectableCandidates[0];
  if (!selected) {
    return Object.freeze({
      alternates: Object.freeze([]),
      selectionReason:
        "no available service satisfies the required capability and task policy",
      discovery,
    });
  }
  const alternates = Object.freeze(
    discovery.selectableCandidates.slice(1),
  );
  return Object.freeze({
    selected,
    alternates,
    selectionReason:
      selected.capabilityMatch === "required"
        ? "supports the required capability and is the lowest-cost valid option"
        : "supports an accepted secondary capability and is the lowest-cost valid option",
    ...(selected.budgetEvaluation
      ? { policyEvaluation: selected.budgetEvaluation }
      : {}),
    discovery,
  });
}

export const selectService = selectServiceCandidate;
