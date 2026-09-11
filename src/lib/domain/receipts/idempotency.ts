import { raiseDomainError } from "../errors";

export function proofIdentityKey(
  taskId: string,
  settlementExecutionId: string,
): string {
  if (typeof taskId !== "string" || !taskId.trim()) {
    return raiseDomainError("INVALID_PROOF_IDENTITY", "proof task id is required");
  }
  if (
    typeof settlementExecutionId !== "string" ||
    !settlementExecutionId.trim()
  ) {
    return raiseDomainError(
      "INVALID_PROOF_IDENTITY",
      "proof settlement execution id is required",
    );
  }
  return `omnis-proof:v1:${encodeURIComponent(taskId.trim())}:${encodeURIComponent(settlementExecutionId.trim())}`;
}
