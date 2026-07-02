// ---------------------------------------------------------------------------
// src/reasoning/policy.ts — Resolve an effective reasoning override for a tier
// given the configured policy mode and a per-session override.
//
// This is the SINGLE place policy mode semantics live. The function is pure:
// no IO, no mutation, no module-level state. The runtime hooks
// (`src/plugin/runtime.ts`) and the `/reasoning` command handler both call it
// with the same inputs and get the same outputs.
//
// Modes:
//   - `static`   → ALWAYS null (primary regression guard). Even if a session
//                  override exists, static mode ignores it and the agent def
//                  is left exactly as `registerTierAgents` produced it. This
//                  preserves today's behaviour when `reasoningPolicy` is
//                  absent or `mode === "static"`.
//   - `manual`   → resolve `sessionOverride ?? policy.defaultLevel`, translate
//                  through the tier's capability. If both are undefined → null
//                  (no-op).
//   - `adaptive` → consult `selectAdaptiveLevel` (in `./adaptive.ts`) for a
//                  level picked from real task signals. Precedence, highest
//                  first:
//                      1. explicit `sessionOverride` (always wins)
//                      2. `selectAdaptiveLevel(signals, policy)` result
//                      3. `policy.defaultLevel` as a safety net
//                      4. null (no patch — agent def left at baseline)
//                  Every resolved level is passed through `translateLevel`
//                  so capability gating still applies; adaptive only picks
//                  the normalized level, not the provider-specific patch.
// ---------------------------------------------------------------------------

import type { ReasoningPolicyConfig, TierConfig } from "../router/config.types.js";
import { type AdaptiveSignals, selectAdaptiveLevel } from "./adaptive.js";
import { inferCapability, type ReasoningLevel } from "./capability.js";
import { type ResolvedReasoning, translateLevel } from "./translate.js";

/**
 * Resolve the effective reasoning patch for a tier under the configured policy.
 *
 * The `sessionOverride` is sourced from `reasoningStore.get(sessionID)`. The
 * hook layer decides whether to thread it (manual mode reads it; static mode
 * ignores it; adaptive mode reads it FIRST so a per-session override always
 * wins over selector output — operators need certainty when they set it
 * manually via `/model-router-reasoning elevated`).
 *
 * The `signals` argument is required — it feeds `selectAdaptiveLevel` in
 * adaptive mode. Hooks that haven't yet threaded real task text (today:
 * `src/plugin/hooks.ts` — wired in a later PR of Plan 015) pass an empty
 * `{ prompt: "", description: "", tierName, isTrivial }` placeholder; the
 * selector's keyword step is a substring match against an empty haystack so
 * non-trivial calls fall through to `tierDefaults` / `defaultLevel` safely.
 *
 * Returns `null` when:
 *   - the policy mode is `static`, OR
 *   - no level resolves (no override + no adaptive block + no defaultLevel),
 *     OR
 *   - the tier's capability cannot satisfy the level (`none`, or `binary`
 *     with no baseline for a low-rank level — see `translateLevel`).
 *
 * `surfaceLimits` is intentionally NOT consulted here — surfacing is a
 * presentation concern owned by the `/reasoning` command handler and the
 * runtime log layer. The flag's only effect on this function is that the
 * resolved patch is identical regardless of its value (proved in
 * `reasoning-policy.test.ts`).
 */
export const resolveReasoningOverride = (
  tier: TierConfig,
  policy: ReasoningPolicyConfig | undefined,
  sessionOverride: ReasoningLevel | undefined,
  signals: AdaptiveSignals,
): ResolvedReasoning => {
  const mode = policy?.mode ?? "static";

  // Primary regression guard: static mode is a hard no-op, regardless of any
  // session override. This keeps the agent def exactly as `registerTierAgents`
  // produced it when `reasoningPolicy` is absent or `mode === "static"`.
  if (mode === "static") return null;

  // Manual mode: pre-Plan-015 semantics, unchanged. A per-session override
  // wins over `policy.defaultLevel`; either way we translate through the
  // tier's capability.
  if (mode === "manual") {
    const level = sessionOverride ?? policy?.defaultLevel;
    if (!level) return null;
    const cap = tier.capability ?? inferCapability(tier);
    return translateLevel(cap, level);
  }

  // mode === "adaptive"
  // Precedence (highest first; mirroring the file header):
  //   1. explicit `sessionOverride` (always wins)
  //   2. `selectAdaptiveLevel(signals, policy)` result
  //   3. `policy.defaultLevel` as a safety net
  //   4. null (no patch — agent def left at baseline)
  if (sessionOverride) {
    const cap = tier.capability ?? inferCapability(tier);
    return translateLevel(cap, sessionOverride);
  }

  const decision = selectAdaptiveLevel(signals, policy);
  const level = decision.level ?? policy?.defaultLevel;
  if (!level) return null;

  const cap = tier.capability ?? inferCapability(tier);
  return translateLevel(cap, level);
};
