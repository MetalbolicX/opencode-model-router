import type { PluginContext } from "../plugin/context";
import type { ReasoningCapability, ReasoningLevel } from "../reasoning/capability.js";
import { inferCapability } from "../reasoning/capability.js";
import { translateLevel } from "../reasoning/translate.js";
import type { RouterConfig } from "./config";
import { resolvePresetName, saveActiveMode, saveActivePreset, saveEnforcementMode } from "./config";
import { resolveEnforcementMode } from "./enforcement";
import { getActiveTiers } from "./protocol";

const REASONING_LEVELS: ReadonlySet<ReasoningLevel> = new Set([
  "minimal",
  "normal",
  "elevated",
  "max",
]);

// ---------------------------------------------------------------------------
// /router command output
// ---------------------------------------------------------------------------

export const buildRouterOutput = async (cfg: RouterConfig, args: string): Promise<string> => {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  if (sub === "enforce") {
    const mode = (tokens[1] ?? "").toLowerCase();
    if (mode === "off" || mode === "advisory" || mode === "enforced") {
      await saveEnforcementMode(mode);
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
};

// ---------------------------------------------------------------------------
// /tiers command output
// ---------------------------------------------------------------------------

export const buildTiersOutput = (cfg: RouterConfig): string => {
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [`# Model Delegation Tiers`, `Active preset: **${cfg.activePreset}**\n`];

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
  for (const r of cfg.rules) lines.push(`- ${r}`);
  lines.push(`\nDefault tier: @${cfg.defaultTier}`);
  lines.push(`\nAvailable presets: ${Object.keys(cfg.presets).join(", ")}`);
  lines.push(`Switch with: \`/preset <name>\``);
  lines.push(`Edit \`tiers.json\` to customize.`);

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// /budget command output
// ---------------------------------------------------------------------------

export const buildBudgetOutput = async (cfg: RouterConfig, args: string): Promise<string> => {
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
    await saveActiveMode(requested);
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
};

// ---------------------------------------------------------------------------
// /preset command output
// ---------------------------------------------------------------------------

export const buildPresetOutput = async (cfg: RouterConfig, args: string): Promise<string> => {
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
    await saveActivePreset(resolvedPreset);
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
};

// ---------------------------------------------------------------------------
// /reasoning command output (PR 2 of adaptive-reasoning).
//
// Validates the argument against the 4 normalized levels (or `off`), sets /
// clears the per-session override on `ctx.reasoningStore`, and returns a
// confirmation that names the targeted tier's capability and whether the
// level actually applies or collapses onto a coarser rung.
//
// Honors `reasoningPolicy.surfaceLimits`: when true, emits an advisory note
// describing any collapse (e.g. `normal` and `elevated` both mapping to
// `medium` on a 3-level discrete ladder — documented quirk of the
// `Math.round(rank/3 * (len-1))` formula in PR 1). Defaults to silent no-op.
// ---------------------------------------------------------------------------

/**
 * Describe a tier's capability in plain English for the command output.
 * Compact form: the tier name + the kind + a one-line hint about what it
 * can satisfy.
 */
const describeCapability = (tierName: string, cap: ReasoningCapability): string => {
  switch (cap.kind) {
    case "none":
      return `@${tierName}: no reasoning control (the tier is left as-is).`;
    case "binary":
      return `@${tierName}: binary variant (elevated: ${cap.elevated}${cap.baseline ? `, baseline: ${cap.baseline}` : ""}).`;
    case "discrete": {
      const channel = cap.field === "variant" ? "variant" : "reasoning_effort";
      return `@${tierName}: discrete ${channel} ladder [${cap.levels.join(" < ")}].`;
    }
    case "budgeted":
      return `@${tierName}: budgeted (thinking tokens per level: ${Object.entries(cap.recommended)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}).`;
  }
};

/**
 * Detect when a discrete-ladder translation collapses two requested levels
 * onto the same rung (the documented `Math.round(rank/3 * (len-1))` quirk
 * for 3-level ladders: normal + elevated both map to index 1 = medium).
 *
 * Returns a one-line advisory note when a collapse happened, or `undefined`
 * when every requested level maps to a distinct rung.
 */
const detectCollapse = (cap: ReasoningCapability, level: ReasoningLevel): string | undefined => {
  if (cap.kind !== "discrete") return undefined;
  // Compare the resolved patch for `level` against the resolved patch for
  // the level one rank below. If they're equal, the requested level has
  // collapsed onto a coarser rung.
  const RANK: Record<ReasoningLevel, number> = { minimal: 0, normal: 1, elevated: 2, max: 3 };
  const rank = RANK[level];
  if (rank <= 0) return undefined;
  const lower = (Object.keys(RANK) as ReasoningLevel[]).find((k) => RANK[k] === rank - 1);
  if (!lower) return undefined;
  const here = translateLevel(cap, level);
  const below = translateLevel(cap, lower);
  if (!here || !below) return undefined;
  // Compare the patch payload — same channel output means collapse.
  if (here.variant !== undefined && here.variant === below.variant) {
    return `Note: '${level}' collapses to '${here.variant}' (same as '${lower}') on this tier's ladder — surface the limit by enabling reasoningPolicy.surfaceLimits.`;
  }
  if (here.options && below.options) {
    if (JSON.stringify(here.options) === JSON.stringify(below.options)) {
      const key = Object.keys(here.options)[0] ?? "";
      return `Note: '${level}' collapses onto '${lower}' for this tier (${key}=${here.options[key]}).`;
    }
  }
  return undefined;
};

export const buildReasoningOutput = async (
  cfg: RouterConfig,
  args: string,
  ctx: PluginContext,
  sessionID: string,
): Promise<string> => {
  const surfaceLimits = cfg.reasoningPolicy?.surfaceLimits === true;
  const policyMode = cfg.reasoningPolicy?.mode ?? "static";

  const arg = (args ?? "").trim().toLowerCase();

  // Show help when no args — describe every active tier's capability.
  if (!arg) {
    const tiers = getActiveTiers(cfg);
    const lines: string[] = [
      `# Reasoning Overrides`,
      `Policy mode: **${policyMode}** (surfaceLimits: ${surfaceLimits ? "on" : "off"})`,
      "",
    ];
    for (const [name, tier] of Object.entries(tiers)) {
      const cap = tier.capability ?? inferCapability(tier);
      lines.push(describeCapability(name, cap));
    }
    lines.push(
      "",
      "Set with: `/reasoning minimal|normal|elevated|max`. Clear with `/reasoning off`.",
      "Applies to the next `task` dispatch in this session only.",
    );
    return lines.join("\n");
  }

  if (arg === "off") {
    if (sessionID) ctx.reasoningStore.clearOverride(sessionID);
    return [
      "Reasoning override cleared.",
      "",
      "Next task dispatches in this session will use the tier's baseline reasoning.",
    ].join("\n");
  }

  if (!REASONING_LEVELS.has(arg as ReasoningLevel)) {
    return `Unknown level: "${arg}". Use one of: minimal, normal, elevated, max (or "off" to clear).`;
  }

  if (policyMode === "static") {
    return [
      `Requested level: **${arg}**`,
      "",
      `Reasoning policy mode is **static** — the override will NOT be applied at task dispatch.`,
      "Set `reasoningPolicy.mode` to `manual` in `tiers.json` to enable per-session overrides.",
    ].join("\n");
  }

  if (sessionID) ctx.reasoningStore.setOverride(sessionID, arg as ReasoningLevel);

  // Per-tier acknowledgement: which tiers can actually satisfy the level,
  // which collapse, and which can't (none capability → silent no-op unless
  // surfaceLimits is enabled).
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [
    `Reasoning override set to **${arg}** for this session.`,
    "",
    "Per-tier behaviour:",
  ];
  let anyCollapse = false;
  for (const [name, tier] of Object.entries(tiers)) {
    const cap = tier.capability ?? inferCapability(tier);
    if (cap.kind === "none") {
      if (surfaceLimits) lines.push(`- @${name}: unsupported (no reasoning control).`);
      continue;
    }
    const resolved = translateLevel(cap, arg as ReasoningLevel);
    if (!resolved) {
      if (surfaceLimits) {
        lines.push(`- @${name}: level '${arg}' is a no-op for this tier's capability.`);
      }
      continue;
    }
    if (resolved.variant !== undefined) {
      lines.push(`- @${name}: variant = '${resolved.variant}'.`);
    }
    if (resolved.options) {
      lines.push(`- @${name}: options = ${JSON.stringify(resolved.options)}.`);
    }
    const note = detectCollapse(cap, arg as ReasoningLevel);
    if (note) {
      anyCollapse = true;
      if (surfaceLimits) lines.push(`  ${note}`);
    }
  }
  if (anyCollapse && !surfaceLimits) {
    lines.push(
      "",
      "(One or more tiers collapse this level onto a coarser rung. Enable `reasoningPolicy.surfaceLimits` to see which.)",
    );
  }
  lines.push("", "Takes effect on the next `task` dispatch in this session.");
  return lines.join("\n");
};

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
export const registerRouterCommands = (opencodeConfig: {
  command?: Record<string, { template: string; description: string }>;
}): void => {
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
    description: "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
  };
  opencodeConfig.command["bypass"] = {
    template: "$ARGUMENTS",
    description: "Toggle model-router bypass (disables delegation protocol for this session)",
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
      'check: <testsPass | buildPasses | lintClean | fileExists path=... | run command="..." expect=...>',
      "criteria: <plain-language success condition, when no deterministic check applies>",
      "deliverable: <path or short description>",
      "[/acceptance]",
      "Prefer deterministic checks (testsPass/buildPasses/fileExists). Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block.",
    ].join("\n"),
    description: "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
  };
  opencodeConfig.command["router"] = {
    template: "$ARGUMENTS",
    description: "Model-router controls (e.g., /router enforce off|advisory|enforced)",
  };
  opencodeConfig.command["reasoning"] = {
    template: "$ARGUMENTS",
    description:
      "Set reasoning level: /reasoning minimal|normal|elevated|max (set) | /reasoning off (clear)",
  };
};

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
export const handleCommandBefore = async (
  ctx: PluginContext,
  input: { command: string; arguments?: string; sessionID?: string },
  // The SDK's `command.execute.before` output is `{ parts: Part[] }` where
  // `Part` is a discriminated union of text/reasoning/file/tool/etc. We only
  // push text parts, so a structural supertype is sufficient.
  output: { parts: Array<{ type: string; text?: string; [key: string]: unknown }> },
): Promise<void> => {
  if (input.command === "tiers") {
    const cfg = await ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: buildTiersOutput(cfg),
    });
  }

  if (input.command === "preset") {
    const cfg = await ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: await buildPresetOutput(cfg, input.arguments ?? ""),
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
    const cfg = await ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: await buildBudgetOutput(cfg, input.arguments ?? ""),
    });
  }

  if (input.command === "router") {
    const cfg = await ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: await buildRouterOutput(cfg, input.arguments ?? ""),
    });
  }

  if (input.command === "reasoning") {
    const cfg = await ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: await buildReasoningOutput(cfg, input.arguments ?? "", ctx, input.sessionID ?? ""),
    });
  }
};
