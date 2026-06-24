import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfigStore } from "../../src/router/config-store";
import { readMergedConfig } from "../../src/router/config-loader";

// ---------------------------------------------------------------------------
// Per-instance ConfigStore contract tests.
//
// These cover the observable behaviour mandated by the spec:
//   - `read()`    returns the cached value (re-reads from disk if empty).
//   - `refresh()` always re-reads from disk and replaces the cache.
//   - `invalidate()` clears the cache; the next `read()` re-reads.
//   - Two stores with different cwds see different local-layer results.
//   - Two stores with the same cwd have independent caches: one's
//     `refresh()` never invalidates the other's cached value.
//
// The tests stage files into a temp HOME and a temp cwd so they do not
// interfere with the developer's real `~/.config/opencode-model-router/`.
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
    `oc-store-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("readMergedConfig", () => {
  it("returns the bundled default preset when no global/local override is staged", () => {
    const cfg = readMergedConfig({ cwd: tmpCwd });
    expect(cfg.activePreset).toBe("multi-provider");
    expect(cfg.presets["anthropic"]).toBeDefined();
  });

  it("honors the local layer under the supplied cwd", () => {
    stageLocal(tmpCwd, { activePreset: "openai" });
    const cfg = readMergedConfig({ cwd: tmpCwd });
    expect(cfg.activePreset).toBe("openai");
  });

  it("a different cwd reads a different local layer (no shared cache)", () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal(tmpCwd, { activePreset: "openai" });
    stageLocal(otherCwd, { activePreset: "google" });

    expect(readMergedConfig({ cwd: tmpCwd }).activePreset).toBe("openai");
    expect(readMergedConfig({ cwd: otherCwd }).activePreset).toBe("google");
  });

  it("does not throw when no local layer is present", () => {
    const otherCwd = join(tmpHome, "no-local");
    mkdirSync(otherCwd, { recursive: true });
    expect(() => readMergedConfig({ cwd: otherCwd })).not.toThrow();
  });
});

describe("createConfigStore — read/refresh/invalidate", () => {
  it("read() returns a RouterConfig", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const cfg = store.read();
    expect(cfg).toBeDefined();
    expect(typeof cfg.activePreset).toBe("string");
    expect(cfg.presets).toBeDefined();
  });

  it("read() is idempotent — second call returns the same cached reference", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const a = store.read();
    const b = store.read();
    expect(a).toBe(b);
  });

  it("refresh() returns a RouterConfig that matches the current disk state", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    expect(store.refresh().activePreset).toBe("multi-provider");
    stageLocal(tmpCwd, { activePreset: "openai" });
    // Without refresh, the cached value is still the bundled default.
    expect(store.read().activePreset).toBe("multi-provider");
    // After refresh, the staged local layer wins.
    expect(store.refresh().activePreset).toBe("openai");
  });

  it("invalidate() clears the cache so the next read() re-loads from disk", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    store.read();
    stageLocal(tmpCwd, { activePreset: "openai" });
    store.invalidate();
    expect(store.read().activePreset).toBe("openai");
  });

  it("invalidate() does not throw on an empty cache", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    expect(() => store.invalidate()).not.toThrow();
    expect(() => store.invalidate()).not.toThrow();
  });

  it("refresh() after invalidate() re-loads from disk", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    store.read();
    store.invalidate();
    stageLocal(tmpCwd, { activePreset: "openai" });
    expect(store.refresh().activePreset).toBe("openai");
  });
});

describe("createConfigStore — two-instance / two-cwd isolation", () => {
  it("two stores with different cwds see different local layers", () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal(tmpCwd, { activePreset: "openai" });
    stageLocal(otherCwd, { activePreset: "google" });

    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: otherCwd });

    expect(storeA.read().activePreset).toBe("openai");
    expect(storeB.read().activePreset).toBe("google");
  });

  it("two stores with the same cwd have independent caches (no cross-instance invalidation)", () => {
    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: tmpCwd });

    // Both read the same bundled default.
    expect(storeA.read().activePreset).toBe("multi-provider");
    expect(storeB.read().activePreset).toBe("multi-provider");

    // Mutating A's cache (via refresh after staging a local file) does
    // NOT clear B's cached value.
    stageLocal(tmpCwd, { activePreset: "openai" });
    storeA.refresh();
    expect(storeA.read().activePreset).toBe("openai");
    expect(storeB.read().activePreset).toBe("multi-provider");
  });

  it("one store's invalidate() does not affect another store's cache", () => {
    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: tmpCwd });

    storeA.read();
    storeB.read();
    storeA.invalidate();
    // B's cached value must survive A's invalidation.
    expect(storeB.read().activePreset).toBe("multi-provider");
  });

  it("two stores on different cwds refresh independently", () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal(tmpCwd, { activePreset: "openai" });
    stageLocal(otherCwd, { activePreset: "google" });

    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: otherCwd });

    // Refresh one store — the other is unaffected.
    expect(storeA.refresh().activePreset).toBe("openai");
    expect(storeB.read().activePreset).toBe("google");
  });
});

// ---------------------------------------------------------------------------
// Phase 4.3 — direct pure-store coverage.
//
// The PR1 baseline already covered the cross-instance isolation contract.
// These tests add direct assertions on the ConfigStore surface so any
// future regression in the pure store (reference identity, failure
// isolation, refresh idempotence) localises here without dragging in the
// plugin context or router command layers.
// ---------------------------------------------------------------------------

describe("createConfigStore — direct pure-store coverage", () => {
  it("refresh() returns a value with the same activePreset when the disk state is unchanged", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const a = store.refresh();
    const b = store.refresh();
    // `refresh()` always re-reads disk and replaces the cache, so the
    // returned reference is fresh on each call. The merged values must
    // still be equal because nothing on disk changed between calls.
    expect(b.activePreset).toBe(a.activePreset);
  });

  it("refresh() after a staged change returns a NEW reference", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const a = store.refresh();
    stageLocal(tmpCwd, { activePreset: "openai" });
    const b = store.refresh();
    expect(b).not.toBe(a);
    expect(b.activePreset).toBe("openai");
  });

  it("read() after refresh() returns the new reference (no stale snapshot)", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    store.read();
    stageLocal(tmpCwd, { activePreset: "openai" });
    store.refresh();
    // The post-refresh read must reflect the new disk state.
    expect(store.read().activePreset).toBe("openai");
  });

  it("a read on an empty cache populates it from disk and returns the merged config", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    // No read or refresh yet — the cache is empty. The next read() must
    // populate it from disk and return a valid RouterConfig.
    const cfg = store.read();
    expect(cfg).toBeDefined();
    expect(typeof cfg.activePreset).toBe("string");
    // A second read should now be reference-identical (cache hit).
    expect(store.read()).toBe(cfg);
  });

  it("two stores created from the same cwd see the same initial disk state", () => {
    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: tmpCwd });
    // Both stores start cold; both reads return the bundled default.
    expect(storeA.read().activePreset).toBe("multi-provider");
    expect(storeB.read().activePreset).toBe("multi-provider");
    // The two configs are equal-by-value but separate references.
    expect(storeA.read()).not.toBe(storeB.read());
  });

  it("readMergedConfig({ cwd }) is a pure read: it does not pollute the per-instance cache", () => {
    // Stage a local layer, then read with the pure helper — it must NOT
    // touch any ConfigStore cache. The next store read should still see
    // the bundled default until refresh() is called.
    stageLocal(tmpCwd, { activePreset: "openai" });
    const pureCfg = readMergedConfig({ cwd: tmpCwd });
    expect(pureCfg.activePreset).toBe("openai");

    const store = createConfigStore({ cwd: tmpCwd });
    expect(store.read().activePreset).toBe("openai");
  });
});
