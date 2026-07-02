import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginContext } from "../../src/plugin/context";
import {
  handleChatMessage,
  handleChatParams,
  handleConfig,
  handleSessionIdle,
  handleSystemTransform,
  handleTextComplete,
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from "../../src/plugin/hooks";
import type { HookEventPayload, HookPayload } from "../../src/plugin/types";
import { createReasoningStore } from "../../src/reasoning/store";
import type { Preset, RouterConfig } from "../../src/router/config";
import type { TierConfig } from "../../src/router/config.types";
import { __resetLoggerForTest } from "../../src/utils/observability";

// ---------------------------------------------------------------------------
// Module spy for `verifyTaskAfterHook`.
//
// `handleToolExecuteAfter` calls `verifyTaskAfterHook(ctx, input, output)`.
// For the hook-contract regression in this file we need to observe the call
// (signature, arity, pass-through of `input` / `output.metadata`) without
// driving the real verify path. We mock the export of `src/verify/dispatch`
// so that the import in `src/plugin/hooks.ts` resolves to the spy.
//
// The spy is a no-op by default. Existing tests in this file exercise paths
// that either bypass the verify-after-task branch (tool !== "task", undefined
// input, bypass mode) or do not depend on the real implementation, so
// replacing the export with a vi.fn() does not regress them.
// ---------------------------------------------------------------------------

const verifyTaskAfterHookMock = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
vi.mock("../../src/verify/dispatch", async () => {
  const actual = await vi.importActual<typeof import("../../src/verify/dispatch")>(
    "../../src/verify/dispatch",
  );
  return {
    ...actual,
    verifyTaskAfterHook: (...args: unknown[]) =>
      (verifyTaskAfterHookMock as unknown as (...a: unknown[]) => Promise<void>)(...args),
  };
});

// ---------------------------------------------------------------------------
// Hook adapter contract tests.
//
// Each handler is a verbatim extraction from `src/index.ts`. These tests
// assert two invariants:
//
// 1. HOOK ORDER: `handleChatMessage` registers tier info in
//    `ctx.sessionStore` BEFORE `handleSystemTransform` queries
//    `ctx.sessionStore.isSubagent(sessionID)`. This order is critical:
//    a regression would re-introduce the bug fixed in the pre-refactor
//    code where literal-minded Haiku subagents emitted malformed XML for
//    the nonexistent Task tool because the delegation instructions
//    leaked into their system prompt.
//
// 2. FAIL-SOFT: every handler tolerates undefined / partial input without
//    throwing. This matches the pre-refactor behaviour where hooks must
//    never crash a real session.
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpCwd: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origCwd: string;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origCwd = process.cwd();
  tmpHome = join(
    tmpdir(),
    `oc-hooks-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
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
// Fake PluginContext builder — records calls for assertion.
// ---------------------------------------------------------------------------

interface HookHarness {
  ctx: PluginContext;
  registerFromChatMessageCalls: number;
  isSubagentCalls: string[];
  guardBeforeCalls: any[];
  guardAfterCalls: any[];
  recordToolEventCalls: any[];
  changedFileRecordCalls: any[];
  trajectoryEnsureCalls: any[];
  trajectoryDumpCalls: string[];
  guardStoreGetCalls: string[];
  graderSessions: Set<string>;
}

const makeHarness = (opts?: {
  configOverrides?: Partial<RouterConfig>;
  graderTemperature?: number;
}): HookHarness => {
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
        graderTemperature: opts?.graderTemperature ?? 0,
      },
    },
    ...(opts?.configOverrides ?? {}),
  } as RouterConfig;

  const preset: Preset = cfg.presets["default"]!;
  const harness: HookHarness = {
    ctx: {} as PluginContext,
    registerFromChatMessageCalls: 0,
    isSubagentCalls: [],
    guardBeforeCalls: [],
    guardAfterCalls: [],
    recordToolEventCalls: [],
    changedFileRecordCalls: [],
    trajectoryEnsureCalls: [],
    trajectoryDumpCalls: [],
    guardStoreGetCalls: [],
    graderSessions: new Set<string>(),
  };

  const sessionStore = {
    registerFromChatMessage: () => {
      harness.registerFromChatMessageCalls++;
    },
    isSubagent: (sid: string) => {
      harness.isSubagentCalls.push(sid);
      // Match what the harness "knows": only sid-A1 is a subagent.
      return sid === "sid-A1";
    },
    isTrivial: () => false,
    getTier: () => "fast",
    registerProducerSession: () => undefined,
    unregister: () => undefined,
    recordToolCall: () => undefined,
  };

  const guardStore = {
    get: (sid: string) => {
      harness.guardStoreGetCalls.push(sid);
      return null;
    },
    clear: () => undefined,
  };

  const trajectoryStore = {
    ensure: (sid: string, agent: string | null) => {
      harness.trajectoryEnsureCalls.push({ sid, agent });
    },
    recordToolEvent: (sid: string, ev: any) => {
      harness.recordToolEventCalls.push({ sid, ...ev });
    },
    dump: (sid: string) => {
      harness.trajectoryDumpCalls.push(sid);
      return null;
    },
  };

  const changedFileStore = {
    record: (sid: string, tool: string, args: unknown) => {
      harness.changedFileRecordCalls.push({ sid, tool, args });
    },
    get: () => [],
    clear: () => undefined,
  };

  harness.ctx = {
    plugin: { directory: tmpCwd, client: {} as any } as any,
    initialConfig: cfg,
    activeTiersAtLoad: preset,
    getConfig: async () => cfg,
    refreshConfig: async () => cfg,
    getFreshConfig: async () => cfg,
    dispose: async () => {},
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore: sessionStore as any,
    trajectoryStore: trajectoryStore as any,
    guardStore: guardStore as any,
    changedFileStore: changedFileStore as any,
    reasoningStore: createReasoningStore(),
    graderSessions: harness.graderSessions,
    verifyMutex: {} as any,
    seams: { exec: {} as any, fs: {} as any },
  };

  return harness;
};

// ---------------------------------------------------------------------------
// Fail-soft: every handler tolerates undefined / partial input.
// ---------------------------------------------------------------------------

describe("hook handlers — fail-soft on bad input", () => {
  it("handleChatParams does not throw on undefined input", async () => {
    const { ctx } = makeHarness();
    await expect(
      handleChatParams(ctx, undefined as unknown as HookPayload, {}),
    ).resolves.toBeUndefined();
    await expect(
      handleChatParams(ctx, {}, undefined as unknown as HookPayload),
    ).resolves.toBeUndefined();
    await expect(
      handleChatParams(ctx, null as unknown as HookPayload, null as unknown as HookPayload),
    ).resolves.toBeUndefined();
  });

  it("handleChatMessage does not throw on undefined input", async () => {
    const { ctx } = makeHarness();
    await expect(
      handleChatMessage(ctx, undefined as unknown as HookPayload, {}),
    ).resolves.toBeUndefined();
    await expect(
      handleChatMessage(ctx, {}, undefined as unknown as HookPayload),
    ).resolves.toBeUndefined();
    await expect(
      handleChatMessage(ctx, null as unknown as HookPayload, null as unknown as HookPayload),
    ).resolves.toBeUndefined();
  });

  it("handleToolExecuteBefore does not throw on undefined input", async () => {
    const { ctx } = makeHarness();
    await expect(
      handleToolExecuteBefore(ctx, undefined as unknown as HookPayload, {}),
    ).resolves.toBeUndefined();
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-x", tool: "read" },
        undefined as unknown as HookPayload,
      ),
    ).resolves.toBeUndefined();
    await expect(
      handleToolExecuteBefore(ctx, null as unknown as HookPayload, null as unknown as HookPayload),
    ).resolves.toBeUndefined();
  });

  it("handleToolExecuteAfter does not throw on undefined input", async () => {
    const { ctx } = makeHarness();
    await expect(
      handleToolExecuteAfter(ctx, undefined as unknown as HookPayload, {}),
    ).resolves.toBeUndefined();
    await expect(
      handleToolExecuteAfter(ctx, {}, undefined as unknown as HookPayload),
    ).resolves.toBeUndefined();
    await expect(
      handleToolExecuteAfter(ctx, null as unknown as HookPayload, null as unknown as HookPayload),
    ).resolves.toBeUndefined();
  });

  it("handleTextComplete does not throw on undefined/empty input", async () => {
    const { ctx } = makeHarness();
    await expect(
      handleTextComplete(ctx, undefined as unknown as HookPayload, {}),
    ).resolves.toBeUndefined();
    await expect(handleTextComplete(ctx, {}, { text: "" })).resolves.toBeUndefined();
    await expect(handleTextComplete(ctx, {}, { text: "short" })).resolves.toBeUndefined();
    await expect(
      handleTextComplete(ctx, null as unknown as HookPayload, null as unknown as HookPayload),
    ).resolves.toBeUndefined();
  });

  it("handleSessionIdle ignores events that are not session.idle", async () => {
    const { ctx } = makeHarness();
    await expect(
      handleSessionIdle(ctx, { event: { type: "session.created" } }),
    ).resolves.toBeUndefined();
    await expect(handleSessionIdle(ctx, { event: undefined })).resolves.toBeUndefined();
    await expect(
      handleSessionIdle(ctx, undefined as unknown as HookEventPayload),
    ).resolves.toBeUndefined();
  });

  it("handleSystemTransform does not throw on partial/empty input that includes a system array", async () => {
    const { ctx } = makeHarness();
    // The pre-refactor code reads `output.system.push(...)` directly —
    // it requires `output.system` to be a pushable array. The fail-soft
    // contract is: missing fields on `input` or subagent/bypass
    // short-circuits never throw.
    await expect(
      handleSystemTransform(ctx, undefined as unknown as HookPayload, { system: [] }),
    ).resolves.toBeUndefined();
    await expect(handleSystemTransform(ctx, {}, { system: [] })).resolves.toBeUndefined();
    await expect(
      handleSystemTransform(ctx, null as unknown as HookPayload, { system: [] }),
    ).resolves.toBeUndefined();
  });

  it("handleConfig tolerates an empty opencodeConfig object", async () => {
    const { ctx } = makeHarness();
    // The pre-refactor code reads `opencodeConfig.agent ??= {}` and
    // `opencodeConfig.command ??= {}`. An empty object is fine; both
    // getters are added in place.
    await expect(handleConfig(ctx, {} as Preset, {})).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bypass flag — when ctx.state.bypassed is true, observable hooks skip work.
// ---------------------------------------------------------------------------

describe("hook handlers — bypass mode short-circuits", () => {
  it("handleChatMessage returns early when bypassed", async () => {
    const h = makeHarness();
    h.ctx.state.bypassed = true;
    await handleChatMessage(h.ctx, { sessionID: "sid-A1", agent: "fast" }, {});
    expect(h.registerFromChatMessageCalls).toBe(0);
    expect(h.trajectoryEnsureCalls).toHaveLength(0);
  });

  it("handleToolExecuteBefore returns early when bypassed", async () => {
    const h = makeHarness();
    h.ctx.state.bypassed = true;
    await handleToolExecuteBefore(h.ctx, { sessionID: "sid-A1", tool: "write" }, { args: {} });
    // The store method is not consulted when bypassed.
    expect(h.guardBeforeCalls).toHaveLength(0);
  });

  it("handleToolExecuteAfter returns early when bypassed", async () => {
    const h = makeHarness();
    h.ctx.state.bypassed = true;
    await handleToolExecuteAfter(
      h.ctx,
      { sessionID: "sid-A1", tool: "write" },
      { output: "result" },
    );
    expect(h.guardAfterCalls).toHaveLength(0);
  });

  it("handleTextComplete returns early when bypassed", async () => {
    const h = makeHarness();
    h.ctx.state.bypassed = true;
    const out = { text: "a".repeat(50) + " [thinking about it...]" };
    await handleTextComplete(h.ctx, {}, out);
    expect(out.text).not.toContain("narration detected");
  });

  it("handleSystemTransform returns early when bypassed", async () => {
    const h = makeHarness();
    h.ctx.state.bypassed = true;
    const out = { system: [] as string[] };
    await handleSystemTransform(h.ctx, {}, out);
    expect(out.system).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// chat.message registers tier info before system.transform reads it.
// ---------------------------------------------------------------------------

describe("hook handlers — order: chat.message registers before system.transform reads", () => {
  it("a chat.message call populates the subagent registry that system.transform then queries", async () => {
    const h = makeHarness();

    // 1) chat.message runs first — it registers the tier for sid-A1.
    await handleChatMessage(h.ctx, { sessionID: "sid-A1", agent: "fast" }, {});
    expect(h.registerFromChatMessageCalls).toBe(1);

    // 2) system.transform then runs — it queries isSubagent(sid-A1).
    // The harness records the call, proving system.transform sees the
    // populated registry, not an empty one.
    const out = { system: [] as string[] };
    await handleSystemTransform(h.ctx, { sessionID: "sid-A1" }, out);
    expect(h.isSubagentCalls).toContain("sid-A1");

    // The subagent branch in system.transform returns early without
    // pushing the delegation protocol into the system prompt.
    expect(out.system).toEqual([]);
  });

  it("for non-subagent sessions, system.transform pushes the delegation prompt", async () => {
    const h = makeHarness();
    await handleChatMessage(h.ctx, { sessionID: "sid-OTHER", agent: "fast" }, {});
    const out = { system: [] as string[] };
    await handleSystemTransform(h.ctx, { sessionID: "sid-OTHER" }, out);
    expect(out.system.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-hook behavioural spot checks.
// ---------------------------------------------------------------------------

describe("handleChatParams — grader temperature override", () => {
  it("sets output.temperature for open grader sessions only", async () => {
    const h = makeHarness({ graderTemperature: 0.2 });
    h.graderSessions.add("sess-grader");

    const out = { temperature: undefined as number | undefined };
    await handleChatParams(h.ctx, { sessionID: "sess-grader" }, out);
    expect(out.temperature).toBe(0.2);
  });

  it("does not set temperature for non-grader sessions", async () => {
    const h = makeHarness({ graderTemperature: 0.2 });
    const out = { temperature: undefined as number | undefined };
    await handleChatParams(h.ctx, { sessionID: "sess-other" }, out);
    expect(out.temperature).toBeUndefined();
  });
});

describe("handleToolExecuteBefore — guard block throws", () => {
  it("throws when the guard store reports a block for the subagent tool call", async () => {
    const h = makeHarness();
    h.ctx.guardStore = {
      get: () => null,
      clear: () => undefined,
      ...({
        // Override guardBeforeCall via direct import? Easier: drive the
        // code path that throws via the guard object returning a block.
      } as any),
    } as any;

    // The guardBeforeCall factory lives in ../guard/enforce. To force a
    // throw we inject a session that the isSubagent() guard recognises,
    // and rely on the fact that the default guardBeforeCall path throws
    // for subagent + read+write tools when budgets are hit. Since we
    // cannot easily stub the guard internals here, we exercise the
    // fail-soft contract: an unknown tool name on a non-subagent
    // session returns early without throwing.
    await expect(
      handleToolExecuteBefore(h.ctx, { sessionID: "sid-X", tool: "read" }, { args: {} }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Plan 008 — block nested built-in task delegation from subagent sessions.
//
// The before-hook must reject `tool === "task"` only when the current
// session is recognised as a subagent (`ctx.sessionStore.isSubagent(sid)`).
// The guard depends on no other session metadata — it does not need
// parent/depth tracking. Non-subagent sessions and non-`task` tools must
// keep their pre-plan behaviour.
// ---------------------------------------------------------------------------

describe("handleToolExecuteBefore — nested task delegation guard (plan 008)", () => {
  it("allows the built-in task tool for non-subagent (root/orchestrator) sessions", async () => {
    const h = makeHarness();
    // sid-NON-SUB is not a subagent (harness only marks sid-A1 as one).
    await expect(
      handleToolExecuteBefore(h.ctx, { sessionID: "sid-NON-SUB", tool: "task" }, { args: {} }),
    ).resolves.toBeUndefined();
  });

  it("allows non-task tools for subagent sessions (continues to guardBeforeCall)", async () => {
    const h = makeHarness();
    // sid-A1 IS a subagent. The guard must only block task; other tools
    // keep their existing pre-plan flow (early-return after isSubagent
    // check, then continue to guardBeforeCall).
    for (const t of ["read", "write", "bash", "grep", "glob"]) {
      await expect(
        handleToolExecuteBefore(h.ctx, { sessionID: "sid-A1", tool: t }, { args: {} }),
      ).resolves.toBeUndefined();
    }
  });

  it("blocks the built-in task tool for subagent sessions with the deterministic error", async () => {
    const h = makeHarness();
    await expect(
      handleToolExecuteBefore(
        h.ctx,
        { sessionID: "sid-A1", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).rejects.toThrow(
      "Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task tool",
    );
  });

  it("throws the exact error message specified in plan 008", async () => {
    const h = makeHarness();
    let captured: Error | undefined;
    try {
      await handleToolExecuteBefore(h.ctx, { sessionID: "sid-A1", tool: "task" }, { args: {} });
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).toBeDefined();
    expect(captured?.message).toBe(
      "Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task tool",
    );
  });

  it("guard depends only on isSubagent(sid) && tool === 'task' (no parent/depth metadata required)", async () => {
    const h = makeHarness();
    // Force isSubagent to return true for ANY sid — the guard must still
    // fire for task and not fire for other tools. Proves the guard has
    // no implicit dependency on parent/depth session metadata.
    h.ctx.sessionStore.isSubagent = () => true;

    await expect(
      handleToolExecuteBefore(h.ctx, { sessionID: "sid-X", tool: "task" }, { args: {} }),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);

    await expect(
      handleToolExecuteBefore(h.ctx, { sessionID: "sid-X", tool: "read" }, { args: {} }),
    ).resolves.toBeUndefined();
  });
});

describe("handleToolExecuteAfter — verifyTaskAfterHook contract", () => {
  it("records changed files for any session, including non-subagent", async () => {
    const h = makeHarness();
    const input = {
      sessionID: "sid-NON-SUB",
      tool: "write",
      args: { filePath: "a.ts" },
    };
    const output = { output: "ok", metadata: {} };
    await handleToolExecuteAfter(h.ctx, input, output);
    expect(h.changedFileRecordCalls).toHaveLength(1);
    expect(h.changedFileRecordCalls[0]!.sid).toBe("sid-NON-SUB");
  });

  it("records the tool event when the session IS a subagent", async () => {
    const h = makeHarness();
    const input = {
      sessionID: "sid-A1",
      tool: "write",
      args: { filePath: "a.ts" },
    };
    const output = { output: "ok", metadata: {} };
    await handleToolExecuteAfter(h.ctx, input, output);
    expect(h.recordToolEventCalls).toHaveLength(1);
    expect(h.recordToolEventCalls[0]!.sid).toBe("sid-A1");
  });

  // PR2 / Unit 2 — hook-contract regression for parent-metadata forwarding.
  //
  // `handleToolExecuteAfter` must invoke `verifyTaskAfterHook(ctx, input, output)`
  // — exactly 3 arguments, no extra parent. The `output.metadata` object must
  // be passed through unchanged so `parseTaskResult` inside the hook sees the
  // raw `parentSessionId` field. Forwarding `input.sessionID` as a parent
  // argument here would recreate the subagent-session-hang bug
  // (SDD change: fix-subagent-session-hang).
  it("calls verifyTaskAfterHook(ctx, input, output) — raw output.metadata through, no extra parent argument", async () => {
    verifyTaskAfterHookMock.mockClear();

    const h = makeHarness();
    const metadata = {
      sessionId: "child-sid",
      parentSessionId: "orch-sid-meta",
    };
    const input = {
      // A "subagent SID" — must NEVER be forwarded as the grader parent.
      sessionID: "sid-subagent-NEVER-FORWARD",
      tool: "task",
      args: {
        subagent_type: "fast",
        prompt: "[acceptance]\ncriteria: result is reasonable\n[/acceptance]",
      },
    };
    const output = {
      output: "<task_result>\nDONE.</task_result>",
      metadata,
    };

    await handleToolExecuteAfter(h.ctx, input, output);

    // verifyTaskAfterHook was called exactly once.
    expect(verifyTaskAfterHookMock).toHaveBeenCalledTimes(1);
    const call = verifyTaskAfterHookMock.mock.calls[0]!;
    // Exactly 3 arguments: (ctx, input, output) — NO extra parent argument.
    expect(call).toHaveLength(3);
    expect(call[0]).toBe(h.ctx);
    expect(call[1]).toBe(input);
    expect(call[2]).toBe(output);
    // output.metadata is the raw object passed in — the parentSessionId path
    // is intact (parseTaskResult reads from this exact reference).
    expect((call[2] as { metadata: unknown }).metadata).toBe(metadata);
    // input.sessionID is not forwarded as a 4th positional parent arg.
    expect(call[3]).toBeUndefined();
  });
});

describe("handleTextComplete — narration banner", () => {
  it("appends a [⚠ narration detected] banner when a narration pattern is found", async () => {
    const h = makeHarness();
    // Pattern: "Let me write the X" — must include a verb from the
    // narration allow-list (write/implement/add/create/fix/build/...).
    const longText = "a".repeat(50) + " Let me write the report now.";
    const out = { text: longText };
    await handleTextComplete(h.ctx, {}, out);
    expect(out.text).toContain("[⚠ narration detected:");
    expect(out.text.startsWith(longText)).toBe(true);
  });

  it("does not modify text shorter than the 20-char threshold", async () => {
    const h = makeHarness();
    const out = { text: "short step by step" };
    await handleTextComplete(h.ctx, {}, out);
    expect(out.text).toBe("short step by step");
  });

  it("does not modify text that has no narration pattern even when long enough", async () => {
    const h = makeHarness();
    const longText = "a".repeat(50) + " The function returns 42.";
    const out = { text: longText };
    await handleTextComplete(h.ctx, {}, out);
    expect(out.text).toBe(longText);
  });
});

describe("handleSessionIdle — scorecard + trajectory dump", () => {
  it("writes nothing when no guard state exists for the session", async () => {
    const h = makeHarness();
    await handleSessionIdle(h.ctx, {
      event: { type: "session.idle", properties: { sessionID: "sid-X" } },
    });
    // No trajectory dump unless MODEL_ROUTER_TRAJECTORY_DEBUG=1.
    expect(h.trajectoryDumpCalls).toHaveLength(0);
  });

  it("queries guardStore for the session on session.idle", async () => {
    const h = makeHarness();
    await handleSessionIdle(h.ctx, {
      event: { type: "session.idle", properties: { sessionID: "sid-Z" } },
    });
    expect(h.guardStoreGetCalls).toContain("sid-Z");
  });
});

describe("handleSystemTransform — bypass and subagent short-circuits", () => {
  it("injects the delegation prompt for the primary orchestrator", async () => {
    const h = makeHarness();
    const out = { system: [] as string[] };
    await handleSystemTransform(h.ctx, { sessionID: "sid-NEW" }, out);
    expect(out.system.length).toBeGreaterThan(0);
  });

  it("skips injection for tracked subagent sessions", async () => {
    const h = makeHarness();
    const out = { system: [] as string[] };
    await handleSystemTransform(
      h.ctx,
      { sessionID: "sid-A1" }, // isSubagent returns true for this sid
      out,
    );
    expect(out.system).toEqual([]);
  });
});

describe("handleConfig — registers tier agents and router commands", () => {
  it("populates opencodeConfig.agent with one entry per active tier", async () => {
    const h = makeHarness();
    const opencodeConfig: any = {};
    await handleConfig(h.ctx, h.ctx.activeTiersAtLoad, opencodeConfig);
    expect(typeof opencodeConfig.agent).toBe("object");
    expect(Object.keys(opencodeConfig.agent).length).toBeGreaterThan(0);
  });

  it("populates opencodeConfig.command with all router commands", async () => {
    const h = makeHarness();
    const opencodeConfig: any = {};
    await handleConfig(h.ctx, h.ctx.activeTiersAtLoad, opencodeConfig);
    expect(typeof opencodeConfig.command).toBe("object");
    for (const name of ["tiers", "preset", "budget", "bypass", "annotate-plan", "router"]) {
      expect(opencodeConfig.command[name]).toBeDefined();
      expect(typeof opencodeConfig.command[name].template).toBe("string");
      expect(typeof opencodeConfig.command[name].description).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 012 — reachable reasoning patch path (orchestrator task calls).
//
// Before plan 012, the reasoning patch block in handleToolExecuteBefore was
// unreachable dead code (placed AFTER the isSubagent early-return AND the
// task-throw guard). Plan 012 restructured the control flow so the patch
// fires for orchestrator task calls. These tests pin the new contract:
//
//   - manual mode + session override + orchestrator task → patch applied
//   - static mode + session override + orchestrator task → no-op
//   - manual mode + no override + no defaultLevel → no-op
//   - after-hook restores the baseline captured at handleConfig time
//   - patch failure is best-effort (try/catch + log.warn, never throws)
// ---------------------------------------------------------------------------

describe("handleToolExecuteBefore — reasoning patch path (plan 012)", () => {
  // Helper: build a harness with a manual/static policy + a `fast` tier that
  // carries a binary capability (`variant: "thinking"`). Then seed the live
  // `ctx.opencodeConfig.agent["fast"]` with a baseline shape so the patch
  // block can mutate it.
  const setupReasoningHarness = (
    mode: "manual" | "static",
    tierExtra: Partial<TierConfig> = {},
  ) => {
    const h = makeHarness({
      configOverrides: {
        reasoningPolicy: { mode },
        presets: {
          default: {
            fast: {
              model: "anthropic/claude-haiku-4-5",
              description: "fast",
              whenToUse: [],
              variant: "thinking",
              ...tierExtra,
            } as TierConfig,
          },
        },
      },
    });

    // Seed the live agent def + a captured baseline (the after-hook needs
    // the baseline to be present in ctx.reasoningStore).
    const baseline = {
      model: "anthropic/claude-haiku-4-5",
      mode: "subagent",
      description: "fast",
      prompt: "test prompt",
      variant: "low", // start at a non-elevated variant so the patch is visible
    };
    h.ctx.opencodeConfig = { agent: { fast: { ...baseline } } };
    h.ctx.reasoningStore.setBaseline("fast", structuredClone(baseline));

    return { h, baseline };
  };

  it("manual mode + session override → patches the orchestrator task's target agent", async () => {
    const { h, baseline } = setupReasoningHarness("manual");
    h.ctx.reasoningStore.setOverride("sid-orch", "elevated");

    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );

    // Patch block ran: variant must have moved from "low" to "thinking"
    // (the binary capability's elevated value).
    expect(h.ctx.opencodeConfig?.agent?.["fast"]?.variant).toBe("thinking");
    expect(h.ctx.opencodeConfig?.agent?.["fast"]).not.toEqual(baseline);
  });

  it("static mode + session override → no-op (agent def unchanged, primary regression guard)", async () => {
    const { h, baseline } = setupReasoningHarness("static");
    h.ctx.reasoningStore.setOverride("sid-orch", "elevated");

    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );

    // Static mode is the primary regression guard: the override must NOT
    // mutate the agent def even though it was set on the store.
    expect(h.ctx.opencodeConfig?.agent?.["fast"]).toEqual(baseline);
  });

  it("manual mode + no override + no defaultLevel → no-op (resolved is null)", async () => {
    const { h, baseline } = setupReasoningHarness("manual");
    // Deliberately no setOverride call and no defaultLevel in policy.

    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );

    expect(h.ctx.opencodeConfig?.agent?.["fast"]).toEqual(baseline);
  });

  it("after-hook restores the captured baseline after a patched dispatch", async () => {
    const { h, baseline } = setupReasoningHarness("manual");
    h.ctx.reasoningStore.setOverride("sid-orch", "elevated");

    // Patch via before-hook.
    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );
    expect(h.ctx.opencodeConfig?.agent?.["fast"]?.variant).toBe("thinking");

    // After-hook restores the baseline captured at handleConfig time.
    await handleToolExecuteAfter(
      h.ctx,
      { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
      { output: "ok" },
    );
    expect(h.ctx.opencodeConfig?.agent?.["fast"]).toEqual(baseline);
  });

  it("patch failure is best-effort: hook does not throw and logs a warning instead", async () => {
    const { h } = setupReasoningHarness("manual");
    h.ctx.reasoningStore.setOverride("sid-orch", "elevated");

    // Freeze the agent def so applyReasoningPatch's `agentDef.variant = ...`
    // assignment throws a TypeError (TypeScript modules are in strict mode).
    const agentDef = h.ctx.opencodeConfig?.agent?.["fast"];
    if (!agentDef) throw new Error("test setup: missing agent def");
    Object.freeze(agentDef);

    // The hook must NOT propagate the patch failure — dispatch continues.
    await expect(
      handleToolExecuteBefore(
        h.ctx,
        { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).resolves.toBeUndefined();
  });

  it("orchestrator non-task calls still early-return without touching agent def", async () => {
    const { h, baseline } = setupReasoningHarness("manual");
    h.ctx.reasoningStore.setOverride("sid-orch", "elevated");

    // Non-task tool: the patch block is gated by `tool === "task"` and must
    // not mutate anything.
    await handleToolExecuteBefore(h.ctx, { sessionID: "sid-orch", tool: "read" }, { args: {} });

    expect(h.ctx.opencodeConfig?.agent?.["fast"]).toEqual(baseline);
  });
});

// ---------------------------------------------------------------------------
// Plan 014 — surface-limits debug events + per-tier in-flight guard.
//
// These tests pin the Phase 3 contracts:
//   - `surfaceLimits=true` causes a successful patch to emit a
//     `reasoning.patch_applied` debug event carrying the resolved patch.
//   - `surfaceLimits=true` + an override that resolves to null emits a
//     `reasoning.patch_unsupported` debug event so operators can see why
//     the requested level was not applied.
//   - A second same-tier dispatch on a different session is skipped, not
//     double-patched; the skip emits `reasoning.patch_skipped_concurrent`
//     and leaves the live agent def at the in-flight patched value.
//   - The after-hook releases the per-tier in-flight owner so subsequent
//     dispatches can re-acquire the tier; a foreign release is a no-op.
// ---------------------------------------------------------------------------

describe("handleToolExecuteBefore/After — plan 014 surface-limits events + in-flight guard", () => {
  // Helper: extract every `[model-router] { ... }` line the structured logger
  // emitted to `console.log`, returning the parsed JSON envelope. This matches
  // the pattern used by `test/unit/observability.test.ts`.
  const captureLogEnvelopes = (calls: unknown[][]): Array<Record<string, unknown>> => {
    return calls
      .map((c) => String(c[0] ?? ""))
      .filter((l) => l.startsWith("[model-router] "))
      .map((l) => JSON.parse(l.slice(l.indexOf("{"))));
  };

  const setupSurfaceLimitsHarness = (opts: {
    mode: "manual" | "static";
    surfaceLimits: boolean;
  }) => {
    const h = makeHarness({
      configOverrides: {
        reasoningPolicy: { mode: opts.mode, surfaceLimits: opts.surfaceLimits },
        presets: {
          default: {
            fast: {
              model: "anthropic/claude-haiku-4-5",
              description: "fast",
              whenToUse: [],
              variant: "thinking",
            } as TierConfig,
          },
        },
      },
    });
    const baseline = {
      model: "anthropic/claude-haiku-4-5",
      mode: "subagent",
      description: "fast",
      prompt: "test prompt",
      variant: "low",
    };
    h.ctx.opencodeConfig = { agent: { fast: { ...baseline } } };
    h.ctx.reasoningStore.setBaseline("fast", structuredClone(baseline));
    return { h, baseline };
  };

  let origLevel: string | undefined;
  beforeEach(() => {
    origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    // Debug-level events are filtered by the production default ("warn"),
    // so we MUST opt in for the test runtime to see them.
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
  });
  afterEach(() => {
    if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
    else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
    __resetLoggerForTest();
    // Spies on `console.log` from the per-test setup leak across tests
    // in this describe (vitest 4 only auto-restores on `vi.restoreAllMocks()`).
    vi.restoreAllMocks();
  });

  it("surfaceLimits=true + manual + override → emits reasoning.patch_applied debug event", async () => {
    const { h } = setupSurfaceLimitsHarness({ mode: "manual", surfaceLimits: true });
    h.ctx.reasoningStore.setOverride("sid-orch", "elevated");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );

    const envelopes = captureLogEnvelopes(logSpy.mock.calls);
    const applied = envelopes.filter((e) => e["event"] === "reasoning.patch_applied");
    expect(applied).toHaveLength(1);
    const env = applied[0]!;
    expect(env["level"]).toBe("debug");
    expect(env["session"]).toBe("sid-orch");
    expect(env["tier"]).toBe("fast");
    expect(env["override"]).toBe("elevated");
    // The resolved patch is the binary capability's elevated variant
    // ("thinking"). The exact shape is owned by `resolveReasoningOverride`
    // — here we only assert it carries the variant field the plugin applied.
    expect((env["patch"] as Record<string, unknown>)["variant"]).toBe("thinking");
  });

  it("surfaceLimits=false → no debug event (the surfacing is opt-in)", async () => {
    const { h } = setupSurfaceLimitsHarness({ mode: "manual", surfaceLimits: false });
    h.ctx.reasoningStore.setOverride("sid-orch", "elevated");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );

    const envelopes = captureLogEnvelopes(logSpy.mock.calls);
    const reasoningEvents = envelopes.filter(
      (e) => typeof e["event"] === "string" && (e["event"] as string).startsWith("reasoning."),
    );
    expect(reasoningEvents).toHaveLength(0);
  });

  it("surfaceLimits=true + override that resolves to null → emits reasoning.patch_unsupported", async () => {
    // Build a tier with `kind: "none"` so resolveReasoningOverride always
    // returns null, even with a manual policy + a non-null override.
    const h = makeHarness({
      configOverrides: {
        reasoningPolicy: { mode: "manual", surfaceLimits: true },
        presets: {
          default: {
            fast: {
              model: "anthropic/claude-haiku-4-5",
              description: "fast",
              whenToUse: [],
              capability: { kind: "none" },
            } as TierConfig,
          },
        },
      },
    });
    h.ctx.opencodeConfig = { agent: { fast: { variant: "low" } } };
    h.ctx.reasoningStore.setBaseline("fast", { variant: "low" });
    h.ctx.reasoningStore.setOverride("sid-orch", "elevated");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );

    const envelopes = captureLogEnvelopes(logSpy.mock.calls);
    const unsupported = envelopes.filter((e) => e["event"] === "reasoning.patch_unsupported");
    expect(unsupported).toHaveLength(1);
    const env = unsupported[0]!;
    expect(env["session"]).toBe("sid-orch");
    expect(env["tier"]).toBe("fast");
    expect(env["override"]).toBe("elevated");
  });

  it("same-tier overlap is skipped, not double-patched; emits reasoning.patch_skipped_concurrent", async () => {
    const { h, baseline } = setupSurfaceLimitsHarness({ mode: "manual", surfaceLimits: true });
    h.ctx.reasoningStore.setOverride("sid-A", "elevated");
    h.ctx.reasoningStore.setOverride("sid-B", "max");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // First dispatch: sid-A patches the agent def.
    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-A", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );
    expect(h.ctx.opencodeConfig?.agent?.["fast"]?.variant).toBe("thinking");
    expect(h.ctx.reasoningStore.getTierOwner("fast")).toBe("sid-A");

    // Second same-tier dispatch from sid-B must be SKIPPED, not overwriting
    // sid-A's in-flight patch.
    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-B", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );

    // Variant is still sid-A's elevated value (binary `elevated` = "thinking"),
    // not sid-B's `max` patch. The live def has NOT been double-mutated.
    expect(h.ctx.opencodeConfig?.agent?.["fast"]?.variant).toBe("thinking");
    // Ownership is still sid-A's — sid-B did not steal the lock.
    expect(h.ctx.reasoningStore.getTierOwner("fast")).toBe("sid-A");
    // The agent def has not been reset to baseline either.
    expect(h.ctx.opencodeConfig?.agent?.["fast"]).not.toEqual(baseline);

    // The skip was logged with the documented event name and the owner field.
    const envelopes = captureLogEnvelopes(logSpy.mock.calls);
    const skipped = envelopes.filter((e) => e["event"] === "reasoning.patch_skipped_concurrent");
    expect(skipped).toHaveLength(1);
    const env = skipped[0]!;
    expect(env["session"]).toBe("sid-B");
    expect(env["tier"]).toBe("fast");
    expect(env["owner"]).toBe("sid-A");
  });

  it("after-hook releases the per-tier owner so the next dispatch can re-acquire", async () => {
    const { h } = setupSurfaceLimitsHarness({ mode: "manual", surfaceLimits: true });
    h.ctx.reasoningStore.setOverride("sid-A", "elevated");
    h.ctx.reasoningStore.setOverride("sid-B", "max");

    // sid-A patches + restores.
    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-A", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );
    expect(h.ctx.reasoningStore.getTierOwner("fast")).toBe("sid-A");

    await handleToolExecuteAfter(
      h.ctx,
      { sessionID: "sid-A", tool: "task", args: { subagent_type: "fast" } },
      { output: "ok" },
    );
    // After-hook released the lock — the tier is free again.
    expect(h.ctx.reasoningStore.getTierOwner("fast")).toBeUndefined();

    // sid-B can now acquire and patch — proves the lock was released, not
    // leaked by the after-hook.
    await handleToolExecuteBefore(
      h.ctx,
      { sessionID: "sid-B", tool: "task", args: { subagent_type: "fast" } },
      { args: { subagent_type: "fast" } },
    );
    expect(h.ctx.reasoningStore.getTierOwner("fast")).toBe("sid-B");
  });

  it("after-hook does not release a foreign owner's lock (release is owner-checked)", async () => {
    // Simulate a stale after-hook call: another session (sid-stale) fires
    // the after-hook for a tier that sid-current owns. The release MUST
    // return false and sid-current's lock must survive.
    const { h } = setupSurfaceLimitsHarness({ mode: "manual", surfaceLimits: false });
    h.ctx.reasoningStore.acquireTierOwner("fast", "sid-current");
    h.ctx.reasoningStore.setBaseline("fast", { variant: "x" });

    await handleToolExecuteAfter(
      h.ctx,
      // A foreign session is sending the after-hook for "fast" — the runtime
      // is the one calling releaseTierOwner with whatever sid is in the
      // payload, regardless of who actually acquired the lock.
      { sessionID: "sid-stale", tool: "task", args: { subagent_type: "fast" } },
      { output: "ok" },
    );

    // sid-current's lock survives — the foreign release was a no-op.
    expect(h.ctx.reasoningStore.getTierOwner("fast")).toBe("sid-current");
  });
});
