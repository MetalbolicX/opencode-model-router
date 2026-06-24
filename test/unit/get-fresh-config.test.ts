import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginContext } from "../../src/plugin/context";
import type { PluginContext } from "../../src/plugin/context";
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
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  tmpHome = join(
    tmpdir(),
    `oc-freshcfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function makeBaseConfig(extra: Partial<RouterConfig> = {}): RouterConfig {
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
}

describe("PluginContext.getFreshConfig", () => {
  it("exposes getFreshConfig on the context interface", () => {
    const ctx = createPluginContext({ directory: tmpHome } as any);
    expect(typeof ctx.getFreshConfig).toBe("function");
  });

  it("returns a RouterConfig on the happy path", () => {
    const ctx = createPluginContext({ directory: tmpHome } as any);
    const cfg = ctx.getFreshConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg.activePreset).toBe("string");
    expect(cfg.presets).toBeTypeOf("object");
  });

  it("falls back to the cached config when refreshConfig() throws", () => {
    const ctx = createPluginContext({ directory: tmpHome } as any);
    const cached = ctx.getConfig();

    const refreshSpy = vi
      .spyOn(ctx, "refreshConfig")
      .mockImplementation(() => {
        throw new Error("disk read failed");
      });

    let result: RouterConfig | null = null;
    expect(() => {
      result = ctx.getFreshConfig();
    }).not.toThrow();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // Fallback path: returns the cached value, not the thrown error.
    expect(result).toBe(cached);
  });

  it("returns the refreshed value when refreshConfig() succeeds", () => {
    const ctx = createPluginContext({ directory: tmpHome } as any);
    const refreshed = makeBaseConfig({ activePreset: "openai" });
    const refreshSpy = vi
      .spyOn(ctx, "refreshConfig")
      .mockReturnValue(refreshed);

    const result = ctx.getFreshConfig();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(result.activePreset).toBe("openai");
  });

  it("does not invoke getConfig() when refreshConfig() succeeds", () => {
    const ctx = createPluginContext({ directory: tmpHome } as any);
    const refreshed = makeBaseConfig({ activePreset: "google" });
    const refreshSpy = vi
      .spyOn(ctx, "refreshConfig")
      .mockReturnValue(refreshed);
    const getConfigSpy = vi.spyOn(ctx, "getConfig");

    const result = ctx.getFreshConfig();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(result.activePreset).toBe("google");
  });

  it("invokes getConfig() exactly once when refreshConfig() throws", () => {
    const ctx = createPluginContext({ directory: tmpHome } as any);
    vi.spyOn(ctx, "refreshConfig").mockImplementation(() => {
      throw new Error("disk boom");
    });
    const getConfigSpy = vi.spyOn(ctx, "getConfig");

    ctx.getFreshConfig();
    expect(getConfigSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows any thrown error from refreshConfig() without propagating", () => {
    const ctx = createPluginContext({ directory: tmpHome } as any);
    vi.spyOn(ctx, "refreshConfig").mockImplementation(() => {
      throw new TypeError("io weirdness");
    });
    expect(() => ctx.getFreshConfig()).not.toThrow();
  });

  it("the PluginContext type signature advertises getFreshConfig", () => {
    // Compile-time check: assigning a context with the method present to a
    // PluginContext-typed variable must succeed.
    const ctx: PluginContext = {
      plugin: { directory: tmpHome } as any,
      initialConfig: makeBaseConfig(),
      activeTiersAtLoad: {} as any,
      getConfig: () => makeBaseConfig(),
      refreshConfig: () => makeBaseConfig(),
      getFreshConfig: () => makeBaseConfig(),
      state: { bypassed: false },
      sessionStore: {} as any,
      trajectoryStore: {} as any,
      guardStore: {} as any,
      changedFileStore: {} as any,
      graderSessions: new Set<string>(),
      verifyMutex: {} as any,
      seams: { exec: {} as any, fs: {} as any },
    };
    expect(ctx.getFreshConfig().activePreset).toBe("default");
  });
});
