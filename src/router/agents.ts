import type { ResolvedReasoning } from "../reasoning/translate.js";
import type { Preset, RouterConfig, TierConfig } from "./config";
import { CLAUDE_ANTI_NARRATION, CLAUDE_TIER_PREFIX, isClaudeModel } from "./protocol";

// ---------------------------------------------------------------------------
// Build agent options from tier config
// ---------------------------------------------------------------------------

export const buildAgentOptions = (tier: TierConfig): Record<string, unknown> => {
  const opts: Record<string, unknown> = {};

  // Anthropic thinking config
  if (tier.thinking) {
    if (tier.thinking.budgetTokens) {
      opts.budget_tokens = tier.thinking.budgetTokens;
    }
  }

  // OpenAI reasoning config
  if (tier.reasoning) {
    if (tier.reasoning.effort) {
      opts.reasoning_effort = tier.reasoning.effort;
    }
    if (tier.reasoning.summary) {
      opts.reasoning_summary = tier.reasoning.summary;
    }
  }

  return Object.keys(opts).length > 0 ? opts : {};
};

// ---------------------------------------------------------------------------
// Live-tier reasoning patch-applier (PR 2 of adaptive-reasoning).
//
// `registerTierAgents` produces the STATIC agent defs that load the plugin
// knows about. Per-session reasoning overrides (set via `/reasoning`) are
// applied AROUND individual `task` calls from `tool.execute.before` and
// reverted in `tool.execute.after`, NOT at config time — so the patch must
// touch only the targeted tier and leave every other tier untouched.
//
// This helper is intentionally narrow: it merges a `ResolvedReasoning` patch
// into an existing agent def in place. The caller is responsible for
// (a) holding the opencodeConfig reference (set in PluginContext from
// `handleConfig`), and (b) restoring the baseline after the tool call.
//
//   `variant` → set/overwrite on the agent def. The static `tier.variant`
//               (if any) is the baseline; the override replaces it.
//   `options` → shallow-merge into the existing `options` object. Override
//               keys win. Static keys the patch doesn't touch (e.g.
//               `reasoning_summary`) are preserved.
//
// `none`-capability tiers MUST NEVER be mutated. The caller filters `null`
// patches before calling — see `resolveReasoningOverride`, which returns
// `null` for `none` regardless of the requested level. This helper still
// defends against an explicit `null` patch so it stays safe if a future
// caller forgets to check.
// ---------------------------------------------------------------------------

export const applyReasoningPatch = (
  agentDef: Record<string, unknown>,
  resolved: ResolvedReasoning,
): void => {
  if (!resolved) return;

  if (resolved.variant !== undefined) {
    agentDef.variant = resolved.variant;
  }

  if (resolved.options && Object.keys(resolved.options).length > 0) {
    const existing =
      agentDef.options && typeof agentDef.options === "object" && !Array.isArray(agentDef.options)
        ? (agentDef.options as Record<string, unknown>)
        : {};
    agentDef.options = { ...existing, ...resolved.options };
  }
};

/**
 * Restore an agent def to its captured baseline. The caller (tool.execute.after
 * hook) supplies the reference returned by `registerTierAgents` at config
 * time. Restoration is a shallow property replace — keys the baseline lacks
 * are dropped, keys the baseline has are restored exactly. Static shape
 * preservation is the regression guarantee for `static` mode (the primary
 * invariant the spec calls out).
 */
export const restoreAgentBaseline = (
  agentDef: Record<string, unknown>,
  baseline: Record<string, unknown>,
): void => {
  for (const key of Object.keys(agentDef)) {
    delete agentDef[key];
  }
  for (const [key, value] of Object.entries(baseline)) {
    agentDef[key] = value;
  }
};

// ---------------------------------------------------------------------------
// Register tier agents on the opencode config object
// ---------------------------------------------------------------------------

/**
 * Populate `opencodeConfig.agent` with one entry per tier in `activeTiers`.
 * Mirrors the loop that lived in `src/index.ts`'s `config()` hook: resolves
 * the per-tier prompt (with global `tierPrompts[name]` fallback), prepends
 * the adversarial Claude opener when the tier's model is Claude-backed,
 * applies variant + provider-specific options from `buildAgentOptions`,
 * and writes the resulting agent def under `opencodeConfig.agent[name]`.
 *
 * Side-effect only — the returned void matches the original inline loop.
 */
export const registerTierAgents = (
  opencodeConfig: { agent?: Record<string, Record<string, unknown>> },
  activeTiers: Preset,
  cfg: RouterConfig,
): void => {
  opencodeConfig.agent ??= {};

  for (const [name, tier] of Object.entries(activeTiers)) {
    // Resolve prompt: per-tier override wins; otherwise fall back to global tierPrompts[name].
    const resolvedPrompt = tier.prompt ?? cfg.tierPrompts?.[name];

    // For Claude-backed tiers, prepend an adversarial opener that revokes
    // the cached "Claude Code exploratory agent" priming for this dispatch.
    // Detection is by model string, so hybrid presets get the override
    // only on their Claude-backed tiers.
    const claudePrefix = isClaudeModel(tier.model)
      ? `${CLAUDE_TIER_PREFIX[name]}\n\n${CLAUDE_ANTI_NARRATION}`
      : undefined;
    const finalPrompt =
      claudePrefix && resolvedPrompt
        ? `${claudePrefix}\n\n---\n\n${resolvedPrompt}`
        : resolvedPrompt;

    const agentDef: Record<string, unknown> = {
      model: tier.model,
      mode: "subagent",
      description: tier.description,
      maxSteps: tier.steps,
      prompt: finalPrompt,
      color: tier.color,
    };

    // Apply variant (thinking/reasoning mode)
    if (tier.variant) {
      agentDef.variant = tier.variant;
    }

    // Apply provider-specific options
    const opts = buildAgentOptions(tier);
    if (Object.keys(opts).length > 0) {
      agentDef.options = opts;
    }

    opencodeConfig.agent[name] = agentDef;
  }
};
