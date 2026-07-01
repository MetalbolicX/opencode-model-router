// ---------------------------------------------------------------------------
// src/reasoning/capability.ts — Provider-agnostic reasoning capability model.
//
// Pure types and a single inference helper. NO side effects, NO file IO,
// NO router wiring. This is the canonical home of `ReasoningCapability`;
// `src/router/config.types.ts` re-exports the type once Phase 2 wires it in.
// ---------------------------------------------------------------------------

import type { TierConfig } from "../router/config.types.js";

/**
 * Normalized reasoning level. Provider-agnostic. Each tier's `translateLevel`
 * resolves one of these into the provider-specific `variant`/`options` patch.
 *
 * The rank is implicit:  minimal = 0, normal = 1, elevated = 2, max = 3.
 */
export type ReasoningLevel = "minimal" | "normal" | "elevated" | "max";

/**
 * Output channel a capability writes through. This discriminates between the
 * three provider APIs the router currently bridges:
 *
 *   - `"variant"`              → `agentDef.variant` (mimo / gpt-5.5 ladders, MiniMax named modes)
 *   - `"reasoning.effort"`     → `agentDef.options.reasoning_effort` (OpenAI-style effort option)
 *   - `"thinking.budgetTokens"`→ `agentDef.options.budget_tokens` (Anthropic-style token budget)
 *
 * Kept as a string literal union (not enum) so it round-trips through JSON
 * without ceremony and matches the shape of `inferCapability`'s outputs.
 */
export type ReasoningField = "variant" | "reasoning.effort" | "thinking.budgetTokens";

/**
 * Capability shape describing how a tier exposes reasoning control.
 *
 * - `none`     — tier exposes no reasoning control; NEVER mutated by the router.
 * - `binary`   — two-state toggle (e.g. default ↔ thinking); writes through `variant`.
 * - `discrete` — N-state ladder; writes through either `variant` or `reasoning.effort`.
 * - `budgeted` — token-budget ladder; writes through `thinking.budgetTokens`.
 *
 * The `field` discriminator is mandatory on every variant carrying output so
 * `translateLevel` has a single source of truth for routing — it never has to
 * look back at the tier to decide where the patch lands.
 */
export type ReasoningCapability =
  | { kind: "none" }
  | { kind: "binary"; field: "variant"; baseline?: string; elevated: string }
  | { kind: "discrete"; field: "variant" | "reasoning.effort"; levels: string[] }
  | {
      kind: "budgeted";
      field: "thinking.budgetTokens";
      recommended: Record<ReasoningLevel, number>;
    };

/** Positional variant values: ordinal positions in a low-to-high ladder. */
const POSITIONAL_VARIANTS = new Set<string>(["low", "medium", "high", "xhigh"]);

/** Named variant values: a single elevated reasoning mode, no low-end rung. */
const NAMED_VARIANTS = new Set<string>(["thinking", "max"]);

/**
 * Backward-compat inference: derive a capability from existing tier fields
 * when no explicit `capability` is declared. Keeps pre-010 configs working
 * without edits.
 *
 * Inference precedence (first match wins):
 *
 *   1. `tier.reasoning.effort` is set
 *        → discrete / `reasoning.effort`, levels ["low","medium","high"]
 *   2. `tier.thinking.budgetTokens` is set
 *        → budgeted / `thinking.budgetTokens`, default recommended ladder
 *   3. `tier.variant` is positional ("low" | "medium" | "high" | "xhigh")
 *        → discrete / `variant`, ladder sized to include the seen position
 *   4. `tier.variant` is named ("thinking" | "max")
 *        → binary / `variant`, elevated = the seen variant
 *   5. otherwise → `none`
 *
 * Tiers that need a richer capability (e.g. an explicit baseline on a binary,
 * custom ladder, custom budget map) MUST declare `capability` directly; this
 * inference is intentionally narrow so it can't silently invent behavior.
 */
export const inferCapability = (tier: TierConfig): ReasoningCapability => {
  if (tier.reasoning?.effort) {
    return { kind: "discrete", field: "reasoning.effort", levels: ["low", "medium", "high"] };
  }

  if (tier.thinking?.budgetTokens) {
    return {
      kind: "budgeted",
      field: "thinking.budgetTokens",
      recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
    };
  }

  const v = tier.variant;
  if (v) {
    if (POSITIONAL_VARIANTS.has(v)) {
      const levels = v === "xhigh" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"];
      return { kind: "discrete", field: "variant", levels };
    }
    if (NAMED_VARIANTS.has(v)) {
      return { kind: "binary", field: "variant", elevated: v };
    }
    // Free-form variant values fall through to `none` on purpose. Configs
    // that need them must declare an explicit `capability` (PR 3 of the
    // adaptive-reasoning plan adds the explicit declarations).
  }

  return { kind: "none" };
};
