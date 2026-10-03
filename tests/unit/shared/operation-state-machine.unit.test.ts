import { describe, expect, test } from "bun:test";
import type { OperationStatus } from "../../../src/generated/prisma/enums";
import {
  TRANSITIONS,
  allowedSources,
  canTransition,
  isTerminal,
} from "../../../src/shared/operation-state-machine";

const ALL_STATUSES: readonly OperationStatus[] = [
  "PENDING",
  "PROCESSING",
  "UNKNOWN",
  "COMPLETED",
  "FAILED",
] as const;

const VALID_TRANSITIONS: readonly (readonly [OperationStatus, OperationStatus])[] = [
  ["PENDING", "PROCESSING"],
  ["PENDING", "FAILED"],
  ["PROCESSING", "COMPLETED"],
  ["PROCESSING", "FAILED"],
  ["PROCESSING", "UNKNOWN"],
  ["UNKNOWN", "COMPLETED"],
  ["UNKNOWN", "FAILED"],
] as const;

describe("operation-state-machine", () => {
  describe("canTransition", () => {
    test("returns true for exactly the 7 valid transitions defined in R7.2", () => {
      expect(VALID_TRANSITIONS).toHaveLength(7);
      for (const [from, to] of VALID_TRANSITIONS) {
        expect(canTransition(from, to)).toBe(true);
      }
    });

    test("returns false for all 18 invalid combinations of the 25 possible", () => {
      const validSet = new Set(
        VALID_TRANSITIONS.map(([from, to]) => `${from}->${to}`)
      );

      let invalidCount = 0;
      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          const key = `${from}->${to}`;
          if (!validSet.has(key)) {
            invalidCount++;
            expect(canTransition(from, to)).toBe(false);
          }
        }
      }

      expect(invalidCount).toBe(18);
    });

    test("verifies all 25 combinations systematically against R7.2", () => {
      const validSet = new Set(
        VALID_TRANSITIONS.map(([from, to]) => `${from}->${to}`)
      );

      let totalCount = 0;
      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          totalCount++;
          const expected = validSet.has(`${from}->${to}`);
          expect(canTransition(from, to)).toBe(expected);
        }
      }

      expect(totalCount).toBe(25);
    });

    test("disallows self-transitions for every status", () => {
      for (const status of ALL_STATUSES) {
        expect(canTransition(status, status)).toBe(false);
      }
    });

    test("disallows dangerous transitions like PENDING->COMPLETED or PENDING->UNKNOWN", () => {
      expect(canTransition("PENDING", "COMPLETED")).toBe(false);
      expect(canTransition("PENDING", "UNKNOWN")).toBe(false);
    });

    test("disallows any transition originating from COMPLETED or FAILED", () => {
      for (const to of ALL_STATUSES) {
        expect(canTransition("COMPLETED", to)).toBe(false);
        expect(canTransition("FAILED", to)).toBe(false);
      }
    });
  });

  describe("TRANSITIONS table", () => {
    test("COMPLETED and FAILED have no outbound transitions", () => {
      expect(TRANSITIONS.COMPLETED).toHaveLength(0);
      expect(TRANSITIONS.FAILED).toHaveLength(0);
      expect(TRANSITIONS.COMPLETED).toEqual([]);
      expect(TRANSITIONS.FAILED).toEqual([]);
    });

    test("outbound transitions count matches R7.2 exactly", () => {
      const totalTransitions = Object.values(TRANSITIONS).reduce(
        (sum, list) => sum + list.length,
        0
      );
      expect(totalTransitions).toBe(7);
    });
  });

  test("TRANSITIONS cannot be mutated at runtime", () => {
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    for (const status of ALL_STATUSES) {
      expect(Object.isFrozen(TRANSITIONS[status])).toBe(true);
    }
  });

  describe("isTerminal", () => {
    test("returns true only for COMPLETED and FAILED", () => {
      expect(isTerminal("COMPLETED")).toBe(true);
      expect(isTerminal("FAILED")).toBe(true);
    });

    test("returns false for non-terminal statuses", () => {
      expect(isTerminal("PENDING")).toBe(false);
      expect(isTerminal("PROCESSING")).toBe(false);
      expect(isTerminal("UNKNOWN")).toBe(false);
    });
  });

  describe("allowedSources", () => {
    test("allowedSources('COMPLETED') returns ['PROCESSING', 'UNKNOWN']", () => {
      expect(allowedSources("COMPLETED")).toEqual(["PROCESSING", "UNKNOWN"]);
    });

    test("allowedSources('FAILED') returns ['PENDING', 'PROCESSING', 'UNKNOWN']", () => {
      expect(allowedSources("FAILED")).toEqual([
        "PENDING",
        "PROCESSING",
        "UNKNOWN",
      ]);
    });

    test("allowedSources('PENDING') returns []", () => {
      expect(allowedSources("PENDING")).toEqual([]);
    });

    test("allowedSources('PROCESSING') returns ['PENDING']", () => {
      expect(allowedSources("PROCESSING")).toEqual(["PENDING"]);
    });

    test("allowedSources('UNKNOWN') returns ['PROCESSING']", () => {
      expect(allowedSources("UNKNOWN")).toEqual(["PROCESSING"]);
    });

    test("is strictly derived from TRANSITIONS and matches canTransition for all pairs", () => {
      for (const to of ALL_STATUSES) {
        const sources = allowedSources(to);
        for (const from of ALL_STATUSES) {
          const isAllowed = sources.includes(from);
          expect(isAllowed).toBe(canTransition(from, to));
        }
      }
    });

    test("returns a new array on each call so mutations do not affect subsequent calls", () => {
      const sources1 = allowedSources("COMPLETED");
      expect(sources1).toEqual(["PROCESSING", "UNKNOWN"]);

      // Mutate the returned array
      sources1.push("PENDING");
      sources1.reverse();

      const sources2 = allowedSources("COMPLETED");
      expect(sources2).toEqual(["PROCESSING", "UNKNOWN"]);
      expect(sources2).not.toBe(sources1);

      const pendingSources = allowedSources("PENDING");
      pendingSources.push("COMPLETED");
      expect(allowedSources("PENDING")).toEqual([]);
    });
  });
});
