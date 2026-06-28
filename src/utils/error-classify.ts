// ---------------------------------------------------------------------------
// src/utils/error-classify.ts — Classify SDK prompt errors into retry buckets.
//
// The SDK (`client.session.prompt`) throws opaque Error instances with no
// structured error code or HTTP status property. This module inspects
// `err.message`, `err.name`, and any `status`/`statusCode` property to
// classify errors into three buckets:
//
//   abort        — user cancelled (AbortError). Caller should bail silently.
//   non_retryable — model/billing/auth/config errors that will never succeed
//                   on retry. Caller should fail-closed immediately.
//   retryable    — transport or transient API errors. Caller may retry or
//                   let the ladder decide.
//
// Patterns are deliberately broad and case-insensitive. False positives on
// the retryable bucket are safe (they just retry), but false negatives on
// non-retryable (misclassifying a billing error as retryable) would waste
// attempts. So the non-retryable patterns err on the side of inclusion.
// ---------------------------------------------------------------------------

export type PromptErrorKind = "abort" | "non_retryable" | "retryable";

export interface ClassifiedError {
  kind: PromptErrorKind;
  reason: string;
}

const NON_RETRYABLE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /model.{0,5}not.{0,5}found/i, reason: "model not found" },
  { pattern: /unknown.{0,5}model/i, reason: "model not found" },
  { pattern: /insufficient/i, reason: "insufficient billing or subscription" },
  { pattern: /billing/i, reason: "insufficient billing or subscription" },
  { pattern: /subscription/i, reason: "insufficient billing or subscription" },
  { pattern: /payment.{0,5}required/i, reason: "insufficient billing or subscription" },
  { pattern: /quota/i, reason: "insufficient billing or subscription" },
  { pattern: /credits/i, reason: "insufficient billing or subscription" },
  { pattern: /unauthor/i, reason: "auth or permission denied" },
  { pattern: /forbidden/i, reason: "auth or permission denied" },
  { pattern: /permission.{0,5}denied/i, reason: "auth or permission denied" },
  { pattern: /invalid.{0,10}model/i, reason: "invalid model or provider configuration" },
  { pattern: /invalid.{0,10}provider/i, reason: "invalid model or provider configuration" },
];

const HTTP_STATUS_PATTERNS: Array<{ codes: number[]; reason: string }> = [
  { codes: [402], reason: "insufficient billing or subscription" },
  { codes: [401], reason: "auth or permission denied" },
  { codes: [403], reason: "auth or permission denied" },
  { codes: [404], reason: "model not found" },
];

const extractStatus = (err: unknown): number | null => {
  if (typeof err !== "object" || err === null) return null;
  const rec = err as Record<string, unknown>;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return null;
};

const extractMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
};

export const classifyPromptError = (err: unknown): ClassifiedError => {
  // Priority 1: AbortError — always bail silently.
  if (err instanceof DOMException && err.name === "AbortError") {
    return { kind: "abort", reason: "aborted" };
  }

  // Priority 2: HTTP status codes (structured).
  const status = extractStatus(err);
  if (status !== null) {
    for (const { codes, reason } of HTTP_STATUS_PATTERNS) {
      if (codes.includes(status)) {
        return { kind: "non_retryable", reason };
      }
    }
  }

  // Priority 3: message-based heuristics.
  const message = extractMessage(err);
  for (const { pattern, reason } of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return { kind: "non_retryable", reason };
    }
  }

  // Default: treat as retryable transport/transient error.
  return { kind: "retryable", reason: "transport or transient API error" };
};
