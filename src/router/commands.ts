import type { RouterConfig } from "./config";
import { resolveEnforcementMode } from "./enforcement";
import { getActiveTiers } from "./protocol";
import {
  resolvePresetName,
  writeState,
  invalidateConfigCache,
  saveActivePreset,
  saveActiveMode,
  saveEnforcementMode,
} from "./config";

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
