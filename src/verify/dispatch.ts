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
import type { RouterConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { parseDoDFromDispatch, inferDoD } from "./dod";
import type { DoD, InferHints } from "./dod";
import type { PluginContext } from "../plugin/context";
import type { GateDeps } from "./gate";
import { accept } from "./gate";
import { resolveEnforcementMode } from "../router/enforcement";
import { scrubText } from "../guard/scrub";

/** Tools that mutate the workspace (mirrors the guard taxonomy). */
const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

export interface ChangedFile {
  path: string;
  status: string;
}

/** Derive a {path,status} record from a write/edit tool call, or null. */
export function extractChangedFile(tool: string, args: unknown): ChangedFile | null {
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
}

/**
 * Per-session changed-file tracker. We attribute changed files to a delegation
 * by observing that session's own edit/write tool calls (ADR 0002 D3 — NOT a
 * global git diff), which is concurrency-safe under interleaved subagents.
 */
export function createChangedFileStore() {
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
}

const TASK_RESULT_RE = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/i;

/**
 * Parse the built-in `task` tool's after-hook output: the child's final return
 * is wrapped in <task_result>...</task_result> and the child session id lives in
 * output.metadata.sessionId (spike capability C).
 */
export function parseTaskResult(output: unknown): {
  finalReturnText: string;
  childSessionID: string | null;
} {
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
  return { finalReturnText, childSessionID };
}

/**
 * Build the DoD for a delegation from its dispatch text: an explicit
 * [acceptance] block wins; otherwise auto-infer a minimal, non-vacuous DoD
 * (M2 default). `acceptance` (if provided) is parsed for the block first.
 */
export function buildDelegationDoD(
  args: { prompt?: string; description?: string; acceptance?: string },
  hints: InferHints = {},
): DoD {
  const blockSource = args.acceptance ?? args.prompt ?? args.description ?? "";
  const explicit = parseDoDFromDispatch(blockSource);
  if (explicit) return explicit;
  const dispatch = args.prompt ?? args.description ?? "";
  return inferDoD(dispatch, "", hints);
}

/** Resolve a tier name to {providerID, modelID} for client.session.prompt. */
export function tierModel(
  cfg: RouterConfig,
  tierName: string,
): { providerID: string; modelID: string } | null {
  const tiers = getActiveTiers(cfg);
  const t = tiers[tierName];
  if (!t || typeof t.model !== "string") return null;
  const slash = t.model.indexOf("/");
  if (slash <= 0 || slash >= t.model.length - 1) return null;
  return {
    providerID: t.model.slice(0, slash),
    modelID: t.model.slice(slash + 1),
  };
}

/** Decide whether a built-in `task` tool call should be verify-dispatched (Option i). */
export function shouldVerifyTask(
  tool: string,
  mode: string,
  require: string | undefined,
): boolean {
  if (tool !== "task") return false;
  if (mode === "off") return false;
  if ((require ?? "whenDoDPresent") === "never") return false;
  return true;
}

/** Build the advisory forcing note appended to a task result the gate did not accept. */
export function buildForcingNote(
  reasons: string[],
  escalation?: { producerTier?: string; nextTier?: string | null },
): string {
  const body =
    reasons.length > 0
      ? reasons.map((r) => `- ${r}`).join("\n")
      : "- (no reasons provided)";
  const next =
    escalation?.nextTier
      ? `NEXT: address the above, then re-run via \`Task(subagent_type="${escalation.nextTier}")\`` +
        `${escalation.producerTier ? ` (escalated from ${escalation.producerTier})` : ""}; ` +
        `do not treat the prior result as complete.`
      : `NEXT: address the above and re-run the delegation; do not treat the prior result as complete.`;
  return (
    `[router \u26a0 NOT ACCEPTED] The delegated result was not accepted by independent verification:\n` +
    `${body}\n` +
    next
  );
}

/** Suffix appended to an accepted delegate-tool result. */
export function buildAcceptedSuffix(method: string): string {
  return `\n\n[router \u2713 accepted: ${method}]`;
}

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
 *  — the gate treats grader errors as a fail-closed verdict anyway. */
export async function dispatchGrader(
  ctx: PluginContext,
  req: { tier: string; system: string; prompt: string },
): Promise<{ sessionID: string; text: string }> {
  const cfg = ctx.getConfig();
  const created: any = await ctx.plugin.client.session.create({});
  const sid: string | undefined = created?.data?.id;
  if (!sid) return { sessionID: "", text: "" };
  ctx.graderSessions.add(sid);
  try {
    const model = tierModel(cfg, req.tier) ?? undefined;
    const res: any = await ctx.plugin.client.session.prompt({
      path: { id: sid },
      body: {
        ...(model ? { model } : {}),
        system: req.system,
        parts: [{ type: "text", text: req.prompt }],
      },
    });
    const parts: any[] = res?.data?.parts ?? [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    return { sessionID: sid, text };
  } finally {
    ctx.graderSessions.delete(sid);
  }
}

/** Assemble `GateDeps` from the live seams and config snapshot. Reads
 *  `cfg.enforcement?.verify?.require` and `cfg.enforcement?.verify?.minGraderTier`
 *  at call time so /router switches take effect on the next delegate. */
export function buildGateDeps(ctx: PluginContext): GateDeps {
  const cfg = ctx.getConfig();
  return {
    deterministic: {
      exec: ctx.seams.exec,
      fs: ctx.seams.fs,
      cwd: ctx.plugin.directory,
      mutex: ctx.verifyMutex,
    },
    checker: {
      dispatchGrader: (req) => dispatchGrader(ctx, req),
      ladder: ["fast", "medium", "heavy"],
      minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null,
    },
    require: cfg.enforcement?.verify?.require,
  };
}

/** Adapter for `tool.execute.after`: when a built-in `task` call should be
 *  verify-dispatched, parse the result, build a DoD, run the gate, and append
 *  a forcing note to `output.output` on rejection. Fail-closed: any throw is
 *  swallowed so the after-hook never crashes a real session. */
export async function verifyTaskAfterHook(
  ctx: PluginContext,
  input: any,
  output: any,
): Promise<void> {
  if (typeof input?.tool !== "string") return;
  const activeCfg = ctx.getConfig();
  let mode = "off";
  try {
    mode = resolveEnforcementMode({ config: activeCfg, env: process.env }).mode;
  } catch {
    // fall through with mode "off"
  }
  const requireMode = activeCfg.enforcement?.verify?.require;
  if (!shouldVerifyTask(input.tool, mode, requireMode)) return;
  try {
    const { finalReturnText, childSessionID } = parseTaskResult(output);
    const producerTier =
      typeof input?.args?.subagent_type === "string"
        ? input.args.subagent_type
        : "";
    const dod = buildDelegationDoD({
      prompt: input?.args?.prompt,
      description: input?.args?.description,
    });
    const artefact = {
      changedFiles: childSessionID
        ? ctx.changedFileStore.get(childSessionID)
        : [],
      finalReturnText,
      declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
      producerSessionID: childSessionID ?? "",
      producerTier,
    };
    const trivial = childSessionID
      ? ctx.sessionStore.isTrivial(childSessionID)
      : false;
    const res = await accept(
      { dod, trivial, mode: "modeA" },
      artefact,
      buildGateDeps(ctx),
    );
    if (!res.accepted && !res.verdict.skipped) {
      const ladder = activeCfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
      const li = ladder.indexOf(producerTier);
      const nextTier = li >= 0 && li < ladder.length - 1 ? ladder[li + 1] : null;
      const note = scrubText(buildForcingNote(res.verdict.reasons, { producerTier, nextTier }));
      output.output =
        typeof output.output === "string"
          ? output.output + "\n\n" + note
          : note;
    }
    if (childSessionID) ctx.changedFileStore.clear(childSessionID);
  } catch {
    // fail-closed: a verification error must NEVER throw out of the after-hook
  }
}
