/**
 * test/integration/reasoning-runtime.test.ts
 *
 * Drives the REAL plugin factory end-to-end to prove the operator-visible
 * reasoning patch path:
 *
 *   1. /model-router-reasoning elevated (with mode: "manual") writes the override.
 *   2. The next orchestrator `task` dispatch mutates the target tier's
 *      agent def on the live `opencodeConfig`.
 *   3. The after-hook restores the captured baseline.
 *
 * This is the runtime contract that plan 012 wired up. Before plan 012
 * the patch block in `handleToolExecuteBefore` was unreachable dead code;
 * the manual override sat in the store but never reached the dispatch.
 *
 * No live models, no network. The plugin factory is the composition root
 * and the bundled `tiers.json` is loaded via the same path real sessions use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ModelRouterPlugin from "../../src/index";

// ---------------------------------------------------------------------------
// Fake PluginInput builder — mirrors `test/integration/layer2-wiring.test.ts`.
// ---------------------------------------------------------------------------

const makeCtx = (dir: string) => {
  return {
    directory: dir,
    worktree: dir,
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        create: async () => ({
          data: { id: "sess_" + Math.random().toString(36).slice(2) },
        }),
        prompt: async () => ({
          data: { parts: [{ type: "text", text: "" }] },
        }),
      },
    } as any,
  };
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Reasoning runtime wiring — operator-visible flow (plan 012)", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-runtime-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedXdg = process.env.XDG_CONFIG_HOME;
    // Redirect homedir so the global config path is empty for this run.
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    // Also redirect XDG so the persisted state file is not picked up from
    // the developer's real $HOME (which would override our local override
    // via the state overlay). The bundled tiers.json is still loaded from
    // the repo root — opencode uses the plugin's getPluginRoot() for that.
    process.env.XDG_CONFIG_HOME = dir;
    // Keep enforcement off so we don't get tangled in verify-dispatch.
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;

    // Write a local `.opencode/tiers.json` override that opts in to manual
    // mode and provides a self-contained `plan012` preset. The preset's
    // `heavy` tier has a discrete variant ladder
    // `['low','medium','high','xhigh']` with a baseline `variant: "xhigh"`;
    // the override `elevated` resolves to `"high"`, so the patch is
    // observable. Keeping the preset self-contained makes the test
    // independent of changes to the bundled `tiers.json`.
    const localCfgDir = path.join(dir, ".opencode");
    fs.mkdirSync(localCfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(localCfgDir, "tiers.json"),
      JSON.stringify({
        activePreset: "plan012",
        defaultTier: "fast",
        rules: [],
        presets: {
          plan012: {
            fast: {
              model: "openai/gpt-5.4-mini-fast",
              description: "fast tier for plan 012 test",
              whenToUse: ["read"],
            },
            heavy: {
              model: "openai/gpt-5.5-fast",
              variant: "xhigh",
              description: "heavy tier for plan 012 test",
              whenToUse: ["write"],
              capability: {
                kind: "discrete",
                field: "variant",
                levels: ["low", "medium", "high", "xhigh"],
              },
            },
          },
        },
        reasoningPolicy: { mode: "manual" },
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    if (savedUserProfile !== undefined) {
      process.env.USERPROFILE = savedUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    if (savedXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // The end-to-end contract: /model-router-reasoning → dispatch → patch → restore.
  //
  // Uses the bundled openai preset's `heavy` tier:
  //   - baseline: variant "xhigh"
  //   - capability: discrete, levels ['low','medium','high','xhigh']
  //   - override "elevated" → translateLevel → variant "high"
  // So `agentDef.variant` flips from "xhigh" to "high" during dispatch and
  // returns to "xhigh" after the after-hook restores the baseline.
  // -------------------------------------------------------------------------

  it("orchestrator task call with manual mode + /model-router-reasoning override patches the target agent at dispatch time, then restores it after", async () => {
    const hooks: any = await ModelRouterPlugin(makeCtx(dir) as any);

    // Drive the config() hook — this is the real path opencode takes during
    // plugin init. It registers tier agents and captures ctx.opencodeConfig.
    const opencodeConfig: any = { agent: {}, command: {} };
    await hooks.config(opencodeConfig);

    // Sanity: the targeted tier exists and has a non-trivial baseline.
    const tierName = "heavy";
    const tierAgentDef = opencodeConfig.agent[tierName];
    expect(tierAgentDef).toBeDefined();
    // Snapshot the baseline so we can detect mutations on the live def
    // (`opencodeConfig.agent[tierName]` is the SAME object that
    // `registerTierAgents` returns, so a reference read would mutate with
    // the patch).
    const baselineVariant = tierAgentDef.variant;
    expect(baselineVariant).toBe("xhigh");

    // Drive /model-router-reasoning elevated to write the override onto the store.
    const orchSid = "orch-sid-plan-012";
    await hooks["command.execute.before"](
      { command: "model-router-reasoning", arguments: "elevated", sessionID: orchSid },
      { parts: [] },
    );

    // Sanity: the override landed in the store (the command path is the
    // one real operators use — this is what /reasoning actually does).
    // We assert the patch was applied by checking the agent def mutated.

    // Now simulate the orchestrator task dispatch.
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: orchSid, args: { subagent_type: tierName } },
      { args: { subagent_type: tierName } },
    );

    // The patch must have flipped the variant to "high" (translateLevel
    // maps `elevated` onto the discrete ladder's 3rd position from the top
    // — levels length 4, target rank 2, rawIdx = round(2/3 * 3) = 2 → "high").
    expect(opencodeConfig.agent[tierName].variant).toBe("high");
    expect(opencodeConfig.agent[tierName].variant).not.toBe(baselineVariant);

    // Drive the after-hook — the baseline must be restored.
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: orchSid, args: { subagent_type: tierName } },
      { output: "ok", metadata: {} },
    );

    expect(opencodeConfig.agent[tierName].variant).toBe(baselineVariant);
    expect(opencodeConfig.agent[tierName].variant).toBe("xhigh");
  });

  it("static mode is a hard no-op: the override is stored but never reaches the agent def", async () => {
    // Override the local config to flip the policy back to static for this case.
    fs.writeFileSync(
      path.join(dir, ".opencode", "tiers.json"),
      JSON.stringify({
        activePreset: "plan012",
        defaultTier: "fast",
        rules: [],
        presets: {
          plan012: {
            fast: {
              model: "openai/gpt-5.4-mini-fast",
              description: "fast tier for plan 012 test",
              whenToUse: ["read"],
            },
            heavy: {
              model: "openai/gpt-5.5-fast",
              variant: "xhigh",
              description: "heavy tier for plan 012 test",
              whenToUse: ["write"],
              capability: {
                kind: "discrete",
                field: "variant",
                levels: ["low", "medium", "high", "xhigh"],
              },
            },
          },
        },
        reasoningPolicy: { mode: "static" },
      }),
      "utf-8",
    );

    const hooks: any = await ModelRouterPlugin(makeCtx(dir) as any);
    const opencodeConfig: any = { agent: {}, command: {} };
    await hooks.config(opencodeConfig);

    const tierName = "heavy";
    const baselineVariant = opencodeConfig.agent[tierName].variant;
    expect(baselineVariant).toBe("xhigh");

    // /model-router-reasoning in static mode writes the override but the runtime
    // does not apply it at task dispatch (policy mode is a runtime concern).
    const orchSid = "orch-sid-static";
    const cmdOutput: { parts: any[] } = { parts: [] };
    await hooks["command.execute.before"](
      { command: "model-router-reasoning", arguments: "elevated", sessionID: orchSid },
      cmdOutput,
    );
    expect(cmdOutput.parts[0].text).toContain("Reasoning override set to **elevated**");

    // Dispatch a task — the patch block must be a no-op because resolveReasoningOverride
    // returns null for static mode.
    await hooks["tool.execute.before"](
      { tool: "task", sessionID: orchSid, args: { subagent_type: tierName } },
      { args: { subagent_type: tierName } },
    );

    expect(opencodeConfig.agent[tierName].variant).toBe(baselineVariant);
  });
});
