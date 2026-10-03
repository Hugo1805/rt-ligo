import { createHmac, timingSafeEqual } from "node:crypto";

const POSITIVE_INT_REGEX = /^[1-9]\d*$/;
const V1_HEX_REGEX = /^[0-9a-f]{64}$/;

export interface WebhookSignatureHeader {
  t: number;
  v1: string;
}

export interface SignWebhookPayloadParams {
  secret: string;
  timestamp: number;
  rawBody: string;
}

export interface VerifyWebhookSignatureParams {
  header: string | undefined | null;
  rawBody: string;
  secret: string;
  toleranceS: number;
  now?: () => number;
}

/**
 * Generates the X-Provider-Signature header value: `t=<timestamp>,v1=<hex>`.
 * `timestamp` must be in Unix seconds.
 */
export function signWebhookPayload({
  secret,
  timestamp,
  rawBody,
}: SignWebhookPayloadParams): string {
  const hmac = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  return `t=${timestamp},v1=${hmac}`;
}

/**
 * Parses the X-Provider-Signature header into `{ t, v1 }`.
 * Requires exactly one positive integer `t` and one 64-char lowercase hex `v1`.
 * Returns null for any malformed input without throwing.
 */
export function parseSignatureHeader(
  header: string | undefined | null
): WebhookSignatureHeader | null {
  if (typeof header !== "string" || header.trim().length === 0) {
    return null;
  }

  const parts = header.split(",");
  let tValue: number | null = null;
  let v1Value: string | null = null;

  for (const rawPart of parts) {
    const part = rawPart.trim();
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) {
      return null;
    }

    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();

    if (key === "t") {
      if (tValue !== null || !POSITIVE_INT_REGEX.test(val)) {
        return null;
      }
      const parsed = Number(val);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return null;
      }
      tValue = parsed;
    } else if (key === "v1") {
      if (v1Value !== null || !V1_HEX_REGEX.test(val)) {
        return null;
      }
      v1Value = val;
    } else {
      return null;
    }
  }

  if (tValue === null || v1Value === null) {
    return null;
  }

  return { t: tValue, v1: v1Value };
}

/**
 * Verifies the X-Provider-Signature header against the raw body using constant-time comparison.
 * Rejects timestamps outside tolerance window (both past and future).
 * Never throws on malformed headers.
 */
export function verifyWebhookSignature({
  header,
  rawBody,
  secret,
  toleranceS,
  now = Date.now,
}: VerifyWebhookSignatureParams): boolean {
  if (!header || typeof header !== "string") {
    return false;
  }

  if (typeof rawBody !== "string" || typeof secret !== "string" || secret.length === 0) {
    return false;
  }

  if (typeof toleranceS !== "number" || Number.isNaN(toleranceS) || toleranceS < 0) {
    return false;
  }

  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return false;
  }

  const nowMs = typeof now === "function" ? now() : Date.now();
  if (typeof nowMs !== "number" || Number.isNaN(nowMs)) {
    return false;
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - parsed.t) > toleranceS) {
    return false;
  }

  try {
    const expectedDigest = createHmac("sha256", secret)
      .update(`${parsed.t}.${rawBody}`, "utf8")
      .digest();

    const receivedDigest = Buffer.from(parsed.v1, "hex");

    if (expectedDigest.length !== receivedDigest.length) {
      return false;
    }

    return timingSafeEqual(expectedDigest, receivedDigest);
  } catch {
    return false;
  }
}
