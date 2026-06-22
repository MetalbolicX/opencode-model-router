import type { TierConfig } from "./config";

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
