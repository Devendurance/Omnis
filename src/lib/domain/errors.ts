export class DomainError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function raiseDomainError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new DomainError(code, message, details);
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function requireDomainCondition(
  condition: unknown,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) raiseDomainError(code, message, details);
}
