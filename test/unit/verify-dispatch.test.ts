import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dumpDelegateScorecard } from "../../src/escalate/ladder";
import type { PluginContext } from "../../src/plugin/context";
import type { RouterConfig } from "../../src/router/config";
import { createFsSeam } from "../../src/utils/fs";
import { buildGateDeps, dispatchGrader, verifyTaskAfterHook } from "../../src/verify/dispatch";

// ---------------------------------------------------------------------------
// Slice 3 — Verification adapter contract tests.
//
// These cover the four observable invariants from the spec / task:
//   1. Accepted delegate output keeps the same suffix (delegated via the
//      plugin-owned delegate tool; the gate's accept-suffix is unchanged).
//   2. Rejected task verification keeps the same forcing note (via the
//      extracted `verifyTaskAfterHook`).
//   3. Grader temperature wiring: `dispatchGrader` adds the session id to
//      `ctx.graderSessions` while it is open and removes it on completion.
//   4. Scorecard temp path: `dumpDelegateScorecard` writes under
//      `<tmpdir>/opencode-model-router-trajectory/<sid>.delegate.log`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fake PluginContext builder (mirrors the seams.test.ts approach: stub every
// method/index.ts actually touches, no real config or stores).
// ---------------------------------------------------------------------------

interface FakeStore {
  registerFromChatMessage?: (...args: any[]) => any;
  isSubagent?: (sid: string) => boolean;
  isTrivial?: (sid: string) => boolean;
  getTier?: (sid: string) => string;
  unregister?: (sid: string) => void;
}

const makeCtx = (opts: {
  directory: string;
  createImpl?: (req: any) => Promise<any>;
  promptImpl?: (req: any) => Promise<any>;
  deleteImpl?: (req: any) => Promise<any>;
  abortImpl?: (req: any) => Promise<any>;
  cfg?: Partial<RouterConfig>;
  changedFiles?: { path: string; status: string }[];
  sessionStore?: FakeStore;
  showToastImpl?: (req: any) => Promise<any>;
  changedFileStore?: {
    get?: (sid: string) => any[];
    clear?: (sid: string) => void;
    record?: (sid: string, tool: string, args: unknown) => void;
  };
  guardStore?: { get?: (sid: string) => any; clear?: (sid: string) => void };
}): PluginContext & { toastSpy?: ReturnType<typeof vi.fn> } => {
  const cfg: RouterConfig = {
    activePreset: "default",
    defaultTier: "fast",
    presets: {
      default: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          description: "fast",
          whenToUse: [],
        },
      },
    },
    rules: [],
    enforcement: {
      verify: {
        minGraderTier: "heavy",
        ...(opts.cfg?.enforcement?.verify ?? {}),
      },
      escalate: {
        ladder: ["fast", "medium", "heavy"],
        ...(opts.cfg?.enforcement?.escalate ?? {}),
      },
      ...(opts.cfg?.enforcement ?? {}),
    },
    ...(opts.cfg ?? {}),
  } as unknown as RouterConfig;

  const sessionStore = {
    registerFromChatMessage: () => undefined,
    isSubagent: () => false,
    isTrivial: () => false,
    getTier: () => "fast",
    unregister: () => undefined,
    ...(opts.sessionStore ?? {}),
  };

  // SDD: tui-toast-verification — capture every showToast call so the
  // verify-after-hook tests can assert that exactly one warning toast
  // fires on a real verification rejection and zero toasts fire on
  // acceptance / skipped / no-op paths.
  const toastSpy = vi.fn().mockResolvedValue(undefined);
  const showToastImpl = opts.showToastImpl ?? toastSpy;

  return {
    plugin: {
      directory: opts.directory,
      client: {
        session: {
          create: opts.createImpl ?? (async () => ({ data: { id: "sess_x" } })),
          prompt: opts.promptImpl ?? (async () => ({ data: { parts: [] } })),
          delete: opts.deleteImpl ?? (async () => ({ data: true })),
          abort: opts.abortImpl ?? (async () => ({ data: true })),
        },
        tui: { showToast: showToastImpl },
      },
    } as any,
    toastSpy,
    initialConfig: cfg,
    activeTiersAtLoad: { fast: cfg.presets.default.fast },
    getConfig: async () => cfg,
    refreshConfig: async () => cfg,
    getFreshConfig: async () => cfg,
    dispose: async () => {},
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore: sessionStore as any,
    trajectoryStore: {
      ensure: () => undefined,
      recordToolEvent: () => undefined,
      dump: () => null,
    } as any,
    guardStore: {
      get: opts.guardStore?.get ?? (() => undefined),
      clear: opts.guardStore?.clear ?? (() => undefined),
    } as any,
    changedFileStore: {
      get: opts.changedFileStore?.get ?? (() => opts.changedFiles ?? []),
      clear: opts.changedFileStore?.clear ?? (() => undefined),
      record: opts.changedFileStore?.record ?? (() => undefined),
    } as any,
    reasoningStore: {} as any,
    graderSessions: new Set<string>(),
    verifyMutex: { runExclusive: async (_k: string, fn: () => Promise<any>) => fn() } as any,
    seams: {
      exec: (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false })) as any,
      fs: createFsSeam({ directory: opts.directory }),
    },
  };
};

// ---------------------------------------------------------------------------
// Test isolation: every test uses its own temp dir and SID.
// ---------------------------------------------------------------------------

let workDir: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  workDir = join(
    tmpdir(),
    `oc-test-verify-dispatch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workDir, { recursive: true });
  process.env.HOME = workDir;
  delete process.env.MODEL_ROUTER_ENFORCE;
});

afterEach(() => {
  if (origHome !== undefined) {
    process.env.HOME = origHome;
  } else {
    delete process.env.HOME;
  }
  delete process.env.MODEL_ROUTER_ENFORCE;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// dispatchGrader
// ---------------------------------------------------------------------------

describe("dispatchGrader", () => {
  it("returns the session id and assembled text on a successful prompt", async () => {
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => ({
        data: {
          parts: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
            { type: "tool_use", id: "ignored" },
          ],
        },
      }),
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "do it",
    });

    expect(result.sessionID).toBe("sess_x");
    // Parts are joined with "\n" per the implementation contract.
    expect(result.text).toBe("hello \nworld");
  });

  it("adds the session id to ctx.graderSessions while open and removes it on completion", async () => {
    let capturedInsidePrompt: string[] = [];
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => {
        // Snapshot the graderSessions set from inside the prompt call —
        // dispatchGrader must have added the SID by the time it calls .prompt().
        capturedInsidePrompt = [...ctx.graderSessions];
        return { data: { parts: [{ type: "text", text: "ok" }] } };
      },
    });

    expect(ctx.graderSessions.has("sess_x")).toBe(false);
    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "do it",
    });

    // Inside the prompt call, the SID was registered.
    expect(capturedInsidePrompt).toContain("sess_x");
    // After completion, the SID was removed.
    expect(ctx.graderSessions.has("sess_x")).toBe(false);
    expect(result.sessionID).toBe("sess_x");
  });

  it("removes the SID from ctx.graderSessions even when the prompt call throws", async () => {
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => {
        throw new Error("boom");
      },
    });

    await expect(dispatchGrader(ctx, { tier: "fast", system: "sys", prompt: "p" })).rejects.toThrow(
      "boom",
    );

    expect(ctx.graderSessions.has("sess_x")).toBe(false);
  });

  it("returns empty result when the SDK returns no session id", async () => {
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async () => ({ data: {} }),
      promptImpl: async () => ({ data: { parts: [] } }),
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "p",
    });

    expect(result).toEqual({ sessionID: "", text: "" });
  });

  // -------------------------------------------------------------------------
  // SDD fail-fast-hardening-v2 (Phase 2): shared tier-model guard.
  //
  // The pre-v2 dispatchGrader silently fell through `tierModel(...) ?? undefined`
  // and called `session.prompt` with no model field — the SDK then picked a
  // server-default model, which is exactly the bug the spec calls out. v2
  // replaces the silent fallthrough with `resolveTierModelGuard` so an
  // unresolved tier fails closed: empty grader result + `routing.unmet`
  // event, no `session.prompt` call.
  //
  // Invariants under test:
  //   - Unknown tier ⇒ empty `{ sessionID: "", text: "" }` result.
  //   - `routing.unmet` is emitted (warn level) with the canonical reason
  //     and the offending tier name.
  //   - `session.prompt` is NEVER invoked (no SDK round-trip with an
  //     omitted model — that's the regression we're guarding against).
  //   - The session is removed from `ctx.graderSessions` even on the
  //     fail-closed path (per-attempt `finally` invariant).
  // -------------------------------------------------------------------------

  it("fails closed with empty result when the tier is unknown (no prompt call)", async () => {
    const promptCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "should-not-run" }] } };
      },
    });

    const result = await dispatchGrader(ctx, {
      tier: "no-such-tier",
      system: "sys",
      prompt: "verify",
    });

    // Empty grader result — the gate treats this as a fail-closed verdict.
    expect(result).toEqual({ sessionID: "", text: "" });
    // session.prompt MUST NOT have been called. This is the core regression
    // we're guarding against: a real prompt with a server-default model
    // would silently answer from a model the operator never picked.
    expect(promptCalls).toHaveLength(0);
    // The per-attempt `finally` still runs — no leaked grader session id.
    expect(ctx.graderSessions.has("sess_x")).toBe(false);
  });

  it("fails closed when the configured tier has a malformed model string (stale config)", async () => {
    const promptCalls: unknown[] = [];
    // Stale config snapshot: 'fast' is configured with model "noslash"
    // (no `provider/model` slash). tierModel() returns null; the guard
    // fails closed the same way it does for an unknown tier — same
    // canonical reason, same empty grader result.
    const ctx = makeCtx({
      directory: workDir,
      cfg: {
        presets: {
          default: {
            fast: { model: "noslash", description: "f", whenToUse: [] },
          },
        },
      } as any,
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "should-not-run" }] } };
      },
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "verify",
    });

    expect(result).toEqual({ sessionID: "", text: "" });
    expect(promptCalls).toHaveLength(0);
    expect(ctx.graderSessions.has("sess_x")).toBe(false);
  });

  it("emits a routing.unmet observability event with the offending tier on fail-closed", async () => {
    // SDD: tui-toast-verification — routing.unmet was downgraded from
    // warn to debug. Opt in to debug level and spy on console.log.
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ctx = makeCtx({ directory: workDir });

      await dispatchGrader(ctx, {
        tier: "no-such-tier",
        system: "sys",
        prompt: "verify",
      });

      // routing.unmet is emitted at debug level; filter to model-router
      // lines and look for the canonical event name + reason + tier.
      const lines = logSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((l) => l.startsWith("[model-router] "));
      const matched = lines.some((l) => {
        try {
          const env = JSON.parse(l.slice(l.indexOf("{")));
          return (
            env["event"] === "routing.unmet" &&
            env["reason"] === "invalid model or provider configuration" &&
            env["tier"] === "no-such-tier"
          );
        } catch {
          return false;
        }
      });
      expect(matched).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });

  // -------------------------------------------------------------------------
  // SDD: fix-orphan-subagent-sessions (PR 1, Work Unit 1) — grader session
  // lifecycle cleanup. The grader session must be aborted and deleted on
  // every exit path so it does not leak as an orphan session in the TUI.
  // Invariants under test:
  //   - Successful prompt ⇒ session.abort + session.delete both called
  //     with the grader SID, after untracking from `ctx.graderSessions`.
  //   - When the prompt throws (simulated SDK failure), abort + delete
  //     are still attempted on the throw path.
  //   - When session.create times out (rejected withTimeout), abort +
  //     delete run before the rejection propagates so the session cannot
  //     leak even if `session.create` partially succeeded server-side.
  //   - `session.delete` failure does NOT crash the hook — failures are
  //     swallowed because cleanup is best-effort.
  // -------------------------------------------------------------------------

  it("aborts and deletes the grader session on successful completion", async () => {
    const deleteCalls: string[] = [];
    const abortCalls: string[] = [];
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
      abortImpl: async (req: any) => {
        abortCalls.push(req?.path?.id);
        return { data: true };
      },
      deleteImpl: async (req: any) => {
        deleteCalls.push(req?.path?.id);
        return { data: true };
      },
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "do it",
    });

    expect(result.sessionID).toBe("sess_x");
    // Both SDK calls must have run with the grader SID.
    expect(deleteCalls).toContain("sess_x");
    expect(abortCalls).toContain("sess_x");
    // Both must run exactly once (no duplicate cleanup).
    expect(deleteCalls).toHaveLength(1);
    expect(abortCalls).toHaveLength(1);
    // Untrack happens before abort/delete — the chat.params hook observes
    // an empty `ctx.graderSessions` set on the next event.
    expect(ctx.graderSessions.has("sess_x")).toBe(false);
  });

  it("aborts and deletes the grader session when the prompt call throws", async () => {
    const deleteCalls: string[] = [];
    const abortCalls: string[] = [];
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => {
        throw new Error("prompt boom");
      },
      abortImpl: async (req: any) => {
        abortCalls.push(req?.path?.id);
        return { data: true };
      },
      deleteImpl: async (req: any) => {
        deleteCalls.push(req?.path?.id);
        return { data: true };
      },
    });

    await expect(
      dispatchGrader(ctx, { tier: "fast", system: "sys", prompt: "do it" }),
    ).rejects.toThrow("prompt boom");

    // The throw MUST NOT prevent abort + delete — the finally block runs.
    expect(abortCalls).toContain("sess_x");
    expect(deleteCalls).toContain("sess_x");
  });

  it("still deletes the grader session when session.abort throws (best-effort isolation)", async () => {
    const deleteCalls: string[] = [];
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
      // session.abort throws — the cleanup must isolate this failure so
      // session.delete still runs. Otherwise a single SDK 5xx during abort
      // would orphan the grader session in the TUI.
      abortImpl: async () => {
        throw new Error("abort failed");
      },
      deleteImpl: async (req: any) => {
        deleteCalls.push(req?.path?.id);
        return { data: true };
      },
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "do it",
    });

    expect(result.sessionID).toBe("sess_x");
    // delete MUST still run despite the abort failure.
    expect(deleteCalls).toContain("sess_x");
  });
});

// ---------------------------------------------------------------------------
// buildGateDeps
// ---------------------------------------------------------------------------

describe("buildGateDeps", () => {
  it("returns a GateDeps with deterministic seams from ctx.seams and verifyMutex", async () => {
    const ctx = makeCtx({ directory: workDir });
    const deps = await buildGateDeps(ctx);

    expect(deps.deterministic.cwd).toBe(workDir);
    expect(deps.deterministic.exec).toBe(ctx.seams.exec);
    expect(deps.deterministic.fs).toBe(ctx.seams.fs);
    expect(deps.deterministic.mutex).toBe(ctx.verifyMutex);
  });

  it("reads enforce.verify.minGraderTier and enforce.verify.require from ctx.getConfig()", async () => {
    const ctx = makeCtx({
      directory: workDir,
      cfg: {
        enforcement: {
          mode: "advisory",
          verify: { minGraderTier: "ultra", require: "always" },
        } as any,
      },
    });

    const deps = await buildGateDeps(ctx);
    expect(deps.checker.minGraderTier).toBe("ultra");
    expect(deps.require).toBe("always");
    expect(deps.checker.ladder).toEqual(["fast", "medium", "heavy"]);
  });

  it("checker.dispatchGrader delegates back to dispatchGrader with the same ctx", async () => {
    let capturedReq: any = null;
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async (req: any) => {
        capturedReq = req;
        return { data: { parts: [{ type: "text", text: "from-grader" }] } };
      },
    });

    const deps = await buildGateDeps(ctx);
    const result = await deps.checker.dispatchGrader({
      tier: "fast",
      system: "system-msg",
      prompt: "prompt-msg",
    });

    expect(result.text).toBe("from-grader");
    expect(capturedReq.body.system).toBe("system-msg");
    expect(capturedReq.body.parts[0].text).toBe("prompt-msg");
  });
});

// ---------------------------------------------------------------------------
// verifyTaskAfterHook
// ---------------------------------------------------------------------------

describe("verifyTaskAfterHook", () => {
  it("appends a forcing note when a built-in task call fails deterministic verification", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Target file does NOT exist -> fileExists deterministic check fails.
    const ctx = makeCtx({ directory: workDir });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the report.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE: report created.\n</task_result>",
      metadata: { sessionId: "child1" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    expect(output.output).toContain("NOT ACCEPTED");
    expect(output.output).toContain("[router");
  });

  it("does NOT modify output when the deterministic check PASSES", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Target file exists -> fileExists deterministic check passes.
    writeFileSync(join(workDir, "present.txt"), "ok");
    const ctx = makeCtx({ directory: workDir });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt: "Create the file.\n[acceptance]\ncheck: fileExists path=present.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child2" },
    };
    const original = output.output;

    await verifyTaskAfterHook(ctx, input, output);

    expect(output.output).toBe(original);
  });

  it("is a no-op when enforcement mode is OFF", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "0";
    const ctx = makeCtx({ directory: workDir });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the report.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE: report created.\n</task_result>",
      metadata: { sessionId: "child3" },
    };
    const original = output.output;

    await verifyTaskAfterHook(ctx, input, output);

    expect(output.output).toBe(original);
  });

  it("swallows verification errors (fail-closed at the hook boundary)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Use a criteria-only DoD so the gate dispatches to the grader via SDK,
    // then make the SDK throw. The gate is fail-closed by design: it catches
    // the SDK error and returns a non-passing verdict. The hook surfaces that
    // verdict as a forcing note (visible failure), never as a propagated
    // exception.
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async () => {
        throw new Error("sdk-explodes");
      },
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Explain the architecture.\n[acceptance]\ncriteria: it explains the components clearly\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child4" },
    };

    // The hook must NOT throw — the after-hook boundary is fail-closed.
    await expect(verifyTaskAfterHook(ctx, input, output)).resolves.toBeUndefined();
    // The gate's fail-closed verdict IS surfaced to the model as a forcing
    // note — that is the visible signal of the verification failure, not a
    // silent success and not a thrown exception.
    expect(output.output).toContain("NOT ACCEPTED");
    expect(output.output).toContain("grader dispatch failed");
  });

  it("ignores non-task tool calls (preserves original tool.execute.after routing)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({ directory: workDir });

    const input = {
      tool: "delegate",
      sessionID: "orch",
      args: {
        prompt: "Create the file.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "ok",
      metadata: {},
    };
    const original = output.output;

    await verifyTaskAfterHook(ctx, input, output);

    expect(output.output).toBe(original);
  });

  // -------------------------------------------------------------------------
  // SDD: fix-orphan-subagent-sessions (PR 2, Work Unit 2) — task hook
  // cleanup discipline. Before this PR, the cleanup lived at the tail of
  // the verification try block — a throw from accept(), a sync error in
  // scratch state, or any crash inside `isTrivial` would skip the cleanup
  // and leak the Task child across `changedFileStore`, `sessionStore`, and
  // `guardStore` until the plugin process died.
  //
  // Invariants under test:
  //   - Cleanup runs on every exit path (success, rejection, crash).
  //   - Cleanup order matches `src/plugin/delegate.ts`:
  //     changedFileStore.clear -> sessionStore.unregister -> guardStore.clear.
  //   - Each store op is best-effort: a throw from one op does NOT skip
  //     the others.
  // -------------------------------------------------------------------------

  it("clears all three stores once when a built-in task verification accepts", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    writeFileSync(join(workDir, "present.txt"), "ok");

    const clearChangedCalls: string[] = [];
    const unregisterCalls: string[] = [];
    const clearGuardCalls: string[] = [];

    const ctx = makeCtx({
      directory: workDir,
      changedFileStore: {
        clear: (sid: string) => {
          clearChangedCalls.push(sid);
        },
      },
      sessionStore: {
        unregister: (sid: string) => {
          unregisterCalls.push(sid);
        },
      },
      guardStore: {
        clear: (sid: string) => {
          clearGuardCalls.push(sid);
        },
      },
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the file.\n[acceptance]\ncheck: fileExists path=present.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-success" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    // All three cleanup calls must have run with the parsed child SID.
    expect(unregisterCalls).toEqual(["child-success"]);
    expect(clearChangedCalls).toEqual(["child-success"]);
    expect(clearGuardCalls).toEqual(["child-success"]);
    // Each store op must run exactly once (no duplicate cleanup).
    expect(unregisterCalls).toHaveLength(1);
    expect(clearChangedCalls).toHaveLength(1);
    expect(clearGuardCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // SDD: plan 007 — Task child session must be torn down at the SDK layer
  // so it does not leak as an orphan session in the TUI session list. The
  // previous fix-orphan-subagent-sessions PR cleared the plugin stores but
  // did not call session.abort() / session.delete(). These tests pin the
  // SDK teardown contract.
  // -------------------------------------------------------------------------

  it("aborts and deletes the Task child session on successful verification", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    writeFileSync(join(workDir, "present.txt"), "ok");

    const abortCalls: string[] = [];
    const deleteCalls: string[] = [];

    const ctx = makeCtx({
      directory: workDir,
      abortImpl: async (req: any) => {
        abortCalls.push(req?.path?.id);
        return { data: true };
      },
      deleteImpl: async (req: any) => {
        deleteCalls.push(req?.path?.id);
        return { data: true };
      },
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the file.\n[acceptance]\ncheck: fileExists path=present.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-success" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    expect(abortCalls).toEqual(["child-success"]);
    expect(deleteCalls).toEqual(["child-success"]);
  });

  it("still attempts delete when task child session.abort throws (best-effort isolation)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    writeFileSync(join(workDir, "present.txt"), "ok");

    const deleteCalls: string[] = [];

    const ctx = makeCtx({
      directory: workDir,
      abortImpl: async () => {
        throw new Error("abort boom");
      },
      deleteImpl: async (req: any) => {
        deleteCalls.push(req?.path?.id);
        return { data: true };
      },
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the file.\n[acceptance]\ncheck: fileExists path=present.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-success" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    // abort failure must not block delete.
    expect(deleteCalls).toEqual(["child-success"]);
  });

  it("aborts and deletes the Task child session even when verification rejects", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Missing file -> deterministic fail -> forcing note appended.
    // Cleanup must STILL run on a non-passing verdict.
    const abortCalls: string[] = [];
    const deleteCalls: string[] = [];

    const ctx = makeCtx({
      directory: workDir,
      abortImpl: async (req: any) => {
        abortCalls.push(req?.path?.id);
        return { data: true };
      },
      deleteImpl: async (req: any) => {
        deleteCalls.push(req?.path?.id);
        return { data: true };
      },
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the file.\n[acceptance]\ncheck: fileExists path=present.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-fail" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    expect(abortCalls).toEqual(["child-fail"]);
    expect(deleteCalls).toEqual(["child-fail"]);
  });

  it("clears all three stores once even when verification rejects", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Missing file -> deterministic fail -> forcing note appended.
    // Cleanup must STILL run on a non-passing verdict.
    const clearChangedCalls: string[] = [];
    const unregisterCalls: string[] = [];
    const clearGuardCalls: string[] = [];

    const ctx = makeCtx({
      directory: workDir,
      changedFileStore: {
        clear: (sid: string) => {
          clearChangedCalls.push(sid);
        },
      },
      sessionStore: {
        unregister: (sid: string) => {
          unregisterCalls.push(sid);
        },
      },
      guardStore: {
        clear: (sid: string) => {
          clearGuardCalls.push(sid);
        },
      },
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the report.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE: report created.\n</task_result>",
      metadata: { sessionId: "child-rejection" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    // The forcing note is the visible signal of a non-passing verdict.
    expect(output.output).toContain("NOT ACCEPTED");
    // Cleanup ran anyway — the rejection path must still release stores.
    expect(unregisterCalls).toEqual(["child-rejection"]);
    expect(clearChangedCalls).toEqual(["child-rejection"]);
    expect(clearGuardCalls).toEqual(["child-rejection"]);
  });

  it("clears all three stores when the verification body throws (crash path)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Force the inner try to throw by making `isTrivial` blow up. The hook's
    // outer catch swallows the error (fail-closed at the boundary) — but the
    // finally block still runs and must clean up the three stores.
    const clearChangedCalls: string[] = [];
    const unregisterCalls: string[] = [];
    const clearGuardCalls: string[] = [];

    const ctx = makeCtx({
      directory: workDir,
      sessionStore: {
        isTrivial: () => {
          throw new Error("isTrivial boom");
        },
        unregister: (sid: string) => {
          unregisterCalls.push(sid);
        },
      },
      changedFileStore: {
        clear: (sid: string) => {
          clearChangedCalls.push(sid);
        },
      },
      guardStore: {
        clear: (sid: string) => {
          clearGuardCalls.push(sid);
        },
      },
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt: "Do something.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-crash" },
    };

    // Hook must NOT throw — fail-closed at the boundary.
    await expect(verifyTaskAfterHook(ctx, input, output)).resolves.toBeUndefined();

    // Critical invariant: cleanup ran in `finally` despite the catch path
    // swallowing the crash. All three stores are released for the child SID.
    expect(unregisterCalls).toEqual(["child-crash"]);
    expect(clearChangedCalls).toEqual(["child-crash"]);
    expect(clearGuardCalls).toEqual(["child-crash"]);
  });

  it("runs cleanup in delegate-aligned order: changedFileStore -> sessionStore -> guardStore", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    writeFileSync(join(workDir, "present.txt"), "ok");

    // Collect every cleanup invocation into one ordered log so the test
    // can assert the relative order without depending on per-store
    // ordering.
    const callOrder: string[] = [];

    const ctx = makeCtx({
      directory: workDir,
      changedFileStore: {
        clear: (sid: string) => {
          callOrder.push(`changedFileStore.clear:${sid}`);
        },
      },
      sessionStore: {
        unregister: (sid: string) => {
          callOrder.push(`sessionStore.unregister:${sid}`);
        },
      },
      guardStore: {
        clear: (sid: string) => {
          callOrder.push(`guardStore.clear:${sid}`);
        },
      },
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the file.\n[acceptance]\ncheck: fileExists path=present.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-order" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    // Exact order — matches `src/plugin/delegate.ts` per-attempt cleanup.
    expect(callOrder).toEqual([
      "changedFileStore.clear:child-order",
      "sessionStore.unregister:child-order",
      "guardStore.clear:child-order",
    ]);
  });
});

// ---------------------------------------------------------------------------
// SDD: tui-toast-verification — toast helper wiring on the verify hook.
//
// Spec contract (verification terminal failure):
//   - "Verification terminal failure" — the system MUST request a TUI
//     toast when verification ends in a verification failure.
//   - The toast MUST be emitted only once for that terminal outcome.
//   - Best-effort: a rejecting toast MUST NOT change the primary outcome
//     (the forcing-note append is still the detailed signal).
//
// Invariants under test:
//   - On a real (non-skipped) verification rejection, exactly one
//     warning toast fires with the canonical message.
//   - On an accepted / skipped / no-op path, ZERO toasts fire.
//   - On a verifier crash (fail-closed catch block), one error toast
//     fires with a generic message and the hook does not throw.
//   - The forcing-note behavior is preserved unchanged (toast is
//     additive, not a replacement).
// ---------------------------------------------------------------------------

describe("verifyTaskAfterHook — toast helper wiring (SDD tui-toast-verification)", () => {
  it("fires a warning toast on a real (non-skipped) verification rejection", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({ directory: workDir }) as ReturnType<typeof makeCtx> & {
      toastSpy: ReturnType<typeof vi.fn>;
    };

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the report.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE: report created.\n</task_result>",
      metadata: { sessionId: "child_toast_rej" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    // Forcing-note behavior is preserved.
    expect(output.output).toContain("NOT ACCEPTED");
    // Toast fires exactly once with the canonical warning shape.
    expect(ctx.toastSpy).toHaveBeenCalledTimes(1);
    const args = ctx.toastSpy.mock.calls[0]?.[0] as {
      body: { message: string; variant: string };
    };
    expect(args?.body.variant).toBe("warning");
    expect(args?.body.message).toContain("Delegation not accepted by verification");
  });

  it("does NOT fire a toast on an accepted verification", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Target file exists -> deterministic check passes.
    writeFileSync(join(workDir, "present_toast.txt"), "ok");
    const ctx = makeCtx({ directory: workDir }) as ReturnType<typeof makeCtx> & {
      toastSpy: ReturnType<typeof vi.fn>;
    };

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the file.\n[acceptance]\ncheck: fileExists path=present_toast.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child_toast_ok" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    expect(ctx.toastSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire a toast when the gate is skipped", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "0";
    const ctx = makeCtx({ directory: workDir }) as ReturnType<typeof makeCtx> & {
      toastSpy: ReturnType<typeof vi.fn>;
    };

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the report.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE: report created.\n</task_result>",
      metadata: { sessionId: "child_toast_skipped" },
    };

    await verifyTaskAfterHook(ctx, input, output);
    expect(ctx.toastSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire a toast on non-task tool calls", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({ directory: workDir }) as ReturnType<typeof makeCtx> & {
      toastSpy: ReturnType<typeof vi.fn>;
    };

    const input = {
      tool: "delegate",
      sessionID: "orch",
      args: {
        prompt: "Create the file.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = { output: "ok", metadata: {} };

    await verifyTaskAfterHook(ctx, input, output);
    expect(ctx.toastSpy).not.toHaveBeenCalled();
  });

  it("fires a generic error toast on a verifier crash (fail-closed catch)", async () => {
    // Force the hook's outer catch to fire by making `isTrivial` throw
    // inside the try block. The hook swallows the error, surfaces the
    // verification.fail crash event, and fires the generic error toast.
    // We avoid replacing `ctx.getConfig` because that happens BEFORE the
    // try block in the hook — a rejection there escapes the catch.
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({
      directory: workDir,
      sessionStore: {
        isTrivial: () => {
          throw new Error("isTrivial boom");
        },
      },
    }) as ReturnType<typeof makeCtx> & {
      toastSpy: ReturnType<typeof vi.fn>;
    };

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt: "Do something.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child_crash" },
    };

    // The hook MUST NOT throw — fail-closed at the boundary.
    await expect(verifyTaskAfterHook(ctx, input, output)).resolves.toBeUndefined();
    // The generic error toast fires exactly once.
    expect(ctx.toastSpy).toHaveBeenCalledTimes(1);
    const args = ctx.toastSpy.mock.calls[0]?.[0] as {
      body: { message: string; variant: string };
    };
    expect(args?.body.variant).toBe("error");
    expect(args?.body.message).toContain("Verification failed");
  });

  it("does NOT change the primary outcome when the toast surface rejects (best-effort)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Swap the toast spy for a rejecting mock so the .catch(() => {})
    // path is exercised.
    const rejectingToast = vi.fn().mockRejectedValue(new Error("TUI offline"));
    const ctx = makeCtx({
      directory: workDir,
      showToastImpl: rejectingToast,
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt:
          "Create the report.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE: report created.\n</task_result>",
      metadata: { sessionId: "child_reject" },
    };

    // The hook must still resolve (no throw) and still append the
    // forcing note — toast failure MUST NOT affect the primary outcome.
    await expect(verifyTaskAfterHook(ctx, input, output)).resolves.toBeUndefined();
    expect(output.output).toContain("NOT ACCEPTED");
    expect(rejectingToast).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// dumpDelegateScorecard
// ---------------------------------------------------------------------------

describe("dumpDelegateScorecard", () => {
  it("writes a one-line scorecard under <tmpdir>/opencode-model-router-trajectory/<sid>.delegate.log", () => {
    const sid = `sid-${process.pid}-${Date.now()}`;
    const state = {
      currentTier: "medium",
      attemptsThisTier: 1,
      totalAttempts: 3,
      escalations: 1,
      firstAttemptCost: 1,
      cumulativeCost: 7,
    };

    dumpDelegateScorecard(sid, state, true, "deterministic");

    const expectedDir = join(tmpdir(), "opencode-model-router-trajectory");
    const path = join(expectedDir, `${sid}.delegate.log`);
    expect(existsSync(path)).toBe(true);

    const contents = readFileSync(path, "utf-8");
    expect(contents).toContain("[router delegate scorecard");
    expect(contents).toContain("final_tier=medium");
    expect(contents).toContain("attempts=3");
    expect(contents).toContain("escalations=1");
    expect(contents).toContain("cost=7");
    expect(contents).toContain("verdict=PASS");
    expect(contents).toContain("method=deterministic");
    expect(contents.endsWith("\n")).toBe(true);
  });

  it("appends multiple scorecards without truncating prior entries", () => {
    const sid = `sid-multi-${process.pid}-${Date.now()}`;
    const base = {
      currentTier: "fast",
      attemptsThisTier: 1,
      totalAttempts: 1,
      escalations: 0,
      firstAttemptCost: 1,
      cumulativeCost: 1,
    };

    dumpDelegateScorecard(sid, { ...base }, true, "deterministic");
    dumpDelegateScorecard(sid, { ...base, totalAttempts: 2 }, false, "checker");

    const path = join(tmpdir(), "opencode-model-router-trajectory", `${sid}.delegate.log`);
    const contents = readFileSync(path, "utf-8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("verdict=PASS");
    expect(lines[1]).toContain("verdict=UNMET");
    expect(lines[1]).toContain("attempts=2");
  });

  it("is a best-effort no-op when the underlying write fails (does not throw)", () => {
    // Construct a state object with a non-serializable symbol to force
    // writeFileSync to throw. The function must swallow the error.
    const badState: any = {
      currentTier: "fast",
      attemptsThisTier: 1,
      totalAttempts: 1,
      escalations: 0,
      firstAttemptCost: 1,
      cumulativeCost: 1,
    };
    Object.defineProperty(badState, "boom", {
      value: Symbol("boom"),
      enumerable: true,
    });

    // Some platforms may not throw on symbol-toString; guard with typeof.
    let threw = false;
    try {
      dumpDelegateScorecard("sid-bad", badState as any, true, "deterministic");
    } catch {
      threw = true;
    }
    // We accept either path — the contract is "must not throw out of the
    // hook". On platforms that stringify symbols, the call succeeds silently.
    // On platforms that throw, the try/catch swallows the throw.
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.6 — narrowed-shape coverage for verify-dispatch.
//
// PR2 tightened `dispatchGrader` and `verifyTaskAfterHook` so the SDK
// results and hook IO go through narrow interfaces from `src/plugin/types.ts`
// instead of `any`. These tests assert the runtime contract on the narrowed
// shapes: invalid or partial inputs are tolerated, valid inputs still
// drive the gate, and the helper guards (extractSessionId / extractPromptText
// / asTaskToolArgs) are wired through correctly.
// ---------------------------------------------------------------------------

describe("dispatchGrader — narrowed shape tolerance", () => {
  it("tolerates a session.create response with no data field", async () => {
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async () => ({}),
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "p",
    });

    expect(result).toEqual({ sessionID: "", text: "" });
  });

  it("tolerates a session.prompt response with no data.parts field", async () => {
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => ({}),
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "p",
    });

    // No text parts found -> empty text. The sessionID is the default.
    expect(result.sessionID).toBe("sess_x");
    expect(result.text).toBe("");
  });

  it("filters non-text parts and joins text parts with newlines", async () => {
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => ({
        data: {
          parts: [
            { type: "tool_use", id: "t1" },
            { type: "text", text: "line-1" },
            { type: "step-start" },
            { type: "text", text: "line-2" },
          ],
        },
      }),
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "p",
    });

    // Only the two text parts are emitted, joined with a single newline.
    expect(result.text).toBe("line-1\nline-2");
  });

  it("ignores parts whose text field is not a string", async () => {
    const ctx = makeCtx({
      directory: workDir,
      promptImpl: async () => ({
        data: {
          parts: [
            { type: "text", text: 42 },
            { type: "text", text: null },
            { type: "text", text: "ok" },
          ],
        },
      }),
    });

    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "sys",
      prompt: "p",
    });

    expect(result.text).toBe("ok");
  });
});

describe("verifyTaskAfterHook — narrowed shape tolerance", () => {
  it("ignores input whose tool field is not a string", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({ directory: workDir });
    const input = { tool: 123, sessionID: "orch", args: { prompt: "p" } };
    const output = { output: "untouched" };

    await verifyTaskAfterHook(ctx, input, output);

    expect(output.output).toBe("untouched");
  });

  it("tolerates args without subagent_type (treated as empty producerTier)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({ directory: workDir });
    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        prompt: "Do something.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-no-tier" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    // The gate fails (file missing), so a forcing note is appended.
    expect(output.output).toContain("NOT ACCEPTED");
  });

  it("tolerates a missing args object entirely", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({ directory: workDir });
    const input = { tool: "task", sessionID: "orch" };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-no-args" },
    };

    // asTaskToolArgs(undefined) returns {} — the gate runs with empty
    // producerTier, prompt, and description.
    await expect(verifyTaskAfterHook(ctx, input, output)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 5 matrix — ambiguous verify.require values in the dispatcher.
//
// The dispatcher's buildGateDeps() reads `cfg.enforcement?.verify?.require`
// and passes it through. With Phase 5, an unknown value is rejected at
// config-load time (validateConfig) AND coerced to "always" at the gate
// boundary. These tests pin both ends of the contract for the dispatcher:
//   - buildGateDeps passes the raw value through (it is not the layer that
//     normalizes — the gate is).
//   - verifyTaskAfterHook with an unknown require still VERIFIES (not skip)
//     because the gate fails closed.
//   - the supported values keep their existing semantics end-to-end.
// ---------------------------------------------------------------------------

describe("buildGateDeps — Phase 5: pass-through of verify.require", () => {
  it("passes through 'never' unchanged", async () => {
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "never" } } } as any,
    });
    const deps = await buildGateDeps(ctx);
    expect(deps.require).toBe("never");
  });

  it("passes through 'whenDoDPresent' unchanged", async () => {
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "whenDoDPresent" } } } as any,
    });
    const deps = await buildGateDeps(ctx);
    expect(deps.require).toBe("whenDoDPresent");
  });

  it("passes through 'always' unchanged", async () => {
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "always" } } } as any,
    });
    const deps = await buildGateDeps(ctx);
    expect(deps.require).toBe("always");
  });

  it("passes through an UNKNOWN value (coercion is the gate's job, not dispatcher's)", async () => {
    // Phase 5 contract: buildGateDeps is a pass-through. The gate is the
    // component that calls normalizeRequire(). A test config that bypasses
    // validateConfig can still flow here, and the gate must fail closed.
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "sometimes" } } } as any,
    });
    const deps = await buildGateDeps(ctx);
    expect(deps.require).toBe("sometimes");
  });
});

describe("verifyTaskAfterHook — Phase 5: ambiguous verify.require end-to-end", () => {
  it("require:'never' on a built-in task => no-op (gate would skip)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "never" } } } as any,
    });
    // Create a missing file so the deterministic check WOULD fail, but
    // 'never' should skip verification entirely.
    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt: "[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-never" },
    };
    const original = output.output;

    await verifyTaskAfterHook(ctx, input, output);

    expect(output.output).toBe(original);
  });

  it("require: 'sometimes' (unknown) => verifies (fail-closed) — the gate coerces to 'always'", async () => {
    // Phase 5 contract: an unknown value in the config reaches the gate
    // via buildGateDeps; the gate's normalizeRequire() coerces it to
    // "always", so verification runs. A failing check produces a forcing
    // note — the visible signal of the fail-closed semantic, not a silent
    // skip.
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "sometimes" } } } as any,
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt: "[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-ambiguous" },
    };

    await verifyTaskAfterHook(ctx, input, output);

    // A forcing note is appended — verification RAN, did not skip, and
    // produced a visible failure rather than silently accepting.
    expect(output.output).toContain("NOT ACCEPTED");
  });

  it("require: 'always' on a built-in task with a passing check => no forcing note", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    writeFileSync(join(workDir, "present.txt"), "ok");
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "always" } } } as any,
    });

    const input = {
      tool: "task",
      sessionID: "orch",
      args: {
        subagent_type: "fast",
        prompt: "[acceptance]\ncheck: fileExists path=present.txt\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-always" },
    };
    const original = output.output;

    await verifyTaskAfterHook(ctx, input, output);

    expect(output.output).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// parentSessionID propagation — grader sessions inherit the parent's
// sessionID so OpenCode treats them as child sessions.
// ---------------------------------------------------------------------------

describe("dispatchGrader / buildGateDeps / verifyTaskAfterHook — parentSessionID propagation", () => {
  it("dispatchGrader forwards parentSessionID as parentID on session.create when provided", async () => {
    const createCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "grader-sid" } };
      },
    });
    const result = await dispatchGrader(
      ctx,
      { tier: "fast", system: "", prompt: "verify" },
      "orch-sid-77",
    );
    expect(result.sessionID).toBe("grader-sid");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ body: { parentID: "orch-sid-77" } });
  });

  it("dispatchGrader passes {} (no parentID) to session.create when parentSessionID is omitted", async () => {
    const createCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "grader-sid" } };
      },
    });
    const result = await dispatchGrader(ctx, {
      tier: "fast",
      system: "",
      prompt: "verify",
    });
    expect(result.sessionID).toBe("grader-sid");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({});
  });

  it("buildGateDeps threads parentSessionID from the closure to dispatchGrader", async () => {
    const createCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "grader-sid" } };
      },
    });
    const deps = await buildGateDeps(ctx, "orch-sid-99");
    await deps.checker.dispatchGrader({ tier: "fast", system: "", prompt: "x" });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ body: { parentID: "orch-sid-99" } });
  });

  it("buildGateDeps without parentSessionID leaves dispatchGrader parentless", async () => {
    const createCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "grader-sid" } };
      },
    });
    const deps = await buildGateDeps(ctx);
    await deps.checker.dispatchGrader({ tier: "fast", system: "", prompt: "x" });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({});
  });

  it("verifyTaskAfterHook forwards parentSessionID from output.metadata to the grader session (orchestrator-parented grader)", async () => {
    // PR2 / Unit 2 — flipped from the pre-PR1 "parentless" assertion. The
    // contract is now metadata-first: when output.metadata.parentSessionId
    // is present, the grader session is created as a child of that
    // orchestrator/root session, NOT as a new root.
    // (SDD change: fix-task-verifier-session-parenting.)
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const createCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "always" } } } as any,
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "grader-sid" } };
      },
    });
    const input = {
      tool: "task",
      sessionID: "subagent-sid-ignored",
      args: {
        subagent_type: "fast",
        prompt:
          "[acceptance]\ncriteria: result is reasonable\ndeliverable: a report\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: {
        sessionId: "child-prop",
        parentSessionId: "orch-sid-parent",
      },
    };
    await verifyTaskAfterHook(ctx, input, output);
    // DoD has no deterministic checks -> gate runs the checker path ->
    // dispatchGrader is called once with parentID taken from metadata.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ body: { parentID: "orch-sid-parent" } });
  });

  it("verifyTaskAfterHook leaves grader sessions parentless when metadata has no parentSessionId (fallback)", async () => {
    // PR2 / Unit 2 — kept from the pre-PR1 contract: when the metadata
    // does NOT include parentSessionId (absent, non-object, missing field,
    // or non-string), grader creation stays parentless. The hook MUST NOT
    // throw, and MUST NOT silently substitute input.sessionID.
    // (SDD change: fix-task-verifier-session-parenting — fallback path.)
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const createCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "always" } } } as any,
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "grader-sid" } };
      },
    });
    const input = {
      tool: "task",
      sessionID: "subagent-sid",
      args: {
        subagent_type: "fast",
        prompt:
          "[acceptance]\ncriteria: result is reasonable\ndeliverable: a report\n[/acceptance]",
      },
    };
    // No parentSessionId in metadata — fallback path: parentless grader.
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: { sessionId: "child-fallback" },
    };
    await verifyTaskAfterHook(ctx, input, output);
    // dispatchGrader is called with {} (no parentID) when metadata is absent.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({});
  });

  it("verifyTaskAfterHook never uses input.sessionID as the grader parentID (regression)", async () => {
    // PR2 / Unit 2 — regression for the subagent-session-hang vector.
    // Even when input.sessionID is a plausible value (a real-looking
    // session id), the verify-after-task hook MUST derive the grader
    // parent from output.metadata.parentSessionId only. Forwarding the
    // subagent SID caused the SDK to attempt creating a child of a
    // subagent session, which hangs the opencode runtime permanently
    // (SDD change: fix-subagent-session-hang).
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const createCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      cfg: { enforcement: { verify: { require: "always" } } } as any,
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "grader-sid" } };
      },
    });
    const input = {
      tool: "task",
      // Deliberately a "subagent SID" — must NEVER be forwarded as parentID.
      sessionID: "subagent-sid-NEVER-FORWARD",
      args: {
        subagent_type: "fast",
        prompt:
          "[acceptance]\ncriteria: result is reasonable\ndeliverable: a report\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata: {
        sessionId: "child-sid",
        parentSessionId: "real-orch-parent",
      },
    };
    await verifyTaskAfterHook(ctx, input, output);
    // Parent must come from metadata, NOT from input.sessionID.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ body: { parentID: "real-orch-parent" } });
    // Belt-and-braces: explicit non-equality with the subagent SID path.
    expect(createCalls[0]).not.toEqual({
      body: { parentID: "subagent-sid-NEVER-FORWARD" },
    });
  });

  it("dispatchGrader still creates a child session when the grader prompt fails", async () => {
    const createCalls: unknown[] = [];
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "grader-sid" } };
      },
      promptImpl: async () => {
        throw new Error("grader boom");
      },
    });

    await expect(
      dispatchGrader(ctx, { tier: "fast", system: "", prompt: "verify" }, "orch-sid-fail"),
    ).rejects.toThrow("grader boom");

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ body: { parentID: "orch-sid-fail" } });
  });

  it("dispatchGrader rejects on timeout when session.create hangs", async () => {
    // Simulate the withTimeout-rejected error shape (what session.create
    // would throw after the 30s timeout). We avoid the actual 30s wait by
    // throwing immediately with the same error message contract — the test
    // verifies the dispatchGrader surface, not the timer itself.
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async () => {
        throw new Error("grader session.create timed out after 30000ms");
      },
    });
    await expect(
      dispatchGrader(ctx, { tier: "fast", system: "", prompt: "verify" }),
    ).rejects.toThrow("timed out after");
  });

  it("dispatchGrader cleans up graderSessions on timeout", async () => {
    // Simulate the withTimeout-rejected error so we don't actually wait 30s.
    const ctx = makeCtx({
      directory: workDir,
      createImpl: async () => {
        throw new Error("grader session.create timed out after 30000ms");
      },
    });
    try {
      await dispatchGrader(ctx, { tier: "fast", system: "", prompt: "verify" });
    } catch {
      // expected — timeout rejects
    }
    // graderSessions must be empty — no leaked tracking entries on hang
    expect(ctx.graderSessions.size).toBe(0);
  });
});
