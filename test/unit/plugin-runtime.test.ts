import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin/context";
import { assembleRuntimeHooks } from "../../src/plugin/runtime";
import type { Preset } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const executeDelegateMock = vi.fn();
vi.mock("../../src/plugin/delegate", async () => {
  const actual = await vi.importActual<typeof import("../../src/plugin/delegate")>(
    "../../src/plugin/delegate",
  );
  return { ...actual, executeDelegate: (...args: unknown[]) => (executeDelegateMock as any)(...args) };
});

const handleCommandBeforeMock = vi.fn();
vi.mock("../../src/router/commands", async () => {
  const actual = await vi.importActual<typeof import("../../src/router/commands")>(
    "../../src/router/commands",
  );
  return { ...actual, handleCommandBefore: (...args: unknown[]) => (handleCommandBeforeMock as any)(...args) };
});

// ---------------------------------------------------------------------------
// Env setup (every test file in this repo uses this pattern)
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
    `oc-runtime-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  executeDelegateMock.mockReset();
  handleCommandBeforeMock.mockReset();
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
// Minimal fake PluginContext (modeled after plugin-hooks.test.ts makeHarness)
// ---------------------------------------------------------------------------

const makeCtx = (): PluginContext => {
  const sessionStore = {
    registerProducerSession: () => undefined,
    unregister: () => undefined,
    isSubagent: () => false,
    isTrivial: () => false,
    getTier: () => "fast",
    registerFromChatMessage: () => undefined,
    recordToolCall: () => undefined,
  };
  const guardStore = { get: () => null, clear: () => undefined };
  const trajectoryStore = { ensure: () => undefined, recordToolEvent: () => undefined, dump: () => null };
  const changedFileStore = { record: () => undefined, get: () => [], clear: () => undefined };

  return {
    plugin: { directory: tmpCwd, client: {} as any } as any,
    initialConfig: {} as any,
    activeTiersAtLoad: {} as any,
    getConfig: async () => ({} as any),
    refreshConfig: async () => ({} as any),
    getFreshConfig: async () => ({} as any),
    dispose: vi.fn().mockResolvedValue(undefined),
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore: sessionStore as any,
    trajectoryStore: trajectoryStore as any,
    guardStore: guardStore as any,
    changedFileStore: changedFileStore as any,
    reasoningStore: {} as any,
    graderSessions: new Set<string>(),
    verifyMutex: {} as any,
    seams: { exec: {} as any, fs: {} as any },
  };
};

const makePreset = (): Preset =>
  ({
    fast: {
      model: "anthropic/claude-haiku-4-5",
      description: "fast",
      whenToUse: [],
      steps: 10,
      color: "#00ff00",
    },
    medium: {
      model: "anthropic/claude-sonnet-4",
      description: "medium",
      whenToUse: [],
      steps: 20,
      color: "#ff0000",
    },
  }) as Preset;

// ---------------------------------------------------------------------------
// Tests: hook shape
// ---------------------------------------------------------------------------

describe("assembleRuntimeHooks — hook shape", () => {
  it("returns an object with all expected hook keys", () => {
    const hooks = assembleRuntimeHooks(makeCtx(), makePreset(), false);
    expect(hooks).toHaveProperty("tool");
    expect(hooks).toHaveProperty("chat.params");
    expect(hooks).toHaveProperty("chat.message");
    expect(hooks).toHaveProperty("tool.execute.before");
    expect(hooks).toHaveProperty("tool.execute.after");
    expect(hooks).toHaveProperty("experimental.text.complete");
    expect(hooks).toHaveProperty("event");
    expect(hooks).toHaveProperty("config");
    expect(hooks).toHaveProperty("experimental.chat.system.transform");
    expect(hooks).toHaveProperty("command.execute.before");
    expect(hooks).toHaveProperty("dispose");
  });

  it("every hook value is a function (or object for tool)", () => {
    const hooks = assembleRuntimeHooks(makeCtx(), makePreset(), false);
    expect(typeof hooks["chat.params"]).toBe("function");
    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["experimental.text.complete"]).toBe("function");
    expect(typeof hooks["event"]).toBe("function");
    expect(typeof hooks["config"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
    expect(typeof hooks["command.execute.before"]).toBe("function");
    expect(typeof hooks["dispose"]).toBe("function");
    expect(typeof hooks["tool"]).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// Tests: delegate tool gating
// ---------------------------------------------------------------------------

describe("assembleRuntimeHooks — delegate tool gating", () => {
  it("omits the delegate tool when enableDelegateTool is false", () => {
    const hooks = assembleRuntimeHooks(makeCtx(), makePreset(), false);
    expect(("delegate" in (hooks["tool"] as object))).toBe(false);
  });

  it("includes the delegate tool when enableDelegateTool is true", () => {
    const hooks = assembleRuntimeHooks(makeCtx(), makePreset(), true);
    const toolObj = hooks["tool"] as Record<string, unknown>;
    expect(("delegate" in toolObj)).toBe(true);
    const delegate = toolObj["delegate"] as Record<string, unknown>;
    expect(typeof delegate.description).toBe("string");
    expect((delegate.args as Record<string, unknown>)).toHaveProperty("task");
  });

  it("delegate tool execute calls executeDelegate with ctx, args, sessionID, abort", async () => {
    executeDelegateMock.mockResolvedValue("[router] accepted");
    const hooks = assembleRuntimeHooks(makeCtx(), makePreset(), true);
    const delegate = (hooks["tool"] as Record<string, unknown>)["delegate"] as Record<string, unknown>;
    const executeFn = delegate.execute as (...args: unknown[]) => Promise<string>;
    const ctx = makeCtx();
    const args = { task: "say hello", tier: "fast" };
    const fakeAbort = { aborted: false } as any;
    const fakeContext = { sessionID: "sess_test", abort: fakeAbort };

    await executeFn(args, fakeContext);

    expect(executeDelegateMock).toHaveBeenCalledOnce();
    const [[callCtx, callArgs, callSid, callAbort]] = executeDelegateMock.mock.calls;
    expect(callSid).toBe("sess_test");
    expect(callArgs).toEqual(args);
    expect(callAbort).toBe(fakeAbort);
  });
});

// ---------------------------------------------------------------------------
// Tests: dispose
// ---------------------------------------------------------------------------

describe("assembleRuntimeHooks — dispose", () => {
  it("dispose calls ctx.dispose exactly once", async () => {
    const ctx = makeCtx();
    const hooks = assembleRuntimeHooks(ctx, makePreset(), false);
    await hooks.dispose?.();
    expect(ctx.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent — second call does not throw", async () => {
    const hooks = assembleRuntimeHooks(makeCtx(), makePreset(), false);
    await hooks.dispose?.();
    await expect(hooks.dispose?.()).resolves.not.toThrow();
  });

  it("dispose calls ctx.dispose on both calls (idempotent)", async () => {
    const ctx = makeCtx();
    const hooks = assembleRuntimeHooks(ctx, makePreset(), false);
    await hooks.dispose?.();
    await hooks.dispose?.();
    expect(ctx.dispose).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: handler wiring
// ---------------------------------------------------------------------------

describe("assembleRuntimeHooks — handler wiring", () => {
  it("command.execute.before forwards input.command and input.arguments to handleCommandBefore", async () => {
    const hooks = assembleRuntimeHooks(makeCtx(), makePreset(), false);
    const fakeOutput = { parts: [] } as any;
    handleCommandBeforeMock.mockResolvedValue(undefined);

    await (hooks["command.execute.before"] as any)(
      { command: "tiers", arguments: "--json" },
      fakeOutput,
    );

    expect(handleCommandBeforeMock).toHaveBeenCalledOnce();
    expect(handleCommandBeforeMock).toHaveBeenCalledWith(
      expect.anything(),
      { command: "tiers", arguments: "--json" },
      fakeOutput,
    );
  });

  it("chat.params forwards to handleChatParams with ctx", async () => {
    const hooks = assembleRuntimeHooks(makeCtx(), makePreset(), false);
    const fakeInput = { params: {} };
    const fakeOutput = {};

    await (hooks["chat.params"] as any)(fakeInput, fakeOutput);

    expect(handleCommandBeforeMock).not.toHaveBeenCalled();
  });
});
