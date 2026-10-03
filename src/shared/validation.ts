import type { Hook } from "@hono/zod-validator";
import { AppError, type FieldError } from "./errors";

/**
 * Maps Zod issues to standardized FieldError objects.
 */
type ValidationIssue = {
  code?: string;
  path: readonly PropertyKey[];
  message: string;
  keys?: readonly string[];
};

const joinPath = (path: readonly PropertyKey[]): string => path.map(String).join(".");

export function issuesToFieldErrors(issues: readonly ValidationIssue[]): FieldError[] {
  return issues.flatMap((issue) => {
    // `.strict()` reports extra keys as one issue on the parent path, so the
    // offending field names would only appear inside the message.
    if (issue.code === "unrecognized_keys" && issue.keys) {
      return issue.keys.map((key) => ({
        field: joinPath([...issue.path, key]),
        message: "Campo no permitido",
      }));
    }
    return [{ field: joinPath(issue.path), message: issue.message }];
  });
}

/**
 * Hook for @hono/zod-validator that converts validation errors into AppError("VALIDATION_ERROR").
 */
export const validationHook: Hook<any, any, any> = (result) => {
  if (!result.success) {
    const errors = issuesToFieldErrors(result.error.issues);
    throw new AppError("VALIDATION_ERROR", {
      errors,
    });
  }
};
