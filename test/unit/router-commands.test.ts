import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RouterConfig,
  type TierConfig,
  type Preset,
} from "../../src/router/config";
import {
  buildRouterOutput,
  buildTiersOutput,
  buildBudgetOutput,
  buildPresetOutput,
} from "../../src/router/commands";

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
const savedEnvGate = process.env["MODEL_ROUTER_ENFORCE"];

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  tmpHome = join(
    tmpdir(),
    `oc-test-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  delete process.env["MODEL_ROUTER_ENFORCE"];
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  if (savedEnvGate === undefined) delete process.env["MODEL_ROUTER_ENFORCE"];
  else process.env["MODEL_ROUTER_ENFORCE"] = savedEnvGate;
});

/** Build a minimal RouterConfig with two presets and one mode for the unit tests. */
function makeConfig(extra: Partial<RouterConfig> = {}): RouterConfig {
  const anthropicPreset: Preset = {
    fast: {
      model: "anthropic/claude-haiku-4-5",
      description: "Haiku",
      steps: 30,
      whenToUse: ["recon"],
    } as TierConfig,
    medium: {
      model: "anthropic/claude-sonnet-4-6",
      description: "Sonnet",
      steps: 50,
      whenToUse: ["impl"],
    } as TierConfig,
  };
  const openaiPreset: Preset = {
    fast: {
      model: "openai/gpt-5.4-mini-fast",
      description: "Mini",
      steps: 30,
      whenToUse: ["recon"],
    } as TierConfig,
  };
  return {
    activePreset: "anthropic",
    presets: {
      anthropic: anthropicPreset,
      openai: openaiPreset,
    },
    rules: ["always be terse"],
    defaultTier: "fast",
    ...extra,
  };
}

describe("buildRouterOutput", () => {
  it("bare /router shows status", () => {
    const out = buildRouterOutput(makeConfig(), "");
    expect(out).toContain("# Model Router");
    expect(out).toContain("Enforcement:");
    expect(out).toContain("/tiers");
    expect(out).toContain("/router enforce");
  });

  it("/router with non-enforce sub shows status", () => {
    const out = buildRouterOutput(makeConfig(), "status");
    expect(out).toContain("# Model Router");
    expect(out).not.toContain("Usage:");
  });

  it("/router enforce <valid> persists and returns description", () => {
    const out = buildRouterOutput(makeConfig(), "enforce enforced");
    expect(out).toContain("enforced");
    expect(out).toContain("persisted");
    expect(out).toContain("Guard hard-blocks");
  });

  it("/router enforce off returns off description", () => {
    const out = buildRouterOutput(makeConfig(), "enforce off");
    expect(out).toContain("off");
    expect(out).toContain("disabled");
  });

  it("/router enforce advisory returns advisory description", () => {
    const out = buildRouterOutput(makeConfig(), "enforce advisory");
    expect(out).toContain("advisory");
    expect(out).toContain("never hard-blocks");
  });

  it("/router enforce with no mode shows current + usage", () => {
    const out = buildRouterOutput(makeConfig(), "enforce");
    expect(out).toContain("Usage:");
    expect(out).toContain("Current enforcement mode");
  });

  it("/router enforce with invalid mode shows usage", () => {
    const out = buildRouterOutput(makeConfig(), "enforce loud");
    expect(out).toContain("Usage:");
  });

  it("/router enforce ignores extra whitespace in args", () => {
    const out = buildRouterOutput(makeConfig(), "  enforce   off  ");
    expect(out).toContain("off");
  });
});

describe("buildTiersOutput", () => {
  it("lists all tiers in the active preset with their descriptions", () => {
    const out = buildTiersOutput(makeConfig());
    expect(out).toContain("Model Delegation Tiers");
    expect(out).toContain("Active preset: **anthropic**");
    expect(out).toContain("## @fast");
    expect(out).toContain("## @medium");
    expect(out).toContain("anthropic/claude-haiku-4-5");
    expect(out).toContain("anthropic/claude-sonnet-4-6");
  });

  it("lists delegation rules and default tier", () => {
    const out = buildTiersOutput(makeConfig());
    expect(out).toContain("## Delegation Rules");
    expect(out).toContain("- always be terse");
    expect(out).toContain("Default tier: @fast");
  });

  it("lists available presets", () => {
    const out = buildTiersOutput(makeConfig());
    expect(out).toContain("Available presets:");
    expect(out).toContain("anthropic");
    expect(out).toContain("openai");
  });

  it("renders thinking metadata when a tier has thinking config", () => {
    const cfg = makeConfig();
    cfg.presets.anthropic.fast = {
      model: "anthropic/claude-haiku-4-5",
      description: "Haiku",
      steps: 30,
      whenToUse: ["recon"],
      thinking: { budgetTokens: 1024 },
    } as TierConfig;
    const out = buildTiersOutput(cfg);
    expect(out).toContain("thinking: 1024 tokens");
  });

  it("renders reasoning metadata when a tier has reasoning config", () => {
    const cfg = makeConfig();
    cfg.presets.anthropic.fast = {
      model: "openai/gpt-5.4-mini-fast",
      description: "Mini",
      steps: 30,
      whenToUse: ["recon"],
      reasoning: { effort: "high" },
    } as TierConfig;
    const out = buildTiersOutput(cfg);
    expect(out).toContain("reasoning: effort=high");
  });
});

describe("buildBudgetOutput", () => {
  it("returns a usage message when no modes are configured", () => {
    const out = buildBudgetOutput(makeConfig(), "");
    expect(out).toContain("No modes configured");
  });

  it("lists available modes when called with no args", () => {
    const cfg = makeConfig({
      modes: {
        budget: { defaultTier: "fast", description: "cheap" },
        quality: { defaultTier: "medium", description: "best" },
      },
      activeMode: "quality",
    });
    const out = buildBudgetOutput(cfg, "");
    expect(out).toContain("Routing Modes");
    expect(out).toContain("**budget**");
    expect(out).toContain("**quality** <- active");
  });

  it("returns the 'Unknown mode' message for an unknown mode", () => {
    const cfg = makeConfig({
      modes: {
        budget: { defaultTier: "fast", description: "cheap" },
      },
    });
    const out = buildBudgetOutput(cfg, "unknown-mode");
    expect(out).toContain("Unknown mode");
    expect(out).toContain("unknown-mode");
  });

  it("switches mode when called with a valid mode name", () => {
    // We can't easily inject modes into loadConfig() (which reads from tiers.json).
    // But we can validate the "valid name" path produces a switch message IF the
    // config has that mode. Default tiers.json does not have modes, so for
    // "no modes configured" path the function returns the 'No modes configured'
    // message — covered by the first test above.
    //
    // For the valid-switch path, we use the integration test in
    // test/integration/router-command.test.ts which runs the full plugin
    // factory with a real tiers.json fixture.
    const cfg = makeConfig({
      modes: {
        budget: { defaultTier: "fast", description: "cheap" },
      },
    });
    const out = buildBudgetOutput(cfg, "budget");
    expect(out).toContain("Routing mode switched to");
    expect(out).toContain("budget");
  });

  it("renders overrideRules when a mode has them", () => {
    const cfg = makeConfig({
      modes: {
        quality: {
          defaultTier: "medium",
          description: "best",
          overrideRules: ["rule-a", "rule-b"],
        },
      },
    });
    const out = buildBudgetOutput(cfg, "quality");
    expect(out).toContain("Active rules:");
    expect(out).toContain("- rule-a");
    expect(out).toContain("- rule-b");
  });
});

describe("buildPresetOutput", () => {
  it("lists available presets when called with no args", () => {
    const out = buildPresetOutput(makeConfig(), "");
    expect(out).toContain("Available Presets");
    expect(out).toContain("**anthropic** <- active");
    expect(out).toContain("**openai**");
  });

  it("lists each tier with the model name (last segment after slash)", () => {
    const out = buildPresetOutput(makeConfig(), "");
    expect(out).toContain("fast: claude-haiku-4-5");
    expect(out).toContain("medium: claude-sonnet-4-6");
  });

  it("returns the 'Unknown preset' message for an unknown preset", () => {
    const out = buildPresetOutput(makeConfig(), "nonexistent");
    expect(out).toContain("Unknown preset");
    expect(out).toContain("nonexistent");
  });

  it("switches preset when called with a valid name", () => {
    const cfg = makeConfig();
    const out = buildPresetOutput(cfg, "openai");
    expect(out).toContain("Preset switched to");
    expect(out).toContain("openai");
  });

  it("resolves preset name case-insensitively", () => {
    const cfg = makeConfig();
    const out = buildPresetOutput(cfg, "Anthropic");
    expect(out).toContain("Preset switched to");
    expect(out).toContain("anthropic");
  });
});
