/**
 * src/verify/dispatch.ts — Layer-2 wiring helpers shared by the two wirings
 * (Option (i) verify-dispatch around the built-in `task` tool, and Option (ii)
 * the plugin-owned `delegate` tool).
 *
 * Pure section: DoD helpers, task-result parser, model resolver, gate
 * predicates, and forcing-note / accepted-suffix builders. No fs/network/SDK.
 *
 * Adapter section (Slice 3): `dispatchGrader`, `buildGateDeps`, and
 * `verifyTaskAfterHook` — these read live state from `PluginContext`
 * (`ctx.getConfig()`, `ctx.seams`, `ctx.verifyMutex`, `ctx.changedFileStore`,
 * `ctx.sessionStore`, `ctx.graderSessions`) but stay side-effect-free against
 * the module itself; their only external side-effects are the SDK calls
 * (`ctx.plugin.client.session.*`) that the original index.ts already made.
 */

import { scrubText } from "../guard/scrub";
import type { PluginContext } from "../plugin/context";
import {
  asTaskToolArgs,
  extractPromptText,
  extractSessionId,
  type SessionCreateResult,
  type SessionPromptResult,
} from "../plugin/types";
import type { RouterConfig } from "../router/config";
import { resolveEnforcementMode } from "../router/enforcement";
import { getActiveTiers } from "../router/protocol";
import { WRITE_TOOLS } from "../router/tools";
import { logEvent } from "../utils/observability";
import { resolveTierModelGuard } from "../utils/tier-model-guard";
import { withTimeout } from "../utils/timeout";
import { showRouterToast } from "../utils/toast";
import type { DoD, InferHints } from "./dod";
import { inferDoD, parseDoDFromDispatch } from "./dod";
import type { GateDeps } from "./gate";
import { accept } from "./gate";

export interface ChangedFile {
  path: string;
  status: string;
}

/** Derive a {path,status} record from a write/edit tool call, or null. */
export const extractChangedFile = (tool: string, args: unknown): ChangedFile | null => {
  if (!WRITE_TOOLS.has(tool)) return null;
  const a = (args ?? {}) as Record<string, unknown>;
  const path =
    typeof a.filePath === "string"
      ? a.filePath
      : typeof a.path === "string"
        ? a.path
        : typeof a.file === "string"
          ? a.file
          : "";
  if (!path) return null;
  const status = tool === "write" ? "written" : "modified";
  return { path, status };
};

/**
 * Per-session changed-file tracker. We attribute changed files to a delegation
 * by observing that session's own edit/write tool calls (ADR 0002 D3 — NOT a
 * global git diff), which is concurrency-safe under interleaved subagents.
 */
export const createChangedFileStore = () => {
  const bySession = new Map<string, Map<string, string>>();
  return {
    record(sessionID: string, tool: string, args: unknown): void {
      const cf = extractChangedFile(tool, args);
      if (!cf) return;
      let m = bySession.get(sessionID);
      if (!m) {
        m = new Map();
        bySession.set(sessionID, m);
      }
      // "written" (created) is stickier than a later "modified".
      const prev = m.get(cf.path);
      m.set(cf.path, prev === "written" ? "written" : cf.status);
    },
    get(sessionID: string): ChangedFile[] {
      const m = bySession.get(sessionID);
      if (!m) return [];
      return [...m.entries()].map(([path, status]) => ({ path, status }));
    },
    clear(sessionID: string): void {
      bySession.delete(sessionID);
    },
  };
};

const TASK_RESULT_RE = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/i;

/**
 * Parsed shape of the built-in `task` tool's after-hook output.
 *
 * - `finalReturnText`: the child's final return (extracted from
 *   `<task_result>...</task_result>` when present, otherwise the whole output).
 * - `childSessionID`: the producer subagent session id, taken from
 *   `output.metadata.sessionId` (or `sessionID`).
 * - `parentSessionID`: the orchestrator/root session id, taken from
 *   `output.metadata.parentSessionId` (or `parentSessionID`). This is the
 *   metadata-first source of truth for grader session parenting in the
 *   verify-after-task path — NEVER the subagent `input.sessionID`.
 */
export interface ParsedTaskResult {
  finalReturnText: string;
  childSessionID: string | null;
  parentSessionID: string | null;
}

/**
 * Parse the built-in `task` tool's after-hook output: the child's final return
 * is wrapped in <task_result>...</task_result> and the child session id lives in
 * output.metadata.sessionId (spike capability C). The orchestrator/root session
 * id, when present, lives in output.metadata.parentSessionId and is returned as
 * `parentSessionID` (SDD change: fix-task-verifier-session-parenting).
 */
export const parseTaskResult = (output: unknown): ParsedTaskResult => {
  const o = (output ?? {}) as Record<string, unknown>;
  const raw = typeof o.output === "string" ? o.output : "";
  const m = raw.match(TASK_RESULT_RE);
  const finalReturnText = (m ? m[1] : raw).trim();
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const childSessionID =
    typeof meta.sessionId === "string"
      ? meta.sessionId
      : typeof meta.sessionID === "string"
        ? meta.sessionID
        : null;
  const parentSessionID =
    typeof meta.parentSessionId === "string"
      ? meta.parentSessionId
      : typeof meta.parentSessionID === "string"
        ? meta.parentSessionID
        : null;
  return { finalReturnText, childSessionID, parentSessionID };
};

/**
 * Build the DoD for a delegation from its dispatch text: an explicit
 * [acceptance] block wins; otherwise auto-infer a minimal, non-vacuous DoD
 * (M2 default). `acceptance` (if provided) is parsed for the block first.
 */
export const buildDelegationDoD = (
  args: { prompt?: string; description?: string; acceptance?: string },
  hints: InferHints = {},
): DoD => {
  const blockSource = args.acceptance ?? args.prompt ?? args.description ?? "";
  const explicit = parseDoDFromDispatch(blockSource);
  if (explicit) return explicit;
  const dispatch = args.prompt ?? args.description ?? "";
  return inferDoD(dispatch, "", hints);
};

/** Resolve a tier name to {providerID, modelID} for client.session.prompt. */
export const tierModel = (
  cfg: RouterConfig,
  tierName: string,
): { providerID: string; modelID: string } | null => {
  const tiers = getActiveTiers(cfg);
  const t = tiers[tierName];
  if (!t || typeof t.model !== "string") return null;
  const slash = t.model.indexOf("/");
  if (slash <= 0 || slash >= t.model.length - 1) return null;
  return {
    providerID: t.model.slice(0, slash),
    modelID: t.model.slice(slash + 1),
  };
};

/** Decide whether a built-in `task` tool call should be verify-dispatched (Option i). */
export const shouldVerifyTask = (
  tool: string,
  mode: string,
  require: string | undefined,
): boolean => {
  if (tool !== "task") return false;
  if (mode === "off") return false;
  if ((require ?? "whenDoDPresent") === "never") return false;
  return true;
};

/** Build the advisory forcing note appended to a task result the gate did not accept. */
export const buildForcingNote = (
  reasons: string[],
  escalation?: { producerTier?: string; nextTier?: string | null },
): string => {
  const body =
    reasons.length > 0 ? reasons.map((r) => `- ${r}`).join("\n") : "- (no reasons provided)";
  const next = escalation?.nextTier
    ? `NEXT: address the above, then re-run via \`Task(subagent_type="${escalation.nextTier}")\`` +
      `${escalation.producerTier ? ` (escalated from ${escalation.producerTier})` : ""}; ` +
      `do not treat the prior result as complete.`
    : `NEXT: address the above and re-run the delegation; do not treat the prior result as complete.`;
  return (
    `[router \u26a0 NOT ACCEPTED] The delegated result was not accepted by independent verification:\n` +
    `${body}\n` +
    next
  );
};

/** Suffix appended to an accepted delegate-tool result. */
export const buildAcceptedSuffix = (method: string): string => {
  return `\n\n[router \u2713 accepted: ${method}]`;
};

// ---------------------------------------------------------------------------
// Adapter functions (Slice 3).
//
// These wrap the live runtime state owned by `PluginContext` and the SDK
// calls made through `ctx.plugin.client.session`. They preserve the exact
// behavior of the inline closures that previously lived in src/index.ts.
// ---------------------------------------------------------------------------

/** Per-tier grader dispatcher. Creates a fresh session via the plugin SDK,
 *  tracks it in `ctx.graderSessions` so the chat.params hook can apply the
 *  grader temperature override, runs the prompt, and returns the assembled
 *  text. Failure modes (no session id, SDK throw) collapse to empty result
 *  — the gate treats grader errors as a fail-closed verdict anyway.
 *
 *  Fail-closed on invalid tier resolution (SDD change:
 *  fail-fast-hardening-v2). If the requested tier cannot be resolved to a
 *  configured `{ providerID, modelID }` pair, we emit `routing.unmet`,
 *  return an empty grader result, and NEVER prompt with an omitted model
 *  (which would let the SDK substitute a server-default model — i.e. the
 *  grader would silently answer from a model the operator never picked).
 *  The shared `resolveTierModelGuard` keeps the fail-closed semantics in
 *  lock-step with `delegate.ts`'s pre-prompt guard. */
export const dispatchGrader = async (
  ctx: PluginContext,
  req: { tier: string; system: string; prompt: string },
  parentSessionID?: string | null,
): Promise<{ sessionID: string; text: string }> => {
  const cfg = await ctx.getConfig();
  const created = await withTimeout(
    ctx.plugin.client.session.create(
      parentSessionID ? { body: { parentID: parentSessionID } } : {},
    ) as Promise<SessionCreateResult>,
    30_000,
    "grader session.create",
  );
  const sid = extractSessionId(created);
  if (!sid) return { sessionID: "", text: "" };
  ctx.graderSessions.add(sid);
  try {
    const guard = resolveTierModelGuard(cfg, req.tier);
    if (!guard.ok) {
      logEvent.routing.unmet({ reason: guard.reason, tier: req.tier });
      return { sessionID: "", text: "" };
    }
    const model = guard.model;
    const res = await withTimeout(
      ctx.plugin.client.session.prompt({
        path: { id: sid },
        body: {
          model,
          system: req.system,
          parts: [{ type: "text", text: req.prompt }],
        },
      }) as Promise<SessionPromptResult>,
      120_000,
      "grader session.prompt",
    );
    const text = extractPromptText(res);
    return { sessionID: sid, text };
  } finally {
    // Grader session lifecycle: untrack → abort → delete. Each SDK call is
    // best-effort (own try/catch) so a failure from one step does not block
    // the next. The chat.params hook reads `ctx.graderSessions` to apply the
    // grader temperature override; untracking first stops the temperature
    // override before we tear the session down. Abort stops any still-running
    // work before deletion, matching `src/plugin/delegate.ts` cleanup
    // discipline (SDD change: fix-orphan-subagent-sessions).
    ctx.graderSessions.delete(sid);
    try {
      await ctx.plugin.client.session.abort({ path: { id: sid } });
    } catch {
      // best-effort: cleanup MUST never throw out of the finally block.
    }
    try {
      await ctx.plugin.client.session.delete({ path: { id: sid } });
    } catch {
      // best-effort: cleanup MUST never throw out of the finally block.
    }
  }
};

/** Assemble `GateDeps` from the live seams and config snapshot. Reads
 *  `cfg.enforcement?.verify?.require` and `cfg.enforcement?.verify?.minGraderTier`
 *  at call time so /router switches take effect on the next delegate. */
export const buildGateDeps = async (
  ctx: PluginContext,
  parentSessionID?: string | null,
): Promise<GateDeps> => {
  const cfg = await ctx.getConfig();
  return {
    deterministic: {
      exec: ctx.seams.exec,
      fs: ctx.seams.fs,
      cwd: ctx.plugin.directory,
      mutex: ctx.verifyMutex,
    },
    checker: {
      dispatchGrader: (req) => dispatchGrader(ctx, req, parentSessionID),
      ladder: ["fast", "medium", "heavy"],
      minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null,
    },
    require: cfg.enforcement?.verify?.require,
  };
};

/** Adapter for `tool.execute.after`: when a built-in `task` call should be
 *  verify-dispatched, parse the result, build a DoD, run the gate, and append
 *  a forcing note to `output.output` on rejection. Fail-closed: any throw is
 *  swallowed so the after-hook never crashes a real session.
 *
 *  Parent for grader sessions is read metadata-first from
 *  `output.metadata.parentSessionId` (or `parentSessionID`) via
 *  `parseTaskResult` and threaded into `buildGateDeps(ctx, parentSessionID)`.
 *  The subagent `input.sessionID` MUST NEVER be forwarded as
 *  `parentSessionID`: passing the subagent SID caused the SDK to attempt to
 *  create child sessions of subagent sessions, which hangs the opencode
 *  runtime permanently (SDD change: fix-subagent-session-hang). When
 *  metadata is absent/non-object/non-string, the hook leaves grader creation
 *  parentless — it MUST NOT throw for that reason alone (SDD change:
 *  fix-task-verifier-session-parenting). */
export const verifyTaskAfterHook = async (
  ctx: PluginContext,
  input: unknown,
  output: Record<string, unknown>,
): Promise<void> => {
  const inputRec = (input ?? {}) as Record<string, unknown>;
  const toolName = inputRec["tool"];
  if (typeof toolName !== "string") return;
  const taskArgs = asTaskToolArgs(inputRec["args"]);
  const activeCfg = await ctx.getConfig();
  let mode = "off";
  try {
    mode = resolveEnforcementMode({ config: activeCfg, env: process.env }).mode;
  } catch {
    // fall through with mode "off"
  }
  const requireMode = activeCfg.enforcement?.verify?.require;
  if (!shouldVerifyTask(toolName, mode, requireMode)) return;
  // Hoist the parsed childSessionID OUTSIDE the verification try block so the
  // cleanup `finally` can always reach it. Without this, an uncaught throw
  // inside `accept()` (or earlier) would skip the cleanup tail entirely and
  // leak the Task child session across stores forever. Mirrors the
  // `src/plugin/delegate.ts` per-attempt cleanup discipline (SDD change:
  // fix-orphan-subagent-sessions).
  let childSessionID: string | null = null;
  try {
    const parsed = parseTaskResult(output);
    childSessionID = parsed.childSessionID;
    const { finalReturnText, parentSessionID } = parsed;
    const producerTier = taskArgs?.subagent_type ?? "";
    const dod = buildDelegationDoD({
      prompt: taskArgs?.prompt,
      description: taskArgs?.description,
    });
    const artefact = {
      changedFiles: childSessionID ? ctx.changedFileStore.get(childSessionID) : [],
      finalReturnText,
      declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
      producerSessionID: childSessionID ?? "",
      producerTier,
    };
    const trivial = childSessionID ? ctx.sessionStore.isTrivial(childSessionID) : false;
    const res = await accept(
      { dod, trivial, mode: "modeA" },
      artefact,
      await buildGateDeps(ctx, parentSessionID),
    );
    // PR5: structured verification outcome observability. Three events:
    //   - verification.pass   — gate accepted the artefact
    //   - verification.fail   — gate rejected (and produced a forcing note)
    //   - verification.skipped — verification was bypassed (never / trivial)
    // Operators get an at-a-glance count of gate decisions without
    // correlating trajectory files.
    const eventPayload = {
      sid: childSessionID ?? "",
      parentSid: parentSessionID ?? "",
      producerTier,
      method: res.verdict.method,
      dodSource: res.dodSource,
      skipped: res.verdict.skipped === true,
      reasonCount: res.verdict.reasons.length,
    };
    if (res.accepted) {
      logEvent.verification.pass(eventPayload);
    } else if (res.verdict.skipped) {
      logEvent.verification.skipped({ ...eventPayload, reasons: res.verdict.reasons });
    } else {
      logEvent.verification.fail({ ...eventPayload, reasons: res.verdict.reasons });
      // SDD: tui-toast-verification — surface the terminal gate rejection
      // as a TUI toast. Fires only on a real (non-skipped) verification
      // failure, exactly once per terminal outcome. Best-effort: never
      // throws on a missing TUI surface or rejected promise. The forcing
      // note below is the per-tool detailed signal; the toast is the
      // at-a-glance summary.
      showRouterToast(ctx.plugin.client, {
        message: "Delegation not accepted by verification",
        variant: "warning",
      });
    }
    if (!res.accepted && !res.verdict.skipped) {
      const ladder = activeCfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
      const li = ladder.indexOf(producerTier);
      const nextTier = li >= 0 && li < ladder.length - 1 ? ladder[li + 1] : null;
      const note = scrubText(buildForcingNote(res.verdict.reasons, { producerTier, nextTier }));
      const existing = output["output"];
      output["output"] = typeof existing === "string" ? existing + "\n\n" + note : note;
    }
  } catch (err) {
    // fail-closed: a verification error must NEVER throw out of the after-hook.
    // PR5: surface the fail-loud as a structured verification.fail event so
    // operators can see when the gate itself crashed (vs. when it returned a
    // verdict.reasons rejection).
    logEvent.verification.fail({
      sid: "",
      producerTier: "",
      method: "none",
      dodSource: "explicit",
      skipped: false,
      reasonCount: 1,
      reasons: [err instanceof Error ? err.message : String(err)],
      crashed: true,
    });
    // SDD: tui-toast-verification — guarded toast on verifier crash.
    // The catch block is fail-closed (must NEVER throw), so the toast
    // call uses the same helper contract: missing TUI surface is a silent
    // no-op and a rejected promise is swallowed internally. A generic
    // message keeps the user signal stable across distinct crash shapes;
    // the structured `verification.fail` event above carries the precise
    // reason for operator diagnosis.
    showRouterToast(ctx.plugin.client, {
      message: "Verification failed unexpectedly",
      variant: "error",
    });
  } finally {
    // Task child-session cleanup — ALWAYS runs (success, rejection, crash).
    // Order mirrors `src/plugin/delegate.ts` per-attempt cleanup:
    //   1. changedFileStore.clear — the changed-file data must remain
    //      readable through `accept()`; now that the artefact is assembled
    //      and scored, the per-session map is safe to drop.
    //   2. sessionStore.unregister — release the session tracking entry
    //      so the cap/ladder stop counting this child. Best-effort: the
    //      `try {} catch {}` prevents a single failing op from leaking
    //      an active entry across stores.
    //   3. guardStore.clear — last because guards depend on session and
    //      changed-file state; drop guard state only after the producer is
    //      fully released.
    if (childSessionID) {
      ctx.changedFileStore.clear(childSessionID);
      try {
        ctx.sessionStore.unregister(childSessionID);
      } catch {
        // non-fatal
      }
      try {
        ctx.guardStore.clear(childSessionID);
      } catch {
        // non-fatal
      }
    }
  }
};
