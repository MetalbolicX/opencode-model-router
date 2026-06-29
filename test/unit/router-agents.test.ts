import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTierAgents, buildAgentOptions } from "../../src/router/agents";
import { CLAUDE_ANTI_NARRATION, CLAUDE_TIER_PREFIX, isClaudeModel } from "../../src/router/protocol";
import type { TierConfig } from "../../src/router/config.types";
import type { Preset, RouterConfig } from "../../src/router/config";

let tmpHome: string;
let tmpCwd: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origCwd: string;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origCwd = process.cwd();
  tmpHome = join(
    tmpdir(),
    `oc-agents-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  process.chdir(origCwd);
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTier = (overrides: Partial<TierConfig> = {}): TierConfig => ({
  model: "anthropic/claude-haiku-4-5",
  description: "test tier",
  whenToUse: [],
  steps: 10,
  color: "#00ff00",
  ...overrides,
});

const makePreset = (tiers: Record<string, TierConfig>): Preset => tiers;

const makeConfig = (overrides: Partial<RouterConfig> = {}): RouterConfig => ({
  activePreset: "default",
  defaultTier: "fast",
  presets: {
    default: {
      fast: makeTier(),
      medium: makeTier({ model: "anthropic/claude-sonnet-4" }),
    },
  },
  rules: [],
  enforcement: {
    verify: { require: "always", graderTemperature: 0 },
    escalate: { ladder: ["fast", "medium", "heavy"], maxAttemptsPerTier: 1, maxTotalAttempts: 5 },
  },
  tierPrompts: {},
  ...overrides,
} as RouterConfig);

// ---------------------------------------------------------------------------
// Tests: buildAgentOptions
// ---------------------------------------------------------------------------

describe("buildAgentOptions", () => {
  it("maps thinking.budgetTokens to budget_tokens", () => {
    const result = buildAgentOptions(makeTier({ thinking: { budgetTokens: 4096 } }) as any);
    expect(result).toEqual({ budget_tokens: 4096 });
  });

  it("maps reasoning.effort and reasoning.summary", () => {
    const result = buildAgentOptions(
      makeTier({ reasoning: { effort: "high", summary: "auto" } }) as any,
    );
    expect(result).toEqual({ reasoning_effort: "high", reasoning_summary: "auto" });
  });

  it("returns empty object when tier has no thinking or reasoning config", () => {
    const result = buildAgentOptions(makeTier() as any);
    expect(result).toEqual({});
  });

  it("returns empty object when thinking/reasoning are present but have no set fields", () => {
    const emptyThinking = { budgetTokens: undefined } as TierConfig["thinking"];
    const emptyReasoning = { effort: undefined, summary: undefined } as TierConfig["reasoning"];
    const result = buildAgentOptions(makeTier({ thinking: emptyThinking, reasoning: emptyReasoning }));
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tests: registerTierAgents
// ---------------------------------------------------------------------------

describe("registerTierAgents", () => {
  it("populates opencodeConfig.agent with one entry per active tier", () => {
    const cfg = makeConfig();
    const preset = makePreset({ fast: makeTier(), medium: makeTier() });
    const opencodeConfig: Record<string, any> = {};

    registerTierAgents(opencodeConfig, preset, cfg);

    expect(Object.keys(opencodeConfig.agent ?? {})).toHaveLength(2);
    expect(opencodeConfig.agent).toHaveProperty("fast");
    expect(opencodeConfig.agent).toHaveProperty("medium");
  });

  it("each agent def includes model, mode subagent, description, maxSteps, prompt, color", () => {
    const tier = makeTier({
      model: "openai/gpt-4o",
      description: "fast agent",
      steps: 5,
      color: "#ff0000",
      prompt: "do the thing",
    });
    const cfg = makeConfig();
    const preset = makePreset({ fast: tier });
    const opencodeConfig: Record<string, any> = {};

    registerTierAgents(opencodeConfig, preset, cfg);

    const def = opencodeConfig.agent?.fast;
    expect(def.model).toBe("openai/gpt-4o");
    expect(def.mode).toBe("subagent");
    expect(def.description).toBe("fast agent");
    expect(def.maxSteps).toBe(5);
    expect(def.prompt).toBe("do the thing");
    expect(def.color).toBe("#ff0000");
  });

  it("per-tier prompt overrides cfg.tierPrompts[name]", () => {
    const tier = makeTier({ model: "openai/gpt-4o", prompt: "tier prompt" });
    const cfg = makeConfig({ tierPrompts: { fast: "config prompt" } });
    const preset = makePreset({ fast: tier });
    const opencodeConfig: Record<string, any> = {};

    registerTierAgents(opencodeConfig, preset, cfg);

    expect(opencodeConfig.agent?.fast?.prompt).toBe("tier prompt");
  });

  it("falls back to cfg.tierPrompts[name] when tier.prompt is absent", () => {
    const tier = makeTier({ model: "openai/gpt-4o" });
    delete (tier as any).prompt;
    const cfg = makeConfig({ tierPrompts: { fast: "config fallback" } });
    const preset = makePreset({ fast: tier });
    const opencodeConfig: Record<string, any> = {};

    registerTierAgents(opencodeConfig, preset, cfg);

    expect(opencodeConfig.agent?.fast?.prompt).toBe("config fallback");
  });

  it("prepends Claude tier prefix for Claude-backed tier models", () => {
    const tier = makeTier({
      model: "anthropic/claude-haiku-4-5",
      prompt: "original prompt",
    });
    const cfg = makeConfig();
    const preset = makePreset({ fast: tier });
    const opencodeConfig: Record<string, any> = {};

    registerTierAgents(opencodeConfig, preset, cfg);

    const expectedPrefix = `${CLAUDE_TIER_PREFIX["fast"]}\n\n${CLAUDE_ANTI_NARRATION}`;
    expect(opencodeConfig.agent?.fast?.prompt).toContain(expectedPrefix);
    expect(opencodeConfig.agent?.fast?.prompt).toContain("original prompt");
  });

  it("does NOT prepend Claude prefix for non-Claude models", () => {
    const tier = makeTier({
      model: "openai/gpt-4o",
      prompt: "non-claude prompt",
    });
    const cfg = makeConfig();
    const preset = makePreset({ fast: tier });
    const opencodeConfig: Record<string, any> = {};

    registerTierAgents(opencodeConfig, preset, cfg);

    expect(opencodeConfig.agent?.fast?.prompt).toBe("non-claude prompt");
    expect(opencodeConfig.agent?.fast?.prompt).not.toContain("SCOPE NOTE");
  });

  it("adds variant only when tier.variant is present", () => {
    const fastTier = makeTier({ variant: "thinking" });
    const mediumTier = makeTier();
    delete (mediumTier as any).variant;
    const cfg = makeConfig();
    const preset = makePreset({ fast: fastTier, medium: mediumTier });
    const opencodeConfig: Record<string, any> = {};

    registerTierAgents(opencodeConfig, preset, cfg);

    expect(opencodeConfig.agent?.fast?.variant).toBe("thinking");
    expect(opencodeConfig.agent?.medium?.variant).toBeUndefined();
  });

  it("adds options only when buildAgentOptions returns non-empty", () => {
    const fastTier = makeTier({ thinking: { budgetTokens: 4096 } });
    const mediumTier = makeTier();
    const cfg = makeConfig();
    const preset = makePreset({ fast: fastTier, medium: mediumTier });
    const opencodeConfig: Record<string, any> = {};

    registerTierAgents(opencodeConfig, preset, cfg);

    expect(opencodeConfig.agent?.fast?.options).toEqual({ budget_tokens: 4096 });
    expect(opencodeConfig.agent?.medium?.options).toBeUndefined();
  });

  it("does not throw when opencodeConfig.agent is undefined (initialises it)", () => {
    const cfg = makeConfig();
    const preset = makePreset({ fast: makeTier() });
    const opencodeConfig: Record<string, any> = {};

    expect(() => registerTierAgents(opencodeConfig, preset, cfg)).not.toThrow();
    expect(opencodeConfig.agent).toBeDefined();
  });
});
