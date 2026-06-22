// ---------------------------------------------------------------------------
// src/plugin/hooks.ts — Hook adapter functions for the plugin runtime.
//
// Each handler is a verbatim extraction of the corresponding hook closure
// from `src/index.ts`. Bodies are unchanged — same call order, same
// fail-soft semantics, same mutations on `output`. The only mechanical
// change is that handlers take `ctx: PluginContext` as their first argument
// instead of closing over plugin-scoped locals.
//
// PR2 (Phase 3) will replace the `any` payloads with narrow runtime DTOs
// from `src/plugin/types.ts`; the present file deliberately preserves the
// pre-refactor shape so this PR is a pure extraction with zero semantic
// drift.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectNarration } from "../guard/narration";
import { formatScorecard, guardAfterCall, guardBeforeCall } from "../guard/enforce";
import { registerTierAgents } from "../router/agents";
import { registerRouterCommands } from "../router/commands";
import { assembleSystemPrompt, getActiveTiers } from "../router/protocol";
import { resolveEnforcementMode } from "../router/enforcement";
import { READ_ONLY_TOOLS } from "../router/sessions";
import { verifyTaskAfterHook } from "../verify/dispatch";
import type { PluginContext } from "./context";
import type { Preset } from "../router/config";

// ---------------------------------------------------------------------------
// chat.params — temperature override for open grader sessions.
// ---------------------------------------------------------------------------

export async function handleChatParams(
  ctx: PluginContext,
  input: any,
  output: any,
): Promise<void> {
  try {
    if (input?.sessionID && ctx.graderSessions.has(input.sessionID)) {
      output.temperature = ctx.getConfig().enforcement?.verify?.graderTemperature ?? 0;
    }
  } catch {
    // best-effort: never crash a real session
  }
}

// ---------------------------------------------------------------------------
// chat.message — register tier info and initialise trajectory scorecard.
//
// IMPORTANT: must run BEFORE system.transform so the subagent registry is
// populated when system.transform asks `sessionStore.isSubagent(sessionID)`.
// ---------------------------------------------------------------------------

export async function handleChatMessage(
  ctx: PluginContext,
  input: any,
  output: any,
): Promise<void> {
  if (ctx.state.bypassed) return;
  // Re-read cfg so /preset switches take effect without restart
  let cfg = ctx.getConfig();
  try {
    cfg = ctx.refreshConfig();
  } catch {
    // keep last known cfg if file read fails
  }
  const tierNames = Object.keys(getActiveTiers(cfg));
  ctx.sessionStore.registerFromChatMessage(input, output, cfg, tierNames);

  // Record-only: initialise a trajectory scorecard for tracked subagents.
  const sid = input?.sessionID;
  if (sid && ctx.sessionStore.isSubagent(sid)) {
    ctx.trajectoryStore.ensure(sid, input?.agent ?? null);
  }
}

// ---------------------------------------------------------------------------
// tool.execute.before — Layer 1 guard check; throws to abort when blocked.
// ---------------------------------------------------------------------------

export async function handleToolExecuteBefore(
  ctx: PluginContext,
  input: any,
  output: any,
): Promise<void> {
  if (ctx.state.bypassed) return;
  const sid = input?.sessionID;
  if (!sid || !ctx.sessionStore.isSubagent(sid) || typeof input?.tool !== "string") {
    return;
  }
  let res;
  try {
    res = guardBeforeCall({
      cfg: ctx.getConfig(),
      tier: ctx.sessionStore.getTier(sid),
      trivial: ctx.sessionStore.isTrivial(sid),
      sessionID: sid,
      tool: input.tool,
      toolArgs: output?.args,
      store: ctx.guardStore,
      env: process.env,
    });
  } catch {
    return; // never break a real session on a guard-internal error
  }
  if (res.block) {
    ctx.trajectoryStore.recordToolEvent(sid, {
      tool: input.tool,
      readOnly: READ_ONLY_TOOLS.has(input.tool),
      blocked: true,
      selfScript: res.guard === "anti_self_script",
    });
    throw new Error(res.message);
  }
}

// ---------------------------------------------------------------------------
// tool.execute.after — cap banners, changed-file tracking, verify dispatch.
// ---------------------------------------------------------------------------

export async function handleToolExecuteAfter(
  ctx: PluginContext,
  input: any,
  output: any,
): Promise<void> {
  if (ctx.state.bypassed) return;
  ctx.sessionStore.recordToolCall(input, output);

  // Record-only trajectory observation (mutates internal maps only; never
  // touches output, so emitted banners/observations stay byte-identical).
  const sid = input?.sessionID;

  // Attribute changed files to whichever session made the edit (any session).
  if (sid && typeof input?.tool === "string") {
    ctx.changedFileStore.record(sid, input.tool, input?.args);
  }

  if (sid && ctx.sessionStore.isSubagent(sid) && typeof input?.tool === "string") {
    ctx.trajectoryStore.recordToolEvent(sid, {
      tool: input.tool,
      readOnly: READ_ONLY_TOOLS.has(input.tool),
    });
    try {
      guardAfterCall({
        cfg: ctx.getConfig(),
        tier: ctx.sessionStore.getTier(sid),
        sessionID: sid,
        tool: input.tool,
        toolArgs: input?.args,
        output,
        store: ctx.guardStore,
      });
    } catch {
      // best-effort: enforcement must never crash a real session
    }
  }

  // Option (i): verify-dispatch around the built-in `task` tool (advisory-grade —
  // we observe the finished task result and append a forcing note if it is not
  // accepted; we cannot retry a task call that already finished).
  await verifyTaskAfterHook(ctx, input, output);
}

// ---------------------------------------------------------------------------
// experimental.text.complete — narration detection on completed text parts.
// ---------------------------------------------------------------------------

export async function handleTextComplete(
  ctx: PluginContext,
  _input: any,
  output: any,
): Promise<void> {
  if (ctx.state.bypassed) return;
  const text = output?.text;
  if (typeof text !== "string" || text.length < 20) return;

  const found = detectNarration(text);
  if (found.length === 0) return;

  const quoted = found
    .map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`)
    .join(", ");
  output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
}

// ---------------------------------------------------------------------------
// event (session.idle) — record-only scorecard + opt-in trajectory dump.
// ---------------------------------------------------------------------------

export async function handleSessionIdle(
  ctx: PluginContext,
  payload: any,
): Promise<void> {
  const event = payload?.event;
  if (event?.type !== "session.idle") return;
  const sid = event?.properties?.sessionID;
  if (typeof sid !== "string") return;

  // Per-delegation scorecard: only when enforcement was active (guard state exists).
  try {
    const gstate = ctx.guardStore.get(sid);
    if (gstate) {
      const line = formatScorecard(gstate, ctx.sessionStore.getTier(sid));
      const dir = join(tmpdir(), "opencode-model-router-trajectory");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sid}.scorecard.log`), line + "\n", { flag: "a" });
    }
  } catch {
    // best-effort: a scorecard must never crash a real session
  }

  // Opt-in full trajectory dump (unchanged gating).
  if (process.env.MODEL_ROUTER_TRAJECTORY_DEBUG !== "1") return;
  const dump = ctx.trajectoryStore.dump(sid);
  if (!dump) return;
  try {
    const dir = join(tmpdir(), "opencode-model-router-trajectory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.log`), dump + "\n", { flag: "a" });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// experimental.chat.system.transform — inject delegation protocol for the
// primary orchestrator only (never for tracked subagents).
// ---------------------------------------------------------------------------

export async function handleSystemTransform(
  ctx: PluginContext,
  _input: any,
  output: any,
): Promise<void> {
  if (ctx.state.bypassed) return;
  // Returns cache unless invalidated
  let cfg = ctx.getConfig();
  try {
    cfg = ctx.refreshConfig();
  } catch {
    // Use last known config if file read fails
  }

  // Skip injection for child (subagent) sessions.
  // Child sessions are detected via session.created events with a parentID.
  const sessionID = _input?.sessionID;
  if (sessionID && ctx.sessionStore.isSubagent(sessionID)) return;

  // For Claude-backed orchestrators, prepend an adversarial opener that
  // revokes the cached "Claude Code explorer" priming for the routing
  // role. Detection is by orchestrator model, not preset.
  const providerID = _input?.model?.providerID ?? "";
  const modelID = _input?.model?.modelID ?? "";
  const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;

  let enfOn = false;
  try { enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off"; } catch {}
  output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
}

// ---------------------------------------------------------------------------
// config — register tier agents and router commands at load time.
// ---------------------------------------------------------------------------

export async function handleConfig(
  ctx: PluginContext,
  activeTiersAtLoad: Preset,
  opencodeConfig: any,
): Promise<void> {
  // The config() hook runs once at plugin load time, so the load-time
  // snapshot is the right cfg here (matches the original behaviour where
  // `cfg` was initialised from loadConfig() once at factory start).
  registerTierAgents(opencodeConfig, activeTiersAtLoad, ctx.initialConfig);
  registerRouterCommands(opencodeConfig);
}
