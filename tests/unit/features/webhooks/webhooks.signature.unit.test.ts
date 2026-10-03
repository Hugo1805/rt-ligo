import { describe, expect, test } from "bun:test";
import {
  parseSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../../../../src/features/webhooks/webhooks.signature";

describe("webhooks.signature", () => {
  const secret = "whsec_test_secret_1234567890";
  const fixedTimestamp = 1727890000;
  const fixedNowMs = 1727890000 * 1000;
  const rawBody = '{"event_id":"evt_01J","type":"charge.succeeded","amount":100.00}';
  const expectedFixedV1 = "a977f463406a7ce9a3cd1f18d3f193adf8cfc6a29ebda51e2f81fc349f70f8fd";
  const expectedFixedHeader = `t=${fixedTimestamp},v1=${expectedFixedV1}`;

  describe("signWebhookPayload", () => {
    test("generates expected header format t=<unix>,v1=<hex> matching literal test vector", () => {
      const header = signWebhookPayload({
        secret,
        timestamp: fixedTimestamp,
        rawBody,
      });

      expect(header).toBe(expectedFixedHeader);
    });

    test("generates lowercase 64-character hex digest", () => {
      const header = signWebhookPayload({
        secret,
        timestamp: fixedTimestamp,
        rawBody: "simple payload",
      });

      const parsed = parseSignatureHeader(header);
      expect(parsed).not.toBeNull();
      expect(parsed?.v1).toMatch(/^[0-9a-f]{64}$/);
    });

    test("handles UTF-8 multi-byte characters correctly", () => {
      const utf8Body = '{"note":"pago de café ñandú ñoño 🇵🇪"}';
      const header = signWebhookPayload({
        secret,
        timestamp: fixedTimestamp,
        rawBody: utf8Body,
      });

      const verified = verifyWebhookSignature({
        header,
        rawBody: utf8Body,
        secret,
        toleranceS: 300,
        now: () => fixedNowMs,
      });

      expect(verified).toBe(true);
    });
  });

  describe("parseSignatureHeader", () => {
    test("parses standard header with t and v1", () => {
      const parsed = parseSignatureHeader(expectedFixedHeader);

      expect(parsed).toEqual({
        t: fixedTimestamp,
        v1: expectedFixedV1,
      });
    });

    test("parses header when v1 comes before t", () => {
      const parsed = parseSignatureHeader(`v1=${expectedFixedV1},t=${fixedTimestamp}`);

      expect(parsed).toEqual({
        t: fixedTimestamp,
        v1: expectedFixedV1,
      });
    });

    test("parses header with whitespace around parts", () => {
      const parsed = parseSignatureHeader(`t=${fixedTimestamp}, v1=${expectedFixedV1}`);

      expect(parsed).toEqual({
        t: fixedTimestamp,
        v1: expectedFixedV1,
      });
    });

    test("returns null for undefined, null, empty string, or whitespace-only", () => {
      expect(parseSignatureHeader(undefined)).toBeNull();
      expect(parseSignatureHeader(null)).toBeNull();
      expect(parseSignatureHeader("")).toBeNull();
      expect(parseSignatureHeader("   ")).toBeNull();
    });

    test("returns null when t is missing", () => {
      expect(parseSignatureHeader(`v1=${expectedFixedV1}`)).toBeNull();
    });

    test("returns null when v1 is missing", () => {
      expect(parseSignatureHeader(`t=${fixedTimestamp}`)).toBeNull();
    });

    test("returns null when t is non-numeric, float, negative, or zero", () => {
      expect(parseSignatureHeader(`t=abc,v1=${expectedFixedV1}`)).toBeNull();
      expect(parseSignatureHeader(`t=1727890000.5,v1=${expectedFixedV1}`)).toBeNull();
      expect(parseSignatureHeader(`t=-1727890000,v1=${expectedFixedV1}`)).toBeNull();
      expect(parseSignatureHeader(`t=0,v1=${expectedFixedV1}`)).toBeNull();
      expect(parseSignatureHeader(`t=01727890000,v1=${expectedFixedV1}`)).toBeNull();
    });

    test("returns null when v1 has invalid length, uppercase characters, or non-hex characters", () => {
      // 63 characters (short)
      expect(parseSignatureHeader(`t=${fixedTimestamp},v1=${expectedFixedV1.slice(0, 63)}`)).toBeNull();
      // 65 characters (long)
      expect(parseSignatureHeader(`t=${fixedTimestamp},v1=${expectedFixedV1}a`)).toBeNull();
      // Uppercase hex
      expect(parseSignatureHeader(`t=${fixedTimestamp},v1=${expectedFixedV1.toUpperCase()}`)).toBeNull();
      // Non-hex
      const nonHex = "g".repeat(64);
      expect(parseSignatureHeader(`t=${fixedTimestamp},v1=${nonHex}`)).toBeNull();
    });

    test("returns null when duplicate keys are present", () => {
      expect(parseSignatureHeader(`t=${fixedTimestamp},t=${fixedTimestamp + 1},v1=${expectedFixedV1}`)).toBeNull();
      expect(parseSignatureHeader(`t=${fixedTimestamp},v1=${expectedFixedV1},v1=${expectedFixedV1}`)).toBeNull();
    });

    test("returns null when unexpected/unknown keys are present", () => {
      expect(parseSignatureHeader(`t=${fixedTimestamp},v1=${expectedFixedV1},v2=abc`)).toBeNull();
      expect(parseSignatureHeader(`t=${fixedTimestamp},v1=${expectedFixedV1},extra=123`)).toBeNull();
    });

    test("returns null for malformed structures without equals or with empty parts", () => {
      expect(parseSignatureHeader("malformed")).toBeNull();
      expect(parseSignatureHeader("t,v1")).toBeNull();
      expect(parseSignatureHeader(`t=${fixedTimestamp},v1=${expectedFixedV1},`)).toBeNull();
      expect(parseSignatureHeader(`,t=${fixedTimestamp},v1=${expectedFixedV1}`)).toBeNull();
      expect(parseSignatureHeader(`=123,v1=${expectedFixedV1}`)).toBeNull();
      expect(parseSignatureHeader(`t=,v1=${expectedFixedV1}`)).toBeNull();
    });

    test("never throws on unexpected non-string argument types", () => {
      expect(() => parseSignatureHeader(123 as unknown as string)).not.toThrow();
      expect(parseSignatureHeader(123 as unknown as string)).toBeNull();
      expect(() => parseSignatureHeader({} as unknown as string)).not.toThrow();
      expect(parseSignatureHeader({} as unknown as string)).toBeNull();
    });
  });

  describe("verifyWebhookSignature", () => {
    test("verifies valid signature with same body and secret using fixed literal vector", () => {
      const isValid = verifyWebhookSignature({
        header: expectedFixedHeader,
        rawBody,
        secret,
        toleranceS: 300,
        now: () => fixedNowMs,
      });

      expect(isValid).toBe(true);
    });

    test("verifies true for freshly signed payload", () => {
      const header = signWebhookPayload({
        secret,
        timestamp: fixedTimestamp,
        rawBody,
      });

      const isValid = verifyWebhookSignature({
        header,
        rawBody,
        secret,
        toleranceS: 300,
        now: () => fixedNowMs,
      });

      expect(isValid).toBe(true);
    });

    test("returns false when rawBody differs by even one character (e.g. extra space)", () => {
      const header = signWebhookPayload({
        secret,
        timestamp: fixedTimestamp,
        rawBody,
      });

      // Extra space at the end
      const isValidWithSpace = verifyWebhookSignature({
        header,
        rawBody: `${rawBody} `,
        secret,
        toleranceS: 300,
        now: () => fixedNowMs,
      });
      expect(isValidWithSpace).toBe(false);

      // Changed field value
      const modifiedBody = '{"event_id":"evt_01J","type":"charge.succeeded","amount":100.01}';
      const isValidModified = verifyWebhookSignature({
        header,
        rawBody: modifiedBody,
        secret,
        toleranceS: 300,
        now: () => fixedNowMs,
      });
      expect(isValidModified).toBe(false);
    });

    test("returns false when secret is different", () => {
      const header = signWebhookPayload({
        secret,
        timestamp: fixedTimestamp,
        rawBody,
      });

      const isValid = verifyWebhookSignature({
        header,
        rawBody,
        secret: "wrong_secret_key_99999",
        toleranceS: 300,
        now: () => fixedNowMs,
      });

      expect(isValid).toBe(false);
    });

    test("returns false when timestamp t is tampered with in header (replay attack protection)", () => {
      // v1 was generated for fixedTimestamp, but header claims fixedTimestamp + 1
      const tamperedHeader = `t=${fixedTimestamp + 1},v1=${expectedFixedV1}`;

      const isValid = verifyWebhookSignature({
        header: tamperedHeader,
        rawBody,
        secret,
        toleranceS: 300,
        now: () => (fixedTimestamp + 1) * 1000,
      });

      expect(isValid).toBe(false);
    });

    describe("timestamp tolerance boundaries", () => {
      const toleranceS = 300;

      test("returns true when timestamp is within tolerance boundary (at exactly +300s or -300s)", () => {
        // At exactly 300s in the past
        const pastHeader = signWebhookPayload({
          secret,
          timestamp: fixedTimestamp - 300,
          rawBody,
        });
        expect(
          verifyWebhookSignature({
            header: pastHeader,
            rawBody,
            secret,
            toleranceS,
            now: () => fixedNowMs,
          })
        ).toBe(true);

        // At exactly 300s in the future
        const futureHeader = signWebhookPayload({
          secret,
          timestamp: fixedTimestamp + 300,
          rawBody,
        });
        expect(
          verifyWebhookSignature({
            header: futureHeader,
            rawBody,
            secret,
            toleranceS,
            now: () => fixedNowMs,
          })
        ).toBe(true);
      });

      test("returns false when timestamp is outside tolerance (301s in the past or 301s in the future)", () => {
        // 301s in the past
        const oldHeader = signWebhookPayload({
          secret,
          timestamp: fixedTimestamp - 301,
          rawBody,
        });
        expect(
          verifyWebhookSignature({
            header: oldHeader,
            rawBody,
            secret,
            toleranceS,
            now: () => fixedNowMs,
          })
        ).toBe(false);

        // 301s in the future
        const futureHeader = signWebhookPayload({
          secret,
          timestamp: fixedTimestamp + 301,
          rawBody,
        });
        expect(
          verifyWebhookSignature({
            header: futureHeader,
            rawBody,
            secret,
            toleranceS,
            now: () => fixedNowMs,
          })
        ).toBe(false);
      });
    });

    test("defaults now to Date.now when now function is omitted", () => {
      const currentSeconds = Math.floor(Date.now() / 1000);
      const header = signWebhookPayload({
        secret,
        timestamp: currentSeconds,
        rawBody,
      });

      const isValid = verifyWebhookSignature({
        header,
        rawBody,
        secret,
        toleranceS: 300,
      });

      expect(isValid).toBe(true);
    });

    test("returns false without throwing on missing or malformed headers", () => {
      const malformedHeaders = [
        undefined,
        null,
        "",
        "   ",
        "invalid",
        `t=${fixedTimestamp}`, // missing v1
        `v1=${expectedFixedV1}`, // missing t
        `t=notanumber,v1=${expectedFixedV1}`, // non-numeric t
        `t=${fixedTimestamp},v1=short`, // invalid v1 length
        `t=${fixedTimestamp},v1=${expectedFixedV1.toUpperCase()}`, // uppercase hex
        `t=${fixedTimestamp},v1=${"z".repeat(64)}`, // non-hex
      ];

      for (const header of malformedHeaders) {
        expect(() => {
          const result = verifyWebhookSignature({
            header,
            rawBody,
            secret,
            toleranceS: 300,
            now: () => fixedNowMs,
          });
          expect(result).toBe(false);
        }).not.toThrow();
      }
    });

    test("returns false without throwing when secret is empty or tolerance is invalid", () => {
      expect(
        verifyWebhookSignature({
          header: expectedFixedHeader,
          rawBody,
          secret: "",
          toleranceS: 300,
          now: () => fixedNowMs,
        })
      ).toBe(false);

      expect(
        verifyWebhookSignature({
          header: expectedFixedHeader,
          rawBody,
          secret,
          toleranceS: -1,
          now: () => fixedNowMs,
        })
      ).toBe(false);
    });
  });
});
