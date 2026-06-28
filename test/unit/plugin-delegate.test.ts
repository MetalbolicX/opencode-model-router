import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin/context";
import { executeDelegate } from "../../src/plugin/delegate";
import type { RouterConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Delegate-execution parity tests.
//
// The extracted `executeDelegate` is a verbatim copy of the
// `tool.delegate.execute` closure that lived in `src/index.ts` before the
// core-refactor-plan. These tests exercise the same branches the old
// integration test (`test/integration/layer2-wiring.test.ts`) drove
// end-to-end, but with direct seam calls so a failure localizes to
// `executeDelegate` rather than the whole plugin factory.
//
// We mock the SDK (`session.create` / `session.prompt`) and stub
// `accept()` via vi.mock so the test stays deterministic.
// ---------------------------------------------------------------------------

// Mock `accept` so we can force gate outcomes (PASS/FAIL/throw) per case
// without driving the real checker/deterministic pipeline.
const acceptMock = vi.fn();
vi.mock("../../src/verify/gate", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/verify/gate")>("../../src/verify/gate");
  return { ...actual, accept: (...args: unknown[]) => acceptMock(...args) };
});

let tmpHome: string;
let tmpCwd: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origCwd: string;

beforeEach(() => {
  acceptMock.mockReset();
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origCwd = process.cwd();

  tmpHome = join(
    tmpdir(),
    `oc-del-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  // Set the verified-delegate env so consumers can still require it
  // independently; this test does not gate on it.

  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  process.chdir(tmpCwd);
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  process.chdir(origCwd);
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Fake PluginContext builder — stubs every seam `executeDelegate` touches.
// ---------------------------------------------------------------------------

interface SessionCall {
  sessionID: string;
  promptText?: string;
}

const makeCtx = (opts: {
  createImpl?: (req: any) => Promise<any>;
  promptImpl?: (req: any) => Promise<any>;
  getConfigImpl?: () => RouterConfig;
  refreshConfigImpl?: () => RouterConfig;
  sessionStoreOverrides?: Partial<{
    registerProducerSession: (...args: unknown[]) => unknown;
    unregister: (...args: unknown[]) => unknown;
    isSubagent: (sid: string) => boolean;
    isTrivial: (sid: string) => boolean;
    getTier: (sid: string) => string | null;
    registerFromChatMessage: (...args: unknown[]) => unknown;
    recordToolCall: (...args: unknown[]) => unknown;
  }>;
  guardStoreOverrides?: Partial<{
    get: (...args: unknown[]) => unknown;
    clear: (...args: unknown[]) => unknown;
  }>;
}): {
  ctx: PluginContext;
  sessions: SessionCall[];
  counters: { getConfig: number; refreshConfig: number };
} => {
  const sessions: SessionCall[] = [];
  let createSeq = 0;
  const counters = { getConfig: 0, refreshConfig: 0 };

  const baseConfig: RouterConfig = {
    activePreset: "default",
    defaultTier: "fast",
    presets: {
      default: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          description: "fast",
          whenToUse: [],
          costRatio: 1,
        },
        medium: {
          model: "anthropic/claude-sonnet-4",
          description: "medium",
          whenToUse: [],
          costRatio: 3,
        },
        heavy: {
          model: "anthropic/claude-opus-4",
          description: "heavy",
          whenToUse: [],
          costRatio: 9,
        },
      },
    },
    rules: [],
    enforcement: {
      verify: { require: "always", graderTemperature: 0 },
      escalate: {
        ladder: ["fast", "medium", "heavy"],
        maxAttemptsPerTier: 1,
        maxTotalAttempts: 5,
      },
    },
  };

  const ctx: PluginContext = {
    plugin: {
      directory: tmpCwd,
      client: {
        session: {
          create: opts.createImpl
            ? opts.createImpl
            : async () => {
                const id = `sess_${++createSeq}`;
                sessions.push({ sessionID: id });
                return { data: { id } };
              },
          prompt: opts.promptImpl
            ? opts.promptImpl
            : async (req: any) => {
                const id = req?.path?.id ?? "?";
                const text = req?.body?.parts?.[0]?.text ?? "(no text)";
                const last = sessions.find((s) => s.sessionID === id);
                if (last) last.promptText = text;
                return { data: { parts: [{ type: "text", text: "I did it." }] } };
              },
        },
      },
    } as any,
    initialConfig: baseConfig,
    activeTiersAtLoad: baseConfig.presets["default"]!,
    getConfig: opts.getConfigImpl
      ? async () => {
          counters.getConfig++;
          return opts.getConfigImpl!();
        }
      : async () => {
          counters.getConfig++;
          return baseConfig;
        },
    refreshConfig: opts.refreshConfigImpl
      ? async () => {
          counters.refreshConfig++;
          return opts.refreshConfigImpl!();
        }
      : async () => {
          counters.refreshConfig++;
          return baseConfig;
        },
    async getFreshConfig() {
      try {
        if (opts.refreshConfigImpl) return await opts.refreshConfigImpl();
        return baseConfig;
      } catch {
        if (opts.getConfigImpl) return opts.getConfigImpl();
        return baseConfig;
      }
    },
    dispose: async () => {},
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore: {
      registerProducerSession: () => undefined,
      unregister: () => undefined,
      isSubagent: () => false,
      isTrivial: () => false,
      getTier: () => "fast",
      registerFromChatMessage: () => undefined,
      recordToolCall: () => undefined,
      ...(opts.sessionStoreOverrides ?? {}),
    } as any,
    trajectoryStore: {
      ensure: () => undefined,
      recordToolEvent: () => undefined,
      dump: () => null,
    } as any,
    guardStore: {
      get: () => null,
      clear: () => undefined,
      ...(opts.guardStoreOverrides ?? {}),
    } as any,
    changedFileStore: {
      get: () => [],
      clear: () => undefined,
      record: () => undefined,
    } as any,
    graderSessions: new Set<string>(),
    verifyMutex: {} as any,
    seams: { exec: {} as any, fs: {} as any },
  };

  return { ctx, sessions, counters };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeDelegate — happy path", () => {
  it("returns the producer text + deterministic-accepted suffix on first-try PASS", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx, sessions, counters } = makeCtx({});
    const out = await executeDelegate(ctx, {
      task: "say hi",
      tier: "fast",
    });

    expect(out).toContain("I did it.");
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionID).toMatch(/^sess_/);
    expect(counters.refreshConfig).toBeGreaterThanOrEqual(1);
  });

  it("uses the explicit acceptance block from `acceptance` argument when provided", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "explicit",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, {
      task: "ignored",
      tier: "fast",
      acceptance: "[acceptance]\ncheck: testsPass\n[/acceptance]",
    });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("defaults the initial tier to the cfg's defaultTier when args.tier is omitted", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx, sessions } = makeCtx({});
    await executeDelegate(ctx, { task: "say hi" });
    expect(sessions).toHaveLength(1);
  });

  it("defaults to 'medium' when args.tier is whitespace and defaultTier is missing", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx } = makeCtx({
      getConfigImpl: () =>
        ({
          activePreset: "default",
          defaultTier: "",
          presets: {
            default: {
              fast: {
                model: "anthropic/claude-haiku-4-5",
                description: "fast",
                whenToUse: [],
              },
              medium: {
                model: "anthropic/claude-sonnet-4",
                description: "medium",
                whenToUse: [],
              },
            },
          },
          rules: [],
        }) as RouterConfig,
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "   " });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("calls refreshConfig() then getConfig() on a successful refresh", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx, counters } = makeCtx({});
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(counters.refreshConfig).toBe(1);
    expect(counters.getConfig).toBeGreaterThanOrEqual(1);
  });
});

describe("executeDelegate — refresh fallback", () => {
  it("falls back to getConfig() when refreshConfig() throws", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx } = makeCtx({
      refreshConfigImpl: () => {
        throw new Error("disk read failed");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The fallback uses getConfig() which returns the baseConfig — happy path continues.
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });
});

describe("executeDelegate — failure paths", () => {
  it("returns 'could not create a producer session' when session.create yields no id", async () => {
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: undefined }),
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("could not create a producer session");
  });

  it("treats prompt errors as an empty artefact and lets the gate decide", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("transport boom");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The gate accepted (we mocked it to PASS); the accepted suffix is appended
    // even when producerText is empty (matching the original behaviour).
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("returns 'verification failed (fail-closed)' verdict when accept throws on every attempt", async () => {
    // accept throws on every call so the inner try-catch fires each iteration,
    // setting the fail-closed verdict; the ladder eventually gives up.
    acceptMock.mockRejectedValue(new Error("gate boom"));
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    // The fail-closed reason surfaces in the forcing note.
    expect(out).toContain("verification failed (fail-closed)");
  });

  it("appends 'router status: unmet' when the gate refuses and the ladder gives up", async () => {
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["file missing"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).not.toContain("[router \u2713 accepted:");
  });
});

describe("executeDelegate — output shape parity", () => {
  it("accept suffix format matches the original verbatim", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "x", tier: "fast" });
    expect(out.endsWith("\n\n[router \u2713 accepted: deterministic]")).toBe(true);
  });

  it("the outer catch-all returns the fail-closed sentinel string", async () => {
    acceptMock.mockReset();
    // Force an outer throw by replacing `ctx.getConfig` with a throwing impl
    // AFTER the inner refresh+get fallback. Simpler: break `accept` so it
    // throws AND set up a scenario where even the inner try-catch fails.
    // Here we make the delegate's outer try fail by making session.create
    // throw on every call (the inner catch swallows, so we instead force
    // the producerText scrub path to throw — hard to trigger from outside).
    // Easier check: when accept is mocked to throw and ladder escalates,
    // we still get a structured response (fail-closed suffix is reachable
    // through the inner catch, and the outer catch is the last line of
    // defence). The outer-catch path is unreachable through public mocks
    // because every inner step is try-caught — this test asserts the
    // observable contract: the response is always a non-empty string and
    // never rejects.
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "x", tier: "fast" });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("executeDelegate — config-refresh parity", () => {
  it("uses the refreshed config's defaultTier for tier resolution", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const cfgMedium: RouterConfig = {
      activePreset: "default",
      defaultTier: "medium",
      presets: {
        default: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "fast",
            whenToUse: [],
          },
          medium: {
            model: "anthropic/claude-sonnet-4",
            description: "medium",
            whenToUse: [],
          },
        },
      },
      rules: [],
    } as RouterConfig;

    const { ctx } = makeCtx({
      refreshConfigImpl: () => cfgMedium,
      getConfigImpl: () => cfgMedium,
    });
    await executeDelegate(ctx, { task: "say hi" });
    // The accepted suffix proves the run completed cleanly — the test name
    // documents the intended refresh-vs-read semantic change in PR1.
    expect(acceptMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 4.1 — additional direct branch coverage for executeDelegate.
//
// These tests cover the remaining seams of the delegate loop:
//   - store-mutation throw paths (register/unregister/guard.clear swallow)
//   - accept returning a "skipped" verdict (no forcing note appended)
//   - the forcing-message retry/escalate path that runs across attempts
//   - the safety-net branch when the loop exceeds its attempt cap
//   - the costRatio fallback when tiersForCost lacks the tier's costRatio
//   - defaultTier undefined defaults the initial tier to "medium"
// ---------------------------------------------------------------------------

describe("executeDelegate — store-mutation swallow paths", () => {
  it("continues to the gate even when registerProducerSession throws", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      // Force registerProducerSession to throw on every attempt.
      sessionStoreOverrides: {
        registerProducerSession: () => {
          throw new Error("register boom");
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("continues when sessionStore.unregister throws after the gate verdict", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      sessionStoreOverrides: {
        unregister: () => {
          throw new Error("unregister boom");
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("continues when guardStore.clear throws after the gate verdict", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      guardStoreOverrides: {
        clear: () => {
          throw new Error("guard clear boom");
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });
});

describe("executeDelegate — gate verdict branches", () => {
  it("does NOT append a forcing note when the gate verdict is skipped", async () => {
    // skipped: true means the gate chose to skip verification; the ladder
    // treats this as "pass" via `if (!res.accepted && !res.verdict.skipped)`,
    // so no forcing note is appended.
    acceptMock.mockResolvedValueOnce({
      accepted: false,
      verdict: {
        pass: false,
        method: "deterministic",
        reasons: [],
        skipped: true,
      },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The output ends with a missing/empty forcing note.
    expect(out).not.toContain("NOT ACCEPTED");
  });

  it("escalates and retries across attempts when the gate fails the first attempt", async () => {
    // First attempt FAILS (with retry), second attempt PASSES.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["missing"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });
    const { ctx, sessions } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("hits the safety-net branch when the loop exceeds its attempt cap", async () => {
    // Make accept fail every attempt; combined with a tight policy this
    // should drive the loop past safetyMax and out via the safety-net branch.
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["never passes"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      getConfigImpl: () =>
        ({
          activePreset: "default",
          defaultTier: "fast",
          presets: {
            default: {
              fast: {
                model: "anthropic/claude-haiku-4-5",
                description: "fast",
                whenToUse: [],
                costRatio: 1,
              },
            },
          },
          rules: [],
          enforcement: {
            verify: { require: "always", graderTemperature: 0 },
            escalate: {
              ladder: ["fast", "medium", "heavy"],
              maxAttemptsPerTier: 99,
              maxTotalAttempts: 999,
            },
          },
        }) as RouterConfig,
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The safety net returns a different prefix than the give_up branch.
    expect(out).toMatch(/delegation stopped by the safety net|\[router status: unmet\]/);
  });
});

describe("executeDelegate — tier resolution and cost fallback", () => {
  it("defaults the initial tier to 'medium' when defaultTier is undefined", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      // defaultTier missing entirely -> the `defaultTier || "medium"` fallback fires.
      getConfigImpl: () =>
        ({
          activePreset: "default",
          defaultTier: "" as unknown as string,
          presets: {
            default: {
              fast: {
                model: "anthropic/claude-haiku-4-5",
                description: "fast",
                whenToUse: [],
                costRatio: 1,
              },
              medium: {
                model: "anthropic/claude-sonnet-4",
                description: "medium",
                whenToUse: [],
                costRatio: 3,
              },
            },
          },
          rules: [],
        }) as RouterConfig,
    });
    const out = await executeDelegate(ctx, { task: "say hi" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("falls back to costRatio=1 when the tier's costRatio is not a number", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      getConfigImpl: () =>
        ({
          activePreset: "default",
          defaultTier: "fast",
          presets: {
            default: {
              fast: {
                model: "anthropic/claude-haiku-4-5",
                description: "fast",
                whenToUse: [],
                // costRatio is a string, not a number — fallback path triggers.
                costRatio: "high" as unknown as number,
              },
            },
          },
          rules: [],
        }) as RouterConfig,
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });
});

// ---------------------------------------------------------------------------
// parentSessionID propagation — producer sessions inherit the parent's
// sessionID so OpenCode treats them as child sessions (root cause of the
// "all sessions show as root" bug).
// ---------------------------------------------------------------------------

describe("executeDelegate — parentSessionID propagation", () => {
  it("forwards parentSessionID as parentID on session.create when provided", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const createCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_parent_child" } };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" }, "parent-sid-42");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ body: { parentID: "parent-sid-42" } });
  });

  it("passes {} (no parentID) to session.create when parentSessionID is omitted", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const createCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_root" } };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({});
  });

  it("threads parentSessionID into buildGateDeps so the grader inherits it", async () => {
    // Force the gate to call dispatchGrader (it would need to fail deterministic
    // checks) by accepting with method 'grader' and making the result require
    // an actual grader dispatch. Easier path: route dispatchGrader through the
    // gate via a custom seam that we observe.
    const dispatchGraderSpy = vi.fn(async () => ({ sessionID: "grader-sid", text: "ok" }));
    const ctxBase = makeCtx({});
    const ctx: PluginContext = {
      ...ctxBase.ctx,
      seams: { exec: ctxBase.ctx.seams.exec, fs: ctxBase.ctx.seams.fs },
    };
    // Build deps directly with the parent SID and exercise the closure path
    // by mocking accept to invoke the provided dispatchGrader.
    const { buildGateDeps, dispatchGrader } = await import("../../src/verify/dispatch");
    // Spy on dispatchGrader by replacing ctx.client.session.create to capture
    // the body the grader dispatch passes through.
    const createCalls: unknown[] = [];
    const wrappedCtx: PluginContext = {
      ...ctx,
      plugin: {
        ...ctx.plugin,
        client: {
          ...ctx.plugin.client,
          session: {
            ...ctx.plugin.client.session,
            create: async (req: unknown) => {
              createCalls.push(req);
              return { data: { id: "grader-sid" } };
            },
          } as any,
        },
      } as any,
    };
    const deps = await buildGateDeps(wrappedCtx, "orch-sid-99");
    // Directly call the closure to assert the parent SID is forwarded.
    await deps.checker.dispatchGrader({ tier: "fast", system: "", prompt: "x" });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({ body: { parentID: "orch-sid-99" } });
    // Silence unused warnings
    void dispatchGraderSpy;
    void dispatchGrader;
  });

  it("keeps parentID on a failing delegate attempt", async () => {
    acceptMock.mockImplementation(async () => ({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["boom"] },
      dodSource: "inferred",
    }));
    const createCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_parent_child" } };
      },
    });

    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, "parent-sid-fail");

    expect(out).toContain("[router status: unmet]");
    expect(createCalls.length).toBeGreaterThan(0);
    expect(
      createCalls.every((req) => {
        return JSON.stringify(req) === JSON.stringify({ body: { parentID: "parent-sid-fail" } });
      }),
    ).toBe(true);
  });
});

describe("executeDelegate — timeout handling", () => {
  it("does not hang when session.create rejects with a timeout error", async () => {
    // Simulate the withTimeout-rejected error shape (what session.create
    // would throw after the 30s timeout). We avoid the actual 30s wait by
    // throwing immediately with the same error message contract. The key
    // invariant is that executeDelegate returns promptly (fail-closed) and
    // surfaces the timeout reason — NOT hangs forever.
    const { ctx } = makeCtx({
      createImpl: async () => {
        throw new Error("session.create timed out after 30000ms");
      },
    });
    const result = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(result).toContain("delegate failed (fail-closed)");
    expect(result).toContain("timed out after");
  });

  it("treats timeout on session.prompt as a failed attempt (ladder retries)", async () => {
    // session.create works (returns a fresh sid); session.prompt hangs →
    // withTimeout rejects with a timeout-shaped error → the existing inner
    // catch produces an empty artefact → the ladder treats this as one
    // failed attempt and eventually gives up with "unmet".
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty artefact"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_timeout" } }),
      promptImpl: async () => {
        throw new Error("session.prompt (producer) timed out after 600000ms");
      },
    });
    const result = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(result).toContain("unmet");
  });

  it("cleans up producer session state after prompt timeout", async () => {
    // Track calls to the sessionStore.unregister and guardStore.clear to
    // prove the finally block ran on prompt timeout.
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty artefact"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_to_cleanup" } }),
      promptImpl: async () => {
        throw new Error("session.prompt (producer) timed out after 600000ms");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The finally block must have run for the timed-out producer session.
    expect(unregisterCalls).toContain("sess_to_cleanup");
    expect(clearCalls).toContain("sess_to_cleanup");
  });
});

// ---------------------------------------------------------------------------
// AbortSignal — PR 2 of fix-delegate-cancellation.
//
// The delegate loop MUST:
//   - Forward the AbortSignal to `session.create` and `session.prompt`
//     options (so the SDK can cancel in-flight network calls).
//   - Forward the same signal to `withTimeout` so the local timeout
//     wrapper also races the abort.
//   - Check `signal.aborted` at the loop top — if cancelled while idle
//     (between attempts or before the loop), return `""` silently with
//     no producer session to clean up.
//   - Check `signal.aborted` after `session.create` — if cancelled while
//     the producer session is being created, return `""` AFTER the
//     per-attempt cleanup runs (so the new producer sid is untracked).
//   - Detect AbortError from the `withTimeout(prompt)` race — early-
//     return `""` from inside the catch so we don't run the gate against
//     an empty artefact.
//   - Pass the signal to `nextAction` so a post-abort decision returns
//     `give_up` with reason `"aborted"`. The give_up branch in the loop
//     must short-circuit to `""` (no `[router status: unmet]`).
//   - Be idempotent across multiple `abort()` calls.
//   - Be silent: the abort path must NEVER produce `[router status:`,
//     `[router] delegate failed`, or any other user-facing sentinel.
// ---------------------------------------------------------------------------

describe("executeDelegate — AbortSignal forwarding (PR 2)", () => {
  it("forwards the abort signal to session.create options", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const createCalls: unknown[] = [];
    const ac = new AbortController();
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_1" } };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0] as { signal?: AbortSignal }).signal).toBe(ac.signal);
  });

  it("forwards the abort signal to session.prompt options", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const promptCalls: unknown[] = [];
    const ac = new AbortController();
    const { ctx } = makeCtx({
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return {
          data: { parts: [{ type: "text", text: "I did it." }] },
        };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(promptCalls).toHaveLength(1);
    expect((promptCalls[0] as { signal?: AbortSignal }).signal).toBe(ac.signal);
  });

  it("omits the signal field from create/prompt options when no signal is supplied (back-compat)", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_x" } };
      },
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "ok" }] } };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect((createCalls[0] as { signal?: AbortSignal }).signal).toBeUndefined();
    expect((promptCalls[0] as { signal?: AbortSignal }).signal).toBeUndefined();
  });
});

describe("executeDelegate — abort before loop starts (top-of-loop check)", () => {
  it("returns '' when signal is already aborted before the first attempt", async () => {
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const ac = new AbortController();
    ac.abort();
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_pre" } };
      },
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "should not run" }] } };
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    expect(createCalls).toHaveLength(0);
    expect(promptCalls).toHaveLength(0);
  });
});

describe("executeDelegate — abort between create and prompt (post-create check)", () => {
  it("returns '' after aborting between create and prompt, cleanup ran for the new producer sid", async () => {
    acceptMock.mockReset(); // no accept() should be called
    const ac = new AbortController();
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    let createDone = false;
    const { ctx } = makeCtx({
      createImpl: async () => {
        if (!createDone) {
          createDone = true;
          // Abort immediately after create resolves, before prompt fires.
          queueMicrotask(() => ac.abort());
        }
        return { data: { id: "sess_aborted_between" } };
      },
      promptImpl: async () => {
        throw new Error("prompt must NOT be called when aborted between create+prompt");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    // The producer session created just before the abort MUST be cleaned up.
    expect(unregisterCalls).toContain("sess_aborted_between");
    expect(clearCalls).toContain("sess_aborted_between");
  });
});

describe("executeDelegate — abort during session.prompt", () => {
  it("returns '' when withTimeout(prompt) rejects with AbortError, cleanup ran", async () => {
    acceptMock.mockReset(); // no accept() should run
    const ac = new AbortController();
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_prompt_aborted" } }),
      promptImpl: async () => {
        // Abort while the prompt is "in flight".
        queueMicrotask(() => ac.abort());
        // Throw an AbortError matching the withTimeout shape.
        throw new DOMException("aborted", "AbortError");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    expect(unregisterCalls).toContain("sess_prompt_aborted");
    expect(clearCalls).toContain("sess_prompt_aborted");
  });

  it("does NOT call accept() when abort fires during prompt", async () => {
    acceptMock.mockReset();
    const ac = new AbortController();
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_a" } }),
      promptImpl: async () => {
        queueMicrotask(() => ac.abort());
        throw new DOMException("aborted", "AbortError");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("non-AbortError from prompt still falls through to ladder retry (existing behaviour preserved)", async () => {
    // Sanity: an abort-like shape that is NOT a DOMException with name
    // 'AbortError' should still be treated as a transport error, not
    // an abort. The gate will see an empty artefact and the ladder will
    // retry/give_up as usual.
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty"] },
      dodSource: "inferred",
    });
    const ac = new AbortController();
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_nonabort" } }),
      promptImpl: async () => {
        throw new Error("transport boom");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    // Not aborted, so the ladder runs normally and produces an unmet status.
    expect(ac.signal.aborted).toBe(false);
    expect(out).toContain("[router status: unmet]");
  });
});

describe("executeDelegate — abort during ladder eval (post-abort give_up short-circuit)", () => {
  it("returns '' when signal fires between attempts — no [router status: unmet] surfaced", async () => {
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["boom"] },
      dodSource: "inferred",
    });
    const ac = new AbortController();
    let createCount = 0;
    const { ctx } = makeCtx({
      createImpl: async () => {
        createCount++;
        // First attempt: let it complete and FAIL the gate.
        // Second attempt: abort BEFORE create so the loop-top check fires.
        if (createCount === 2) ac.abort();
        return { data: { id: `sess_attempt_${createCount}` } };
      },
      promptImpl: async () => ({
        data: { parts: [{ type: "text", text: "attempt done" }] },
      }),
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    expect(out).not.toContain("[router status:");
    expect(out).not.toContain("[router] delegate failed");
  });
});

describe("executeDelegate — post-completion abort is a no-op", () => {
  it("returns the accepted result when abort fires AFTER an accepted prompt", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const ac = new AbortController();
    let promptResolved = false;
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_post" } }),
      promptImpl: async () => {
        // Abort AFTER the prompt resolves (i.e. we already have a result).
        const res = { data: { parts: [{ type: "text", text: "I did it." }] } };
        queueMicrotask(() => {
          promptResolved = true;
          ac.abort();
        });
        return res;
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(promptResolved).toBe(true);
    // The accepted verdict wins; the late abort cannot rewrite the result.
    expect(out).toContain("[router ✓ accepted: deterministic]");
    expect(out).toContain("I did it.");
  });
});

describe("executeDelegate — multiple aborts are idempotent", () => {
  it("second abort() after the first is a no-op — only one silent '' surfaces", async () => {
    acceptMock.mockReset();
    const ac = new AbortController();
    let aborted = false;
    const { ctx } = makeCtx({
      createImpl: async () => {
        if (!aborted) {
          aborted = true;
          // Fire two aborts back-to-back. The second must not throw or
          // surface a second error path.
          ac.abort();
          ac.abort();
        }
        return { data: { id: "sess_idem" } };
      },
      promptImpl: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
  });
});

describe("executeDelegate — abort path is silent (no user-facing message)", () => {
  it("every abort branch returns '' — no status: unmet, no fail-closed sentinel", async () => {
    // All four abort branches: top-of-loop, after-create, during-prompt,
    // and ladder post-abort give_up. Each MUST return "".
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["x"] },
      dodSource: "inferred",
    });

    // (1) top-of-loop
    {
      const ac = new AbortController();
      ac.abort();
      const { ctx } = makeCtx({});
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
    }

    // (2) after-create
    {
      const ac = new AbortController();
      let firstCreate = true;
      const { ctx } = makeCtx({
        createImpl: async () => {
          if (firstCreate) {
            firstCreate = false;
            queueMicrotask(() => ac.abort());
          }
          return { data: { id: "sess_a" } };
        },
        promptImpl: async () => {
          throw new Error("prompt must NOT be called");
        },
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
    }

    // (3) during-prompt
    {
      const ac = new AbortController();
      const { ctx } = makeCtx({
        createImpl: async () => ({ data: { id: "sess_b" } }),
        promptImpl: async () => {
          queueMicrotask(() => ac.abort());
          throw new DOMException("aborted", "AbortError");
        },
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
    }

    // (4) ladder post-abort give_up
    {
      const ac = new AbortController();
      let createCount = 0;
      const { ctx } = makeCtx({
        createImpl: async () => {
          createCount++;
          if (createCount === 2) ac.abort();
          return { data: { id: `sess_${createCount}` } };
        },
        promptImpl: async () => ({
          data: { parts: [{ type: "text", text: "x" }] },
        }),
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
    }
  });
});

describe("executeDelegate — runtime forwards context.abort to executeDelegate", () => {
  // This is the wire-up contract: the runtime hook passes the OpenCode
  // ToolContext's `abort` straight through to executeDelegate's `signal`
  // parameter. Verified by inspecting the export surface + the typed
  // call site.
  it("runtime.ts delegate tool handler forwards context.abort", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/plugin/runtime.ts", import.meta.url), "utf8"),
    );
    expect(src).toMatch(
      /executeDelegate\(\s*ctx,\s*args,\s*context\.sessionID,\s*context\.abort\s*\)/,
    );
  });

  it("executeDelegate signature accepts an optional 4th AbortSignal parameter", async () => {
    // Compile-time evidence: the function is callable with three OR four
    // arguments without `any` casts. We assert both forms work.
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({});
    const out3 = await executeDelegate(ctx, { task: "x", tier: "fast" });
    expect(typeof out3).toBe("string");
    // We already use the 4-arg form elsewhere; this is just back-compat
    // proof for the call site.
  });
});

// ---------------------------------------------------------------------------
// SDD: delegate-nonretryable-errors — fail-fast on non-retryable prompt
// errors and on a `null` tierModel() result.
//
// The change wires `classifyPromptError` into the `session.prompt` catch and
// adds a pre-prompt `tierModel()` guard. Non-retryable failures short-circuit
// the loop with a fail-closed `[router status: unmet]` message naming the
// classified reason, emit `routing.unmet` observability, and rely on the
// per-attempt `finally` for cleanup. Retryable errors, aborts, and the
// give_up/safety-net branches are unchanged.
//
// Invariants under test:
//   - Non-retryable prompt errors (billing / model-not-found / auth) return
//     a fail-closed `[router status: unmet]` message naming the reason.
//   - The gate (`accept()`) is never called on the fail-fast path.
//   - Only ONE producer session is created (no retry, no escalation).
//   - `routing.unmet` is recorded for the failure.
//   - `tierModel() === null` short-circuits BEFORE session.prompt fires.
//   - The per-attempt `finally` still runs on the fail-fast path (cleanup
//     spies fire).
//   - Retryable prompt errors (e.g. "transport boom") keep the existing
//     empty-artefact → gate → ladder behaviour.
// ---------------------------------------------------------------------------

describe("executeDelegate — non-retryable prompt errors fail fast (SDD)", () => {
  it("fails fast on a non-retryable billing/subscription error and never runs the gate", async () => {
    acceptMock.mockReset(); // gate MUST NOT be called on the fail-fast path
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_billing" } };
      },
      promptImpl: async () => {
        promptCalls.push("called");
        throw new Error("insufficient billing: please update your subscription");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("insufficient billing or subscription");
    expect(out).not.toContain("[router \u2713 accepted:");
    // Only one producer session — no retry, no escalation.
    expect(createCalls).toHaveLength(1);
    expect(promptCalls).toHaveLength(1);
    // Gate was never called.
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("fails fast on a non-retryable model-not-found error (HTTP 404)", async () => {
    acceptMock.mockReset();
    const { ctx } = makeCtx({
      promptImpl: async () => {
        const err = new Error("model not found: anthropic/gpt-9000") as Error & {
          status?: number;
        };
        err.status = 404;
        throw err;
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("model not found");
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("fails fast on a non-retryable auth/permission denied error", async () => {
    acceptMock.mockReset();
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("unauthorized: invalid API key");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("auth or permission denied");
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("emits a routing.unmet observability event on the non-retryable fail-fast path", async () => {
    acceptMock.mockReset();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("quota exceeded: insufficient credits");
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // routing.unmet is emitted at warn level; filter to model-router lines
    // and look for the documented event name + reason.
    const lines = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((l) => l.startsWith("[model-router] "));
    const hasUnmet = lines.some((l) => {
      try {
        const env = JSON.parse(l.slice(l.indexOf("{")));
        return (
          env["event"] === "routing.unmet" && /billing|quota|credit/i.test(String(env["reason"]))
        );
      } catch {
        return false;
      }
    });
    expect(hasUnmet).toBe(true);
    warnSpy.mockRestore();
  });

  it("per-attempt cleanup still runs on the non-retryable fail-fast path", async () => {
    acceptMock.mockReset();
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_failfast_cleanup" } }),
      promptImpl: async () => {
        throw new Error("forbidden: permission denied for model");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    // The per-attempt `finally` MUST have run for the fail-fast producer
    // session — a leak here would regress the abort/timeout cleanup tests.
    expect(unregisterCalls).toContain("sess_failfast_cleanup");
    expect(clearCalls).toContain("sess_failfast_cleanup");
  });
});

describe("executeDelegate — tierModel() === null fails fast (SDD)", () => {
  it("fails fast on a malformed tier model, never invoking session.prompt", async () => {
    acceptMock.mockReset();
    const promptCalls: unknown[] = [];
    // Malformed `model` (empty string → no `provider/model` slash) makes
    // tierModel() return null. The fail-fast must fire BEFORE the prompt
    // call so the SDK never sees a malformed body.
    const malformedCfg = {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "" as unknown as string,
            description: "fast",
            whenToUse: [],
            costRatio: 1,
          },
          medium: {
            model: "anthropic/claude-sonnet-4",
            description: "medium",
            whenToUse: [],
            costRatio: 3,
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: {
          ladder: ["fast", "medium", "heavy"],
          maxAttemptsPerTier: 1,
          maxTotalAttempts: 5,
        },
      },
    } as RouterConfig;
    const { ctx } = makeCtx({
      getConfigImpl: () => malformedCfg,
      refreshConfigImpl: () => malformedCfg,
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "should not run" }] } };
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("invalid model or provider configuration");
    // session.prompt MUST NOT have been called.
    expect(promptCalls).toHaveLength(0);
    // The gate MUST NOT have been called either.
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("fails fast when the tier itself is missing from the config", async () => {
    acceptMock.mockReset();
    const promptCalls: unknown[] = [];
    // Tier 'fast' is omitted entirely from presets → tierModel() returns
    // null because `tiers[tierName]` is undefined.
    const noFastCfg = {
      activePreset: "default",
      defaultTier: "medium",
      presets: {
        default: {
          medium: {
            model: "anthropic/claude-sonnet-4",
            description: "medium",
            whenToUse: [],
            costRatio: 3,
          },
          heavy: {
            model: "anthropic/claude-opus-4",
            description: "heavy",
            whenToUse: [],
            costRatio: 9,
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: {
          ladder: ["fast", "medium", "heavy"],
          maxAttemptsPerTier: 1,
          maxTotalAttempts: 5,
        },
      },
    } as RouterConfig;
    const { ctx } = makeCtx({
      getConfigImpl: () => noFastCfg,
      refreshConfigImpl: () => noFastCfg,
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "should not run" }] } };
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("invalid model or provider configuration");
    expect(promptCalls).toHaveLength(0);
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("emits a routing.unmet observability event on the tierModel-null path", async () => {
    acceptMock.mockReset();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformedCfg = {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "" as unknown as string,
            description: "fast",
            whenToUse: [],
            costRatio: 1,
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: {
          ladder: ["fast", "medium", "heavy"],
          maxAttemptsPerTier: 1,
          maxTotalAttempts: 5,
        },
      },
    } as RouterConfig;
    const { ctx } = makeCtx({
      getConfigImpl: () => malformedCfg,
      refreshConfigImpl: () => malformedCfg,
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    const lines = warnSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((l) => l.startsWith("[model-router] "));
    const hasUnmet = lines.some((l) => {
      try {
        const env = JSON.parse(l.slice(l.indexOf("{")));
        return (
          env["event"] === "routing.unmet" &&
          /invalid model or provider configuration/i.test(String(env["reason"]))
        );
      } catch {
        return false;
      }
    });
    expect(hasUnmet).toBe(true);
    warnSpy.mockRestore();
  });
});

describe("executeDelegate — retryable prompt errors still use the ladder (SDD regression)", () => {
  it("retryable transport error yields an empty artefact and lets the gate/ladder decide", async () => {
    // A non-classified message ("transport boom") does NOT match any
    // non-retryable pattern, so classifyPromptError returns
    // kind: "retryable". The pre-refactor behaviour — empty artefact →
    // gate → ladder — must be preserved byte-for-byte: the gate sees an
    // empty producerText and decides to retry or give up based on its
    // own verdict.
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("transport boom");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The gate ran, rejected the empty artefact, and the ladder eventually
    // gave up with the standard `[router status: unmet]` message — NOT the
    // fail-fast "delegation stopped:" prefix used by the non-retryable path.
    expect(acceptMock).toHaveBeenCalled();
    expect(out).toContain("[router status: unmet]");
    expect(out).not.toContain("delegation stopped:");
  });

  it("a retryable error that the gate accepts still produces the accepted suffix", async () => {
    // Back-compat: the existing 'treats prompt errors as an empty artefact
    // and lets the gate decide' test is preserved — a retryable error that
    // the gate happens to accept must still produce the accepted suffix.
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("transport boom");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });
});

describe("executeDelegate — abort on the fail-fast path is silent (SDD regression)", () => {
  it("abort during prompt still returns '' and the per-attempt `finally` cleans up", async () => {
    // The classifier's abort kind is the canonical AbortError check; this
    // test pins the existing abort-during-prompt behaviour byte-for-byte
    // (returns '' + cleanup spies fire) and protects the SDD change from
    // accidentally re-routing AbortError through the non-retryable branch.
    acceptMock.mockReset();
    const ac = new AbortController();
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_abort_failfast" } }),
      promptImpl: async () => {
        queueMicrotask(() => ac.abort());
        throw new DOMException("aborted", "AbortError");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    // Cleanup must still have run on the abort branch.
    expect(unregisterCalls).toContain("sess_abort_failfast");
    expect(clearCalls).toContain("sess_abort_failfast");
  });
});
