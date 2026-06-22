import type { TierConfig, Preset, RouterConfig } from "./config";
import {
  isClaudeModel,
  CLAUDE_TIER_PREFIX,
  CLAUDE_ANTI_NARRATION,
} from "./protocol";

// ---------------------------------------------------------------------------
// Build agent options from tier config
// ---------------------------------------------------------------------------

export function buildAgentOptions(tier: TierConfig): Record<string, unknown> {
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
}

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
export function registerTierAgents(
  opencodeConfig: { agent?: Record<string, Record<string, unknown>> },
  activeTiers: Preset,
  cfg: RouterConfig,
): void {
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
}
