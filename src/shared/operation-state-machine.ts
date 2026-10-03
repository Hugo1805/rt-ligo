import type { OperationStatus } from "../generated/prisma/enums";

// Frozen at runtime: `readonly` only exists in the type system.
export const TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> =
  Object.freeze({
    PENDING: Object.freeze(["PROCESSING", "FAILED"] as const),
    PROCESSING: Object.freeze(["COMPLETED", "FAILED", "UNKNOWN"] as const),
    UNKNOWN: Object.freeze(["COMPLETED", "FAILED"] as const),
    COMPLETED: Object.freeze([] as const),
    FAILED: Object.freeze([] as const),
  });

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedSources(to: OperationStatus): OperationStatus[] {
  return (Object.keys(TRANSITIONS) as OperationStatus[]).filter((from) =>
    TRANSITIONS[from].includes(to)
  );
}

export function isTerminal(status: OperationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
