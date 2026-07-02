// ---------------------------------------------------------------------------
// src/reasoning/adaptive.ts — Deterministic, config-driven selector for the
// `adaptive` policy mode.
//
// This module owns ALL automatic level-selection logic. The function is pure:
// no IO, no module-level state, no side effects. Given the same signals and
// policy, it returns the same decision every time — that is the contract.
//
// Decision order (first match wins; see `selectAdaptiveLevel` below):
//
//   1. `policy.adaptive` is absent                 → null  (no adaptive config)
//   2. `signals.isTrivial` is true                 → adaptive.trivialLevel ?? null
//   3. `adaptive.tierDefaults[signals.tierName]`   → that level (wins over default)
//   4. `adaptive.keywordRules` (array order)       → first rule whose keywords
//                                                   match in prompt OR description
//                                                   (case-insensitive substring)
//   5. catch-all                                   → adaptive.defaultLevel ?? null
//
// `null` at every step means "no patch" — the caller leaves the agent def at
// its baseline. The resolver (`policy.ts`) is responsible for translating the
// selected level through the tier's capability; this module only picks the
// level. Keeping the translation out of here means the selector is decoupled
// from provider-specific reasoning channels and stays trivially testable.
// ---------------------------------------------------------------------------

import type { AdaptivePolicyConfig, ReasoningPolicyConfig } from "../router/config.types.js";
import type { ReasoningLevel } from "./capability.js";

/**
 * Signals available at dispatch time. All inputs must be pre-normalised by
 * the caller (today: the plugin hook layer in `src/plugin/hooks.ts`).
 *
 * - `prompt` and `description` MUST be lowercased before being passed in.
 *   Keyword matching is case-insensitive substring matching, so the selector
 *   itself does not re-lowercase — keeping it cheap to call and predictable
 *   to test.
 * - `tierName` is the dispatcher tier name (e.g. "medium", "heavy"). Looked
 *   up against `AdaptivePolicyConfig.tierDefaults`.
 * - `isTrivial` is the dispatch-time trivial classification result. Sourced
 *   from the session store.
 */
export interface AdaptiveSignals {
  /** Lowercased task prompt text from the Task tool args. May be empty. */
  prompt: string;
  /** Lowercased task description from the Task tool args. May be empty. */
  description: string;
  /** The tier name being dispatched (e.g. "medium", "heavy"). */
  tierName: string;
  /** Whether the session was classified as trivial at dispatch time. */
  isTrivial: boolean;
}

/**
 * The selector's decision for a single dispatch. `level === null` means
 * "no patch" — the resolver will leave the agent def at baseline.
 *
 * `reason` is a short, machine-friendly string suitable for debug logs (it
 * is emitted via `log.debug({ event: "reasoning.adaptive_selected", ... })`
 * when `adaptive.surfaceDecision === true`). It is NOT a contract for
 * callers — tests should assert on `level`, not `reason`.
 */
export interface AdaptiveDecision {
  level: ReasoningLevel | null;
  reason: string;
}

/**
 * Resolve the level the adaptive selector would apply for the given signals
 * and policy. First-match-wins decision order documented at the top of this
 * file. Pure — no IO, no module state, deterministic.
 *
 * The function is intentionally permissive about null/undefined on level
 * fields: every level on `AdaptivePolicyConfig` is declared
 * `ReasoningLevel | null`, and `null`/absent values are treated identically
 * as "fall through to the next decision branch". This lets configs
 * explicitly opt out (e.g. `base.json` ships `"trivialLevel": null`).
 */
export const selectAdaptiveLevel = (
  signals: AdaptiveSignals,
  policy: ReasoningPolicyConfig | undefined,
): AdaptiveDecision => {
  const adaptive: AdaptivePolicyConfig | undefined = policy?.adaptive;
  if (!adaptive) {
    return { level: null, reason: "no adaptive config" };
  }

  if (signals.isTrivial) {
    return { level: adaptive.trivialLevel ?? null, reason: "trivial" };
  }

  const tierDefault = adaptive.tierDefaults?.[signals.tierName];
  if (tierDefault !== undefined) {
    return { level: tierDefault, reason: `tier default: ${signals.tierName}` };
  }

  const keywordRules = adaptive.keywordRules;
  if (keywordRules) {
    for (const rule of keywordRules) {
      // Fail-soft guard: skip rules with a missing or non-array `keywords`
      // field without throwing. The TypeScript type is `string[]`, but
      // runtime config can drift (hand-edited files, partial migrations),
      // and the spec requires malformed rules to be skipped — never raised.
      if (!Array.isArray(rule?.keywords)) continue;

      // First keyword to hit wins; this preserves the design's "first match
      // wins" contract without scanning the rest of the rule's keywords.
      // The inner `typeof kw === "string"` check is a parallel fail-soft
      // guard: a non-string entry inside `keywords` would otherwise throw
      // on `String.prototype.includes`. Such entries are simply non-matching.
      const matched = rule.keywords.find(
        (kw) =>
          typeof kw === "string" &&
          (signals.prompt.includes(kw) || signals.description.includes(kw)),
      );
      if (matched !== undefined) {
        return { level: rule.level, reason: `keyword match: ${matched}` };
      }
    }
  }

  return { level: adaptive.defaultLevel ?? null, reason: "default level" };
};
