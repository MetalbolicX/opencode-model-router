// ---------------------------------------------------------------------------
// src/plugin/hooks.ts — Hook adapter functions for the plugin runtime.
//
// Each handler is a verbatim extraction of the corresponding hook closure
// from `src/index.ts`. Bodies are unchanged — same call order, same
// fail-soft semantics, same mutations on `output`. The only mechanical
// change is that handlers take `ctx: PluginContext` as their first argument
// instead of closing over plugin-scoped locals.
//
// All hook payloads use narrow runtime DTOs from `src/plugin/types.ts`
// (`HookPayload` / `HookEventPayload`) instead of `any`.
// ---------------------------------------------------------------------------

import {
  type BeforeResult,
  formatScorecard,
  guardAfterCall,
  guardBeforeCall,
} from "../guard/enforce";
import { detectNarration } from "../guard/narration";
import { registerTierAgents } from "../router/agents";
import { registerRouterCommands } from "../router/commands";
import type { Preset } from "../router/config";
import { resolveEnforcementMode } from "../router/enforcement";
import { assembleSystemPrompt, getActiveTiers } from "../router/protocol";
import { READ_ONLY_TOOLS } from "../router/tools";
import { writeTrajectoryLog } from "../utils/log";
import { log } from "../utils/observability";
import { verifyTaskAfterHook } from "../verify/dispatch";
import type { PluginContext } from "./context";
import type { HookEventPayload, HookPayload } from "./types";
import { asChatMessageInput, asToolCallInput } from "./types";

// ---------------------------------------------------------------------------
// chat.params — temperature override for open grader sessions.
// ---------------------------------------------------------------------------

export const handleChatParams = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  try {
    const sessionID = input?.sessionID as string | undefined;
    if (sessionID && ctx.graderSessions.has(sessionID)) {
      const cfg = await ctx.getConfig();
      output.temperature = cfg.enforcement?.verify?.graderTemperature ?? 0;
    }
  } catch {
    // best-effort: never crash a real session
  }
};

// ---------------------------------------------------------------------------
// chat.message — register tier info and initialise trajectory scorecard.
//
// IMPORTANT: must run BEFORE system.transform so the subagent registry is
// populated when system.transform asks `sessionStore.isSubagent(sessionID)`.
// ---------------------------------------------------------------------------

export const handleChatMessage = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  // Re-read cfg so /preset switches take effect without restart.
  // getFreshConfig() tries a forced refresh and falls back to the cached
  // value on read failure.
  const cfg = await ctx.getFreshConfig();
  const tierNames = Object.keys(getActiveTiers(cfg));
  const chatInput = asChatMessageInput(input);
  if (!chatInput) return; // fail-soft: malformed payload
  ctx.sessionStore.registerFromChatMessage(chatInput, output, cfg, tierNames);

  // Record-only: initialise a trajectory scorecard for tracked subagents.
  const sid = chatInput.sessionID;
  if (ctx.sessionStore.isSubagent(sid)) {
    ctx.trajectoryStore.ensure(sid, chatInput.agent ?? null);
  }
};

// ---------------------------------------------------------------------------
// tool.execute.before — Layer 1 guard check; throws to abort when blocked.
// ---------------------------------------------------------------------------

export const handleToolExecuteBefore = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  const sid = input?.sessionID as string | undefined;
  const tool = input?.tool as string | undefined;
  if (!sid || !ctx.sessionStore.isSubagent(sid) || typeof tool !== "string") {
    return;
  }
  // Fail-fast nested-delegation guard: a subagent session must never call the
  // built-in `task` tool. Creating child sessions under a subagent session
  // hangs the opencode runtime permanently (see `verifyTaskAfterHook` parent
  // handling and `src/verify/dispatch.ts` for the prior debugging notes). The
  // session store tracks subagent identity but not parent/depth, so the only
  // signal we need here is `isSubagent(sid) && tool === "task"`. Blocking at
  // the before-hook keeps the unsafe path from ever creating a grandchild.
  if (tool === "task") {
    throw new Error(
      "Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task tool",
    );
  }
  let res: BeforeResult;
  try {
    const cfg = await ctx.getConfig();
    res = guardBeforeCall({
      cfg,
      tier: ctx.sessionStore.getTier(sid),
      trivial: ctx.sessionStore.isTrivial(sid),
      sessionID: sid,
      tool,
      toolArgs: output?.args as Record<string, unknown> | undefined,
      store: ctx.guardStore,
      env: process.env,
    });
  } catch {
    return; // never break a real session on a guard-internal error
  }
  if (res.block) {
    ctx.trajectoryStore.recordToolEvent(sid, {
      tool,
      readOnly: READ_ONLY_TOOLS.has(tool),
      blocked: true,
      selfScript: res.guard === "anti_self_script",
    });
    throw new Error(res.message);
  }
};

// ---------------------------------------------------------------------------
// tool.execute.after — cap banners, changed-file tracking, verify dispatch.
// ---------------------------------------------------------------------------

export const handleToolExecuteAfter = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  const toolInput = asToolCallInput(input);
  if (toolInput) {
    ctx.sessionStore.recordToolCall(toolInput, output);
  }

  // Record-only trajectory observation (mutates internal maps only; never
  // touches output, so emitted banners/observations stay byte-identical).
  const sid = input?.sessionID as string | undefined;
  const tool = input?.tool as string | undefined;

  // Attribute changed files to whichever session made the edit (any session).
  if (sid && typeof tool === "string") {
    ctx.changedFileStore.record(sid, tool, input?.args);
  }

  if (sid && ctx.sessionStore.isSubagent(sid) && typeof tool === "string") {
    ctx.trajectoryStore.recordToolEvent(sid, {
      tool,
      readOnly: READ_ONLY_TOOLS.has(tool),
    });
    try {
      const cfg = await ctx.getConfig();
      guardAfterCall({
        cfg,
        tier: ctx.sessionStore.getTier(sid),
        sessionID: sid,
        tool,
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
  //
  // Parent for grader sessions is read metadata-first from
  // `output.metadata.parentSessionId` (or `parentSessionID`) inside
  // `verifyTaskAfterHook`. We intentionally do NOT forward `sid` (the subagent
  // session id) here. Passing it as `parentSessionID` caused grader session
  // creation to hang because the SDK cannot create child sessions of subagent
  // sessions (SDD change: fix-subagent-session-hang). When the metadata field
  // is missing or malformed, `input.sessionID` MUST NEVER be substituted as
  // the grader parent — grader creation simply stays parentless instead
  // (SDD change: fix-task-verifier-session-parenting).
  await verifyTaskAfterHook(ctx, input, output);
};

// ---------------------------------------------------------------------------
// experimental.text.complete — narration detection on completed text parts.
// ---------------------------------------------------------------------------

export const handleTextComplete = async (
  ctx: PluginContext,
  _input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  const text = output?.text;
  if (typeof text !== "string" || text.length < 20) return;

  const found = detectNarration(text);
  if (found.length === 0) return;

  const quoted = found.map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`).join(", ");
  output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
};

// ---------------------------------------------------------------------------
// event (session.idle) — record-only scorecard + opt-in trajectory dump.
// ---------------------------------------------------------------------------

export const handleSessionIdle = async (
  ctx: PluginContext,
  payload: HookEventPayload,
): Promise<void> => {
  const event = payload?.event;
  if (event?.type !== "session.idle") return;
  const props = event?.properties as Record<string, unknown> | undefined;
  const sid = props?.sessionID as string | undefined;
  if (typeof sid !== "string") return;

  // Per-delegation scorecard: only when enforcement was active (guard state exists).
  try {
    const gstate = ctx.guardStore.get(sid);
    if (gstate) {
      const line = formatScorecard(gstate, ctx.sessionStore.getTier(sid));
      writeTrajectoryLog(sid, line, "scorecard");
    }
  } catch {
    // best-effort: a scorecard must never crash a real session
  }

  // Opt-in full trajectory dump (unchanged gating).
  if (process.env.MODEL_ROUTER_TRAJECTORY_DEBUG !== "1") return;
  const dump = ctx.trajectoryStore.dump(sid);
  if (!dump) return;
  writeTrajectoryLog(sid, dump);
};

// ---------------------------------------------------------------------------
// experimental.chat.system.transform — inject delegation protocol for the
// primary orchestrator only (never for tracked subagents).
// ---------------------------------------------------------------------------

export const handleSystemTransform = async (
  ctx: PluginContext,
  _input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  // getFreshConfig() returns the refreshed config and falls back to the
  // cached value if the file read fails.
  const cfg = await ctx.getFreshConfig();

  // Skip injection for child (subagent) sessions.
  // Child sessions are detected via session.created events with a parentID.
  const sessionID = _input?.sessionID as string | undefined;
  if (sessionID && ctx.sessionStore.isSubagent(sessionID)) return;

  // For Claude-backed orchestrators, prepend an adversarial opener that
  // revokes the cached "Claude Code explorer" priming for the routing
  // role. Detection is by orchestrator model, not preset.
  const model = _input?.model as { providerID?: string; modelID?: string } | undefined;
  const providerID = model?.providerID ?? "";
  const modelID = model?.modelID ?? "";
  const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;

  let enfOn = false;
  try {
    enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
  } catch (err) {
    log.warn({ event: "enforcement.resolve_failed", error: String(err) });
  }
  (output.system as string[]).push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
};

// ---------------------------------------------------------------------------
// config — register tier agents and router commands at load time.
// ---------------------------------------------------------------------------

export const handleConfig = async (
  ctx: PluginContext,
  activeTiersAtLoad: Preset,
  opencodeConfig: any,
): Promise<void> => {
  // The config() hook runs once at plugin load time, so the load-time
  // snapshot is the right cfg here (matches the original behaviour where
  // `cfg` was initialised from loadConfig() once at factory start).
  registerTierAgents(opencodeConfig, activeTiersAtLoad, ctx.initialConfig);
  registerRouterCommands(opencodeConfig);
};
