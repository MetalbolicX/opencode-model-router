import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "../../src/plugin/context";
import { createReasoningStore } from "../../src/reasoning/store";
import {
  buildBudgetOutput,
  buildPresetOutput,
  buildReasoningOutput,
  buildRouterOutput,
  buildTiersOutput,
  handleCommandBefore,
} from "../../src/router/commands";
import type { Preset, RouterConfig, TierConfig } from "../../src/router/config";
import { readState } from "../../src/router/config";

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origXDG_CONFIG_HOME: string | undefined;
const savedEnvGate = process.env["MODEL_ROUTER_ENFORCE"];

beforeEach(async () => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origXDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
  tmpHome = join(
    tmpdir(),
    `oc-test-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  // Tests must exercise the legacy `$HOME/.config/...` fallback so they
  // do not leak across users who have `XDG_CONFIG_HOME` set globally.
  delete process.env["XDG_CONFIG_HOME"];
  delete process.env["MODEL_ROUTER_ENFORCE"];
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

afterEach(async () => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  if (origXDG_CONFIG_HOME === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = origXDG_CONFIG_HOME;
  if (savedEnvGate === undefined) delete process.env["MODEL_ROUTER_ENFORCE"];
  else process.env["MODEL_ROUTER_ENFORCE"] = savedEnvGate;
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

/** Build a minimal RouterConfig with two presets and one mode for the unit tests. */
const makeConfig = (extra: Partial<RouterConfig> = {}): RouterConfig => {
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
};

describe("buildRouterOutput", () => {
  it("bare /router shows status", async () => {
    const out = await buildRouterOutput(makeConfig(), "");
    expect(out).toContain("# Model Router");
    expect(out).toContain("Enforcement:");
    expect(out).toContain("/tiers");
    expect(out).toContain("/router enforce");
  });

  it("/router with non-enforce sub shows status", async () => {
    const out = await buildRouterOutput(makeConfig(), "status");
    expect(out).toContain("# Model Router");
    expect(out).not.toContain("Usage:");
  });

  it("/router enforce <valid> persists and returns description", async () => {
    const out = await buildRouterOutput(makeConfig(), "enforce enforced");
    expect(out).toContain("enforced");
    expect(out).toContain("persisted");
    expect(out).toContain("Guard hard-blocks");
  });

  it("/router enforce off returns off description", async () => {
    const out = await buildRouterOutput(makeConfig(), "enforce off");
    expect(out).toContain("off");
    expect(out).toContain("disabled");
  });

  it("/router enforce advisory returns advisory description", async () => {
    const out = await buildRouterOutput(makeConfig(), "enforce advisory");
    expect(out).toContain("advisory");
    expect(out).toContain("never hard-blocks");
  });

  it("/router enforce with no mode shows current + usage", async () => {
    const out = await buildRouterOutput(makeConfig(), "enforce");
    expect(out).toContain("Usage:");
    expect(out).toContain("Current enforcement mode");
  });

  it("/router enforce with invalid mode shows usage", async () => {
    const out = await buildRouterOutput(makeConfig(), "enforce loud");
    expect(out).toContain("Usage:");
  });

  it("/router enforce ignores extra whitespace in args", async () => {
    const out = await buildRouterOutput(makeConfig(), "  enforce   off  ");
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
  it("returns a usage message when no modes are configured", async () => {
    const out = await buildBudgetOutput(makeConfig(), "");
    expect(out).toContain("No modes configured");
  });

  it("lists available modes when called with no args", async () => {
    const cfg = makeConfig({
      modes: {
        budget: { defaultTier: "fast", description: "cheap" },
        quality: { defaultTier: "medium", description: "best" },
      },
      activeMode: "quality",
    });
    const out = await buildBudgetOutput(cfg, "");
    expect(out).toContain("Routing Modes");
    expect(out).toContain("**budget**");
    expect(out).toContain("**quality** <- active");
  });

  it("returns the 'Unknown mode' message for an unknown mode", async () => {
    const cfg = makeConfig({
      modes: {
        budget: { defaultTier: "fast", description: "cheap" },
      },
    });
    const out = await buildBudgetOutput(cfg, "unknown-mode");
    expect(out).toContain("Unknown mode");
    expect(out).toContain("unknown-mode");
  });

  it("switches mode when called with a valid mode name", async () => {
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
    const out = await buildBudgetOutput(cfg, "budget");
    expect(out).toContain("Routing mode switched to");
    expect(out).toContain("budget");
  });

  it("renders overrideRules when a mode has them", async () => {
    const cfg = makeConfig({
      modes: {
        quality: {
          defaultTier: "medium",
          description: "best",
          overrideRules: ["rule-a", "rule-b"],
        },
      },
    });
    const out = await buildBudgetOutput(cfg, "quality");
    expect(out).toContain("Active rules:");
    expect(out).toContain("- rule-a");
    expect(out).toContain("- rule-b");
  });
});

describe("buildPresetOutput", () => {
  it("lists available presets when called with no args", async () => {
    const out = await buildPresetOutput(makeConfig(), "");
    expect(out).toContain("Available Presets");
    expect(out).toContain("**anthropic** <- active");
    expect(out).toContain("**openai**");
  });

  it("lists each tier with the model name (last segment after slash)", async () => {
    const out = await buildPresetOutput(makeConfig(), "");
    expect(out).toContain("fast: claude-haiku-4-5");
    expect(out).toContain("medium: claude-sonnet-4-6");
  });

  it("returns the 'Unknown preset' message for an unknown preset", async () => {
    const out = await buildPresetOutput(makeConfig(), "nonexistent");
    expect(out).toContain("Unknown preset");
    expect(out).toContain("nonexistent");
  });

  it("switches preset when called with a valid name", async () => {
    const cfg = makeConfig();
    const out = await buildPresetOutput(cfg, "openai");
    expect(out).toContain("Preset switched to");
    expect(out).toContain("openai");
  });

  it("resolves preset name case-insensitively", async () => {
    const cfg = makeConfig();
    const out = await buildPresetOutput(cfg, "Anthropic");
    expect(out).toContain("Preset switched to");
    expect(out).toContain("anthropic");
  });

  it("does not mutate the cfg argument after switching preset", async () => {
    const cfg = makeConfig();
    const before = cfg.activePreset;
    await buildPresetOutput(cfg, "openai");
    expect(cfg.activePreset).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// buildReasoningOutput (PR 2 of adaptive-reasoning)
// ---------------------------------------------------------------------------

const makeReasoningCtx = (cfg: RouterConfig, sid = "sess-test"): PluginContext =>
  ({
    plugin: { directory: tmpHome, client: {} as any } as any,
    initialConfig: cfg,
    activeTiersAtLoad: cfg.presets[cfg.activePreset]!,
    getConfig: async () => cfg,
    refreshConfig: async () => cfg,
    getFreshConfig: async () => cfg,
    dispose: async () => {},
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore: {} as any,
    trajectoryStore: {} as any,
    guardStore: {} as any,
    changedFileStore: {} as any,
    reasoningStore: createReasoningStore(),
    graderSessions: new Set<string>(),
    verifyMutex: {} as any,
    seams: { exec: {} as any, fs: {} as any },
  }) as PluginContext;

describe("buildReasoningOutput", () => {
  it("describes every active tier when called with no args", async () => {
    const cfg = makeConfig({
      reasoningPolicy: { mode: "manual", surfaceLimits: false },
    });
    const out = await buildReasoningOutput(cfg, "", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("# Reasoning Overrides");
    expect(out).toContain("Policy mode: **manual**");
    expect(out).toContain("surfaceLimits: off");
    // Every tier in the anthropic preset (fast + medium) is listed.
    expect(out).toContain("@fast");
    expect(out).toContain("@medium");
  });

  it("/reasoning off clears any existing override", async () => {
    const cfg = makeConfig({
      reasoningPolicy: { mode: "manual" },
    });
    const ctx = makeReasoningCtx(cfg);
    ctx.reasoningStore.setOverride("sess-1", "elevated");
    expect(ctx.reasoningStore.getOverride("sess-1")).toBe("elevated");
    const out = await buildReasoningOutput(cfg, "off", ctx, "sess-1");
    expect(out).toContain("Reasoning override cleared");
    expect(ctx.reasoningStore.getOverride("sess-1")).toBeUndefined();
  });

  it("invalid levels are rejected with a helpful usage message", async () => {
    const cfg = makeConfig({
      reasoningPolicy: { mode: "manual" },
    });
    const out = await buildReasoningOutput(cfg, "ultra", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Unknown level");
    expect(out).toContain("ultra");
    expect(out).toContain("minimal");
    expect(out).toContain("max");
  });

  it("static mode still writes the override; the runtime decides whether to apply it", async () => {
    // The "edit tiers.json" redirect was removed in favour of the `mode`
    // subcommand. The override is now stored regardless of the current
    // policy mode; the runtime honors `mode === "manual"` at task dispatch.
    const cfg = makeConfig({ reasoningPolicy: { mode: "static" } });
    const ctx = makeReasoningCtx(cfg);
    const out = await buildReasoningOutput(cfg, "elevated", ctx, "sess-1");
    expect(out).toContain("Reasoning override set to **elevated**");
    expect(out).not.toContain("will NOT be applied");
    expect(ctx.reasoningStore.getOverride("sess-1")).toBe("elevated");
  });

  it("manual mode writes the override onto the store", async () => {
    const cfg = makeConfig({
      reasoningPolicy: { mode: "manual" },
    });
    const ctx = makeReasoningCtx(cfg);
    await buildReasoningOutput(cfg, "max", ctx, "sess-1");
    expect(ctx.reasoningStore.getOverride("sess-1")).toBe("max");
  });

  it("two sessions are isolated — one session's override does not affect another", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const ctx = makeReasoningCtx(cfg);
    await buildReasoningOutput(cfg, "max", ctx, "sess-A");
    await buildReasoningOutput(cfg, "minimal", ctx, "sess-B");
    expect(ctx.reasoningStore.getOverride("sess-A")).toBe("max");
    expect(ctx.reasoningStore.getOverride("sess-B")).toBe("minimal");
    await buildReasoningOutput(cfg, "off", ctx, "sess-A");
    expect(ctx.reasoningStore.getOverride("sess-A")).toBeUndefined();
    expect(ctx.reasoningStore.getOverride("sess-B")).toBe("minimal");
  });

  it("surfaceLimits:true emits a per-tier patch breakdown (binary capability)", async () => {
    const cfg = makeConfig({
      reasoningPolicy: { mode: "manual", surfaceLimits: true },
    });
    cfg.presets.anthropic.medium = {
      model: "minimax/MiniMax-M3",
      description: "M",
      steps: 50,
      whenToUse: ["impl"],
      variant: "thinking",
    } as TierConfig;
    const out = await buildReasoningOutput(cfg, "elevated", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Per-tier behaviour:");
    expect(out).toContain("@medium");
    expect(out).toContain("variant = 'thinking'");
  });

  it("surfaceLimits:false keeps the per-tier breakdown but skips collapse notes", async () => {
    const cfg = makeConfig({
      reasoningPolicy: { mode: "manual", surfaceLimits: false },
    });
    cfg.presets.anthropic.fast = {
      model: "openai/gpt-5.4-mini-fast",
      description: "Mini",
      steps: 30,
      whenToUse: ["recon"],
      reasoning: { effort: "high" },
    } as TierConfig;
    const out = await buildReasoningOutput(cfg, "elevated", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Per-tier behaviour:");
    // Per-tier line must still mention reasoning_effort (this tier can satisfy).
    expect(out).toContain("reasoning_effort");
  });

  it("handles an empty sessionID gracefully (does not throw, does not write)", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const ctx = makeReasoningCtx(cfg, "");
    const out = await buildReasoningOutput(cfg, "max", ctx, "");
    // No throw. The override write is silently skipped because sessionID is "".
    expect(out).toContain("Reasoning override set to **max**");
    expect(ctx.reasoningStore.getOverride("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildReasoningOutput — `mode` subcommand (PR 2 of model-router-reasoning-mode-switch)
//
// The mode subcommand persists the reasoning policy mode via saveReasoningMode().
// `adaptive` is explicitly rejected as not-implemented. With no mode argument
// the command reports the current effective mode and usage.
// ---------------------------------------------------------------------------

describe("buildReasoningOutput — `mode` subcommand", () => {
  it("`mode` (no arg) shows current mode + usage for static and manual + adaptive note", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const out = await buildReasoningOutput(cfg, "mode", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Current reasoning policy mode: **manual**");
    expect(out).toContain("Usage: `/model-router-reasoning mode <static|manual>`");
    expect(out).toContain("`static`");
    expect(out).toContain("`manual`");
    expect(out).toContain("adaptive");
    expect(out).toContain("not implemented");
  });

  it("`mode` (no arg) reports the default 'static' when no policy is configured", async () => {
    const cfg = makeConfig();
    const out = await buildReasoningOutput(cfg, "mode", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Current reasoning policy mode: **static**");
  });

  it("`mode static` persists and reports the static description", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const out = await buildReasoningOutput(cfg, "mode static", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Reasoning policy mode set to **static** and persisted");
    expect(out).toContain("Per-tier defaults");
    const state = await readState();
    expect(state.reasoningMode).toBe("static");
  });

  it("`mode manual` persists and reports the manual description", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "static" } });
    const out = await buildReasoningOutput(cfg, "mode manual", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Reasoning policy mode set to **manual** and persisted");
    expect(out).toContain("Per-session overrides are enabled");
    const state = await readState();
    expect(state.reasoningMode).toBe("manual");
  });

  it("`mode adaptive` is rejected clearly as not implemented", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "static" } });
    const out = await buildReasoningOutput(cfg, "mode adaptive", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("adaptive");
    expect(out).toContain("not implemented");
    // Verify no state was written — adaptive must not leak into the overlay.
    const state = await readState();
    expect(state.reasoningMode).toBeUndefined();
  });

  it("`mode <unknown>` is rejected with a clear error", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const out = await buildReasoningOutput(cfg, "mode foo", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Unknown mode");
    expect(out).toContain("foo");
  });

  it("help text (no args) documents the `mode` subcommand", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const out = await buildReasoningOutput(cfg, "", makeReasoningCtx(cfg), "sess-1");
    expect(out).toContain("Switch persisted policy mode");
    expect(out).toContain("/model-router-reasoning mode <static|manual>");
  });
});

// ---------------------------------------------------------------------------
// handleCommandBefore — /model-router-reasoning branch (PR 2 of model-router-reasoning-mode-switch)
// ---------------------------------------------------------------------------

describe("handleCommandBefore — /model-router-reasoning branch", () => {
  it("pushes a text part for the /model-router-reasoning command (level override)", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const ctx = makeReasoningCtx(cfg);
    const output: { parts: any[] } = { parts: [] };
    await handleCommandBefore(
      ctx,
      { command: "model-router-reasoning", arguments: "elevated", sessionID: "sess-cmd" },
      output,
    );
    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].type).toBe("text");
    expect(output.parts[0].text).toContain("Reasoning override set to **elevated**");
    expect(ctx.reasoningStore.getOverride("sess-cmd")).toBe("elevated");
  });

  it("/model-router-reasoning with no args shows the capability summary", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const ctx = makeReasoningCtx(cfg);
    const output: { parts: any[] } = { parts: [] };
    await handleCommandBefore(
      ctx,
      { command: "model-router-reasoning", sessionID: "sess-cmd" },
      output,
    );
    expect(output.parts[0].text).toContain("# Reasoning Overrides");
  });

  it("/model-router-reasoning mode static dispatches and persists", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "manual" } });
    const ctx = makeReasoningCtx(cfg);
    const output: { parts: any[] } = { parts: [] };
    await handleCommandBefore(
      ctx,
      { command: "model-router-reasoning", arguments: "mode static", sessionID: "sess-cmd" },
      output,
    );
    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain("Reasoning policy mode set to **static** and persisted");
    const state = await readState();
    expect(state.reasoningMode).toBe("static");
  });

  it("/model-router-reasoning mode adaptive dispatches and is rejected", async () => {
    const cfg = makeConfig({ reasoningPolicy: { mode: "static" } });
    const ctx = makeReasoningCtx(cfg);
    const output: { parts: any[] } = { parts: [] };
    await handleCommandBefore(
      ctx,
      { command: "model-router-reasoning", arguments: "mode adaptive", sessionID: "sess-cmd" },
      output,
    );
    expect(output.parts[0].text).toContain("not implemented");
    const state = await readState();
    expect(state.reasoningMode).toBeUndefined();
  });
});
