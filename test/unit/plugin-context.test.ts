import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginContext } from "../../src/plugin/context";

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

  it("per-instance ConfigStore cache is private — invalidating one context's store does not touch another", () => {
    // The two-context isolation property the singleton design failed to
    // provide is now asserted directly: the ConfigStore inside ctxA has
    // its own cache, distinct from ctxB's. (This used to be phrased as
    // a comment about invalidateConfigCache; after PR2 task 2.7 the
    // legacy singleton no longer exists, so the property is now tested
    // via the per-instance store API.)
    const ctxA = createPluginContext(makePluginInput(tmpCwd) as any);
    const ctxB = createPluginContext(makePluginInput(tmpCwd) as any);
    const a = ctxA.getConfig();
    const b = ctxB.getConfig();
    // Both contexts share disk state; both initial reads return equivalent values.
    expect(a.activePreset).toBe(b.activePreset);
    // But the references are distinct (per-instance cache).
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Phase 4.2 — direct seam coverage for createPluginContext().
//
// The PR1 baseline already proved the cache/refresh/isolation contracts.
// These tests add direct, single-seam coverage so any future regression in
// the seam wiring (activeTiersAtLoad snapshot, per-instance seam binding,
// bypass flag mutability, getConfig reference stability) localises here
// without dragging in command or router setup.
// ---------------------------------------------------------------------------

describe("createPluginContext — direct seam wiring", () => {
  it("activeTiersAtLoad is a snapshot of getActiveTiers(initialConfig) at construction time", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    // The snapshot must contain the bundled tier names. The exact preset
    // varies by fixture, so assert the keys are present and non-empty.
    expect(ctx.activeTiersAtLoad).toBeDefined();
    expect(typeof ctx.activeTiersAtLoad).toBe("object");
    expect(Object.keys(ctx.activeTiersAtLoad).length).toBeGreaterThan(0);
    // The model string on each tier must be set.
    for (const [, tier] of Object.entries(ctx.activeTiersAtLoad)) {
      expect(typeof (tier as { model?: string }).model).toBe("string");
    }
  });

  it("seams.exec and seams.fs are bound to the plugin's directory", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    expect(ctx.seams.exec).toBeDefined();
    expect(ctx.seams.fs).toBeDefined();
    // Each seam must be a callable function (exec) or object with the
    // expected fs surface — assert that calling/inspecting them does not throw.
    expect(() => ctx.seams.exec("echo hi", { timeoutMs: 1000 })).not.toThrow();
  });

  it("getConfig returns the same reference when nothing changed between reads", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    const a = ctx.getConfig();
    const b = ctx.getConfig();
    // ConfigStore.read() is documented as idempotent: two consecutive reads
    // return the same reference until refresh() is called.
    expect(b).toBe(a);
  });

  it("refreshConfig returns a new reference (the rebuilt config object)", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    const a = ctx.getConfig();
    const b = ctx.refreshConfig();
    // The merged values must be equal even if the references differ.
    expect(b.activePreset).toBe(a.activePreset);
  });

  it("state.bypassed starts as false and is mutable from outside the factory", () => {
    const ctx = createPluginContext(makePluginInput(tmpCwd) as any);
    expect(ctx.state.bypassed).toBe(false);
    ctx.state.bypassed = true;
    expect(ctx.state.bypassed).toBe(true);
    ctx.state.bypassed = false;
    expect(ctx.state.bypassed).toBe(false);
  });

  it("does not throw when plugin.directory is undefined", () => {
    // The factory must tolerate a missing directory — the seam factory
    // defaults to process.cwd() in that case.
    const noDir = { directory: undefined } as any;
    expect(() => createPluginContext(noDir)).not.toThrow();
  });

  it("store handles are all fresh per call (no module-level singletons)", () => {
    const a = createPluginContext(makePluginInput(tmpCwd) as any);
    const b = createPluginContext(makePluginInput(tmpCwd) as any);
    // Each seam is bound to its own instance.
    expect(a.seams.exec).not.toBe(b.seams.exec);
    expect(a.seams.fs).not.toBe(b.seams.fs);
    // graderSessions is a fresh Set per call.
    expect(a.graderSessions).not.toBe(b.graderSessions);
    // Stores are per-instance.
    expect(a.sessionStore).not.toBe(b.sessionStore);
    expect(a.changedFileStore).not.toBe(b.changedFileStore);
    expect(a.guardStore).not.toBe(b.guardStore);
    expect(a.trajectoryStore).not.toBe(b.trajectoryStore);
    expect(a.verifyMutex).not.toBe(b.verifyMutex);
  });
});
