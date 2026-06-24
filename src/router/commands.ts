import type { RouterConfig } from "./config";
import { resolveEnforcementMode } from "./enforcement";
import { getActiveTiers } from "./protocol";
import {
  resolvePresetName,
  saveActivePreset,
  saveActiveMode,
  saveEnforcementMode,
} from "./config";
import type { PluginContext } from "../plugin/context";

// ---------------------------------------------------------------------------
// /router command output
// ---------------------------------------------------------------------------

export function buildRouterOutput(cfg: RouterConfig, args: string): string {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  if (sub === "enforce") {
    const mode = (tokens[1] ?? "").toLowerCase();
    if (mode === "off" || mode === "advisory" || mode === "enforced") {
      saveEnforcementMode(mode);
      const desc =
        mode === "off"
          ? "Hard-block guard disabled (default routing behaviour)."
          : mode === "advisory"
            ? "Guard evaluates and surfaces banners but never hard-blocks."
            : "Guard hard-blocks subagent tool calls that violate budget / redundancy / self-script policy.";
      return [
        `Enforcement mode set to **${mode}** and persisted.`,
        "",
        desc,
        "",
        "Note: the `MODEL_ROUTER_ENFORCE` env var, when set to `0` or `1`, overrides this setting.",
      ].join("\n");
    }
    const current = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
    return [
      `Current enforcement mode: **${current}**`,
      "",
      "Usage: `/router enforce <off|advisory|enforced>`",
    ].join("\n");
  }
  const current = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
  return [
    `# Model Router`,
    `Enforcement: **${current}**`,
    "",
    "Commands:",
    "- `/router enforce <off|advisory|enforced>` — set hard-block enforcement (persisted)",
    "- `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /tiers command output
// ---------------------------------------------------------------------------

export function buildTiersOutput(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [
    `# Model Delegation Tiers`,
    `Active preset: **${cfg.activePreset}**\n`,
  ];

  for (const [name, tier] of Object.entries(tiers)) {
    const thinkingStr = tier.thinking
      ? ` | thinking: ${tier.thinking.budgetTokens} tokens`
      : tier.reasoning
        ? ` | reasoning: effort=${tier.reasoning.effort}`
        : "";
    lines.push(`## @${name} -> \`${tier.model}\`${thinkingStr}`);
    lines.push(tier.description);
    lines.push(`Steps: ${tier.steps ?? "default"}`);
    lines.push(`Use when: ${tier.whenToUse.join(", ")}\n`);
  }

  lines.push("## Delegation Rules");
  cfg.rules.forEach((r) => lines.push(`- ${r}`));
  lines.push(`\nDefault tier: @${cfg.defaultTier}`);
  lines.push(`\nAvailable presets: ${Object.keys(cfg.presets).join(", ")}`);
  lines.push(`Switch with: \`/preset <name>\``);
  lines.push(`Edit \`tiers.json\` to customize.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /budget command output
// ---------------------------------------------------------------------------

export function buildBudgetOutput(cfg: RouterConfig, args: string): string {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) {
    return 'No modes configured in tiers.json. Add a "modes" section to enable budget mode.';
  }

  const requested = args.trim().toLowerCase();
  const currentMode = cfg.activeMode || "normal";

  // No args: show current mode and available modes
  if (!requested) {
    const lines = ["# Routing Modes\n"];
    for (const [name, mode] of Object.entries(modes)) {
      const active = name === currentMode ? " <- active" : "";
      lines.push(
        `- **${name}**${active}: ${mode.description} (default tier: @${mode.defaultTier})`,
      );
    }
    lines.push(`\nSwitch with: \`/budget <mode>\``);
    return lines.join("\n");
  }

  // Switch mode
  if (modes[requested]) {
    saveActiveMode(requested);
    const mode = modes[requested];
    return [
      `Routing mode switched to **${requested}**.`,
      "",
      mode.description,
      `Default tier: @${mode.defaultTier}`,
      ...(mode.overrideRules?.length
        ? ["", "Active rules:", ...mode.overrideRules.map((r) => `- ${r}`)]
        : []),
      "",
      "Mode change takes effect immediately on the next message.",
    ].join("\n");
  }

  return `Unknown mode: "${requested}". Available: ${Object.keys(modes).join(", ")}`;
}

// ---------------------------------------------------------------------------
// /preset command output
// ---------------------------------------------------------------------------

export function buildPresetOutput(cfg: RouterConfig, args: string): string {
  const requestedPreset = args.trim();

  // No args: show available presets
  if (!requestedPreset) {
    const lines = ["# Available Presets\n"];
    for (const [name, tiers] of Object.entries(cfg.presets)) {
      const active = name === cfg.activePreset ? " <- active" : "";
      const models = Object.entries(tiers)
        .map(([tier, t]) => `${tier}: ${t.model.split("/").pop()}`)
        .join(", ");
      lines.push(`- **${name}**${active}: ${models}`);
    }
    lines.push(`\nSwitch with: \`/preset <name>\``);
    return lines.join("\n");
  }

  // Switch preset
  const resolvedPreset = resolvePresetName(cfg, requestedPreset);
  if (resolvedPreset) {
    saveActivePreset(resolvedPreset);
    cfg.activePreset = resolvedPreset;
    const tiers = cfg.presets[resolvedPreset]!;
    const models = Object.entries(tiers)
      .map(([tier, t]) => `  @${tier} -> ${t.model}`)
      .join("\n");
    return [
      `Preset switched to **${resolvedPreset}**.`,
      "",
      models,
      "",
      "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
      "Restart OpenCode for subagent model registration to take effect.",
      "System prompt delegation rules update immediately.",
    ].join("\n");
  }

  return `Unknown preset: "${requestedPreset}". Available: ${Object.keys(cfg.presets).join(", ")}`;
}

// ---------------------------------------------------------------------------
// Register router commands on the opencode config object
// ---------------------------------------------------------------------------

/**
 * Populate `opencodeConfig.command` with the router-owned command set:
 * `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`, and `/router`.
 * Mirrors the block that lived in `src/index.ts`'s `config()` hook.
 *
 * Side-effect only — the returned void matches the original inline block.
 */
export function registerRouterCommands(
  opencodeConfig: {
    command?: Record<string, { template: string; description: string }>;
  },
): void {
  opencodeConfig.command ??= {};
  opencodeConfig.command["tiers"] = {
    template: "",
    description: "Show model delegation tiers and rules",
  };
  opencodeConfig.command["preset"] = {
    template: "$ARGUMENTS",
    description: "Show or switch model presets (e.g., /preset openai)",
  };
  opencodeConfig.command["budget"] = {
    template: "$ARGUMENTS",
    description:
      "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
  };
  opencodeConfig.command["bypass"] = {
    template: "$ARGUMENTS",
    description:
      "Toggle model-router bypass (disables delegation protocol for this session)",
  };
  opencodeConfig.command["annotate-plan"] = {
    template: [
      "Annotate the plan with tier directives for model delegation.",
      "",
      'Plan file: "$ARGUMENTS"',
      "If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.",
      "",
      "## Available tiers",
      "- `[tier:fast]` — Fast/cheap model: exploration, search, file reads, grep, listing, research. Agent does NOT edit code.",
      "- `[tier:medium]` — Balanced model: implementation, refactoring, tests, code review, bug fixes, standard coding tasks.",
      "- `[tier:heavy]` — Most capable model: architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.",
      "",
      "## Annotation rules",
      "1. Place `[tier:X]` at the START of each step, before the description",
      "2. Research/exploration -> `[tier:fast]` (preferred)",
      "3. Implementation/code -> `[tier:medium]` (preferred)",
      "4. Architecture/security/hard debugging -> `[tier:heavy]`",
      "5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity",
      "6. Verification (run tests, build) -> `[tier:medium]`",
      "7. Trivial (single grep or file read) -> `[tier:fast]`",
      "8. Final review of the complete plan -> `[tier:heavy]`",
      "",
      "## Output",
      "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.",
      "",
      "## Acceptance blocks (for enforcement)",
      "For each NON-TRIVIAL task, append an acceptance block immediately after the step so the router can verify the work:",
      "[acceptance]",
      "check: <testsPass | buildPasses | lintClean | fileExists path=... | run command=\"...\" expect=...>",
      "criteria: <plain-language success condition, when no deterministic check applies>",
      "deliverable: <path or short description>",
      "[/acceptance]",
      "Prefer deterministic checks (testsPass/buildPasses/fileExists). Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block.",
    ].join("\n"),
    description:
      "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
  };
  opencodeConfig.command["router"] = {
    template: "$ARGUMENTS",
    description: "Model-router controls (e.g., /router enforce off|advisory|enforced)",
  };
}

// ---------------------------------------------------------------------------
// command.execute.before dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch handler for the `command.execute.before` hook. Pushes a text
 * part onto `output.parts` for `/tiers`, `/preset`, `/budget`, and `/router`,
 * and toggles `ctx.state.bypassed` for `/bypass`. Mirrors the block that
 * lived inline in `src/index.ts`.
 *
 * The function is async because the hook itself was async; the body performs
 * no asynchronous work (the await was structural). Errors in `refreshConfig()`
 * are swallowed (we fall back to the cached cfg) — same fail-soft semantics.
 */
export async function handleCommandBefore(
  ctx: PluginContext,
  input: { command: string; arguments?: string },
  // The SDK's `command.execute.before` output is `{ parts: Part[] }` where
  // `Part` is a discriminated union of text/reasoning/file/tool/etc. We only
  // push text parts, so a structural supertype is sufficient.
  output: { parts: Array<{ type: string; text?: string; [key: string]: unknown }> },
): Promise<void> {
  if (input.command === "tiers") {
    const cfg = ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: buildTiersOutput(cfg),
    });
  }

  if (input.command === "preset") {
    const cfg = ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: buildPresetOutput(cfg, input.arguments ?? ""),
    });
  }

  if (input.command === "bypass") {
    const arg = (input.arguments ?? "").trim().toLowerCase();
    if (arg === "on") {
      ctx.state.bypassed = true;
    } else if (arg === "off") {
      ctx.state.bypassed = false;
    } else {
      ctx.state.bypassed = !ctx.state.bypassed;
    }
    const status = ctx.state.bypassed ? "ON" : "OFF";
    const desc = ctx.state.bypassed
      ? "Model-router is **bypassed**. Delegation protocol, cap enforcement, and narration detection are disabled. The model will run without routing rules until you run `/bypass off` or restart OpenCode."
      : "Model-router is **active**. Delegation protocol and all enforcement rules are in effect.";
    output.parts.push({
      type: "text" as const,
      text: `# Bypass: ${status}\n\n${desc}`,
    });
  }

  if (input.command === "budget") {
    const cfg = ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: buildBudgetOutput(cfg, input.arguments ?? ""),
    });
  }

  if (input.command === "router") {
    const cfg = ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: buildRouterOutput(cfg, input.arguments ?? ""),
    });
  }
}
