import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin/context";
import { createPluginContext } from "../../src/plugin/context";
import type { RouterConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// PluginContext.getFreshConfig()
//
// `getFreshConfig()` replaces the manual `let cfg = ctx.getConfig(); try {
// cfg = ctx.refreshConfig(); } catch {}` pattern that used to live in 7+
// handlers across `src/router/commands.ts` and `src/plugin/hooks.ts`. The
// contract:
// - On a successful refresh: returns the refreshed RouterConfig.
// - On a refresh failure:    catches the error and returns the cached value
//                            from `getConfig()` so the caller keeps the last
//                            known good config and never crashes a real
//                            session.
//
// PR3b: `getFreshConfig`, `getConfig`, and `refreshConfig` are async; the
// test bodies await every call. Sync-mock setups (`mockReturnValue`)
// remain valid because `await syncValue` unwraps to the value.
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origXDG_CONFIG_HOME: string | undefined;

beforeEach(async () => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origXDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
  tmpHome = join(
    tmpdir(),
    `oc-freshcfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  // Tests must exercise the legacy `$HOME/.config/...` fallback so they
  // do not leak across users who have `XDG_CONFIG_HOME` set globally.
  delete process.env["XDG_CONFIG_HOME"];
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

afterEach(async () => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  if (origXDG_CONFIG_HOME === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = origXDG_CONFIG_HOME;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

const makeBaseConfig = (extra: Partial<RouterConfig> = {}): RouterConfig => {
  return {
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
    ...extra,
  } as RouterConfig;
};

describe("PluginContext.getFreshConfig", () => {
  it("exposes getFreshConfig on the context interface", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    expect(typeof ctx.getFreshConfig).toBe("function");
  });

  it("returns a RouterConfig on the happy path", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    const cfg = await ctx.getFreshConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg.activePreset).toBe("string");
    expect(cfg.presets).toBeTypeOf("object");
  });

  it("falls back to the cached config when refreshConfig() throws", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    const cached = await ctx.getConfig();

    const refreshSpy = vi
      .spyOn(ctx, "refreshConfig")
      .mockRejectedValue(new Error("disk read failed"));

    let result: RouterConfig | null = null;
    // Wrap in try/catch so a (correct) rejection from getFreshConfig is
    // also captured — the contract is "the call resolves with the cached
    // value", not "the call never throws".
    try {
      result = await ctx.getFreshConfig();
    } catch {
      // expected path: refreshConfig rejects, we fall back via getConfig.
    }

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // Fallback path: returns the cached value, not the thrown error.
    expect(result).toBe(cached);
  });

  it("returns the refreshed value when refreshConfig() succeeds", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    const refreshed = makeBaseConfig({ activePreset: "openai" });
    const refreshSpy = vi.spyOn(ctx, "refreshConfig").mockResolvedValue(refreshed);

    const result = await ctx.getFreshConfig();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(result.activePreset).toBe("openai");
  });

  it("does not invoke getConfig() when refreshConfig() succeeds", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    const refreshed = makeBaseConfig({ activePreset: "google" });
    const refreshSpy = vi.spyOn(ctx, "refreshConfig").mockResolvedValue(refreshed);
    const getConfigSpy = vi.spyOn(ctx, "getConfig");

    const result = await ctx.getFreshConfig();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(result.activePreset).toBe("google");
  });

  it("invokes getConfig() exactly once when refreshConfig() throws", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    vi.spyOn(ctx, "refreshConfig").mockRejectedValue(new Error("disk boom"));
    const getConfigSpy = vi.spyOn(ctx, "getConfig");

    await ctx.getFreshConfig();
    expect(getConfigSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows any thrown error from refreshConfig() without propagating", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    vi.spyOn(ctx, "refreshConfig").mockRejectedValue(new TypeError("io weirdness"));
    await expect(ctx.getFreshConfig()).resolves.toBeDefined();
  });

  it("the PluginContext type signature advertises getFreshConfig", async () => {
    // Compile-time check: assigning a context with the method present to a
    // PluginContext-typed variable must succeed.
    const ctx: PluginContext = {
      plugin: { directory: tmpHome } as any,
      initialConfig: makeBaseConfig(),
      activeTiersAtLoad: {} as any,
      getConfig: () => Promise.resolve(makeBaseConfig()),
      refreshConfig: () => Promise.resolve(makeBaseConfig()),
      getFreshConfig: () => Promise.resolve(makeBaseConfig()),
      dispose: async () => {},
      state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
      sessionStore: {} as any,
      trajectoryStore: {} as any,
      guardStore: {} as any,
      changedFileStore: {} as any,
      reasoningStore: {} as any,
      graderSessions: new Set<string>(),
      verifyMutex: {} as any,
      seams: { exec: {} as any, fs: {} as any },
    };
    expect((await ctx.getFreshConfig()).activePreset).toBe("default");
  });
});
