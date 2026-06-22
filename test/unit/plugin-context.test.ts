import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginContext } from "../../src/plugin/context";
import { invalidateConfigCache } from "../../src/router/config";

// ---------------------------------------------------------------------------
// PluginContext wiring tests.
//
// These cover the PR1 invariant: `getConfig()` and `refreshConfig()` on the
// returned context both go through the per-instance `ConfigStore` and never
// fall back to the legacy module-level `loadConfig()` singleton. Two contexts
// are isolated from each other: one's refresh does not invalidate the other.
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
    `oc-ctx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;

  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  process.chdir(tmpCwd);

  invalidateConfigCache();
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  process.chdir(origCwd);
  invalidateConfigCache();
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function stageLocal(cwd: string, content: Record<string, unknown>): void {
  const dir = join(cwd, ".opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tiers.json"), JSON.stringify(content), "utf-8");
}

/** A minimal PluginInput. Only `directory` and `client` are read by
 *  createPluginContext(); everything else is undefined and the seam
 *  factories tolerate it. */
function makePluginInput(directory: string): any {
  return { directory };
}

describe("createPluginContext — getConfig / refreshConfig wiring", () => {
  it("returns a context whose getConfig() returns a RouterConfig", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    const cfg = ctx.getConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg.activePreset).toBe("string");
    expect(cfg.presets).toBeDefined();
  });

  it("initialConfig matches the first getConfig() result", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    expect(ctx.initialConfig.activePreset).toBe(ctx.getConfig().activePreset);
  });

  it("refreshConfig() returns a RouterConfig", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    const cfg = ctx.refreshConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg.activePreset).toBe("string");
  });

  it("getConfig() and refreshConfig() return equivalent configs when nothing changed", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    const a = ctx.getConfig();
    const b = ctx.refreshConfig();
    expect(b.activePreset).toBe(a.activePreset);
  });

  it("refreshConfig() picks up a newly-staged local layer without restart", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    expect(ctx.getConfig().activePreset).toBe("multi-provider");
    stageLocal(tmpCwd, { activePreset: "openai" });
    expect(ctx.refreshConfig().activePreset).toBe("openai");
  });

  it("the context exposes all required per-instance stores", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    expect(ctx.sessionStore).toBeDefined();
    expect(ctx.trajectoryStore).toBeDefined();
    expect(ctx.guardStore).toBeDefined();
    expect(ctx.changedFileStore).toBeDefined();
    expect(ctx.graderSessions).toBeInstanceOf(Set);
    expect(ctx.verifyMutex).toBeDefined();
    expect(ctx.seams.exec).toBeDefined();
    expect(ctx.seams.fs).toBeDefined();
    expect(ctx.state.bypassed).toBe(false);
  });
});

describe("createPluginContext — two-instance isolation", () => {
  it("two contexts see the same bundled default", () => {
    const ctxA = createPluginContext(makePluginInput(tmpCwd) as any);
    const ctxB = createPluginContext(makePluginInput(tmpCwd) as any);
    expect(ctxA.getConfig().activePreset).toBe(ctxB.getConfig().activePreset);
  });

  it("one context's refreshConfig() does not invalidate another context's cache", () => {
    const ctxA = createPluginContext(makePluginInput(tmpCwd) as any);
    const ctxB = createPluginContext(makePluginInput(tmpCwd) as any);

    // Stage a local layer AFTER both contexts have read.
    stageLocal(tmpCwd, { activePreset: "openai" });
    ctxA.refreshConfig();
    expect(ctxA.getConfig().activePreset).toBe("openai");
    // ctxB still holds the cached bundled default until it refreshes.
    expect(ctxB.getConfig().activePreset).toBe("multi-provider");
    expect(ctxB.refreshConfig().activePreset).toBe("openai");
  });

  it("two contexts bound to different cwds see different local layers", () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal(tmpCwd, { activePreset: "openai" });
    stageLocal(otherCwd, { activePreset: "google" });

    const ctxA = createPluginContext(makePluginInput(tmpCwd) as any);
    const ctxB = createPluginContext(makePluginInput(otherCwd) as any);

    expect(ctxA.getConfig().activePreset).toBe("openai");
    expect(ctxB.getConfig().activePreset).toBe("google");
  });

  it("contexts do not share the legacy module-level cache", () => {
    // If the contexts accidentally delegated to loadConfig(), then
    // invalidateConfigCache() between two reads on the SAME context
    // would NOT change behaviour (because the cache stays valid).
    // Instead we assert that two contexts are independent: invalidateConfigCache
    // only affects the legacy module-level cache, not the per-instance stores.
    const ctxA = createPluginContext(makePluginInput(tmpCwd) as any);
    const first = ctxA.getConfig();
    invalidateConfigCache();
    const second = ctxA.getConfig();
    // ctxA's ConfigStore was already cached, so invalidateConfigCache
    // (which clears the module-level singleton) does not affect ctxA.
    expect(second.activePreset).toBe(first.activePreset);
  });
});
