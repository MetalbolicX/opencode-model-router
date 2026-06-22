import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchGrader,
  buildGateDeps,
  verifyTaskAfterHook,
} from "../../src/verify/dispatch";
import { dumpDelegateScorecard } from "../../src/escalate/ladder";
import type { PluginContext } from "../../src/plugin/context";
import type { RouterConfig } from "../../src/router/config";
import { createFsSeam } from "../../src/utils/fs";

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
}

function makeCtx(opts: {
  directory: string;
  createImpl?: (req: any) => Promise<any>;
  promptImpl?: (req: any) => Promise<any>;
  cfg?: Partial<RouterConfig>;
  changedFiles?: { path: string; status: string }[];
  sessionStore?: FakeStore;
}): PluginContext {
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
    ...(opts.sessionStore ?? {}),
  };

  return {
    plugin: {
      directory: opts.directory,
      client: {
        session: {
          create: opts.createImpl ?? (async () => ({ data: { id: "sess_x" } })),
          prompt: opts.promptImpl ?? (async () => ({ data: { parts: [] } })),
        },
      },
    } as any,
    initialConfig: cfg,
    activeTiersAtLoad: { fast: cfg.presets.default.fast },
    getConfig: () => cfg,
    refreshConfig: () => cfg,
    state: { bypassed: false },
    sessionStore: sessionStore as any,
    trajectoryStore: { ensure: () => undefined, recordToolEvent: () => undefined, dump: () => null } as any,
    guardStore: { get: () => undefined, clear: () => undefined } as any,
    changedFileStore: {
      get: () => opts.changedFiles ?? [],
      clear: () => undefined,
      record: () => undefined,
    } as any,
    graderSessions: new Set<string>(),
    verifyMutex: { runExclusive: async (_k: string, fn: () => Promise<any>) => fn() } as any,
    seams: {
      exec: (async () => ({ code: 0, stdout: "", stderr: "", timedOut: false })) as any,
      fs: createFsSeam({ directory: opts.directory }),
    },
  };
}

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

    await expect(
      dispatchGrader(ctx, { tier: "fast", system: "sys", prompt: "p" }),
    ).rejects.toThrow("boom");

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
});

// ---------------------------------------------------------------------------
// buildGateDeps
// ---------------------------------------------------------------------------

describe("buildGateDeps", () => {
  it("returns a GateDeps with deterministic seams from ctx.seams and verifyMutex", () => {
    const ctx = makeCtx({ directory: workDir });
    const deps = buildGateDeps(ctx);

    expect(deps.deterministic.cwd).toBe(workDir);
    expect(deps.deterministic.exec).toBe(ctx.seams.exec);
    expect(deps.deterministic.fs).toBe(ctx.seams.fs);
    expect(deps.deterministic.mutex).toBe(ctx.verifyMutex);
  });

  it("reads enforce.verify.minGraderTier and enforce.verify.require from ctx.getConfig()", () => {
    const ctx = makeCtx({
      directory: workDir,
      cfg: {
        enforcement: {
          mode: "advisory",
          verify: { minGraderTier: "ultra", require: "always" },
        } as any,
      },
    });

    const deps = buildGateDeps(ctx);
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

    const deps = buildGateDeps(ctx);
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
        prompt:
          "Create the file.\n[acceptance]\ncheck: fileExists path=present.txt\n[/acceptance]",
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
        prompt:
          "Create the file.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
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

    const path = join(
      tmpdir(),
      "opencode-model-router-trajectory",
      `${sid}.delegate.log`,
    );
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
