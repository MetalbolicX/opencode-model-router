import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configPath,
  globalConfigPath,
  localConfigPath,
  readState,
  configPath as realConfigPath,
  saveActiveMode,
  saveActivePreset,
  saveEnforcementMode,
  saveReasoningMode,
} from "../../src/router/config";
import { readMergedConfig } from "../../src/router/config-loader";
import { createConfigStore } from "../../src/router/config-store";

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origXDG_CONFIG_HOME: string | undefined;
let origCwd: string;
let tmpCwd: string;

beforeEach(async () => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origXDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
  tmpHome = join(
    tmpdir(),
    `oc-test-cfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  // Tests must exercise the legacy `$HOME/.config/...` fallback so they
  // do not leak across users who have `XDG_CONFIG_HOME` set globally.
  delete process.env["XDG_CONFIG_HOME"];

  origCwd = process.cwd();
  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  process.chdir(tmpCwd);

  // Invalidate any memoized XDG-path resolution from a previous test.
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
  process.chdir(origCwd);
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

describe("saveActivePreset", () => {
  it("writes the resolved preset to state when valid", async () => {
    await saveActivePreset("anthropic");
    const s = await readState();
    expect(s.activePreset).toBe("anthropic");
  });

  it("resolves case-insensitively and persists the canonical name", async () => {
    await saveActivePreset("Anthropic");
    const s = await readState();
    expect(s.activePreset).toBe("anthropic");
  });

  it("is a no-op for an unknown preset", async () => {
    await saveActivePreset("nonexistent");
    const s = await readState();
    expect(s.activePreset).toBeUndefined();
  });

  it("is a no-op for an empty string", async () => {
    await saveActivePreset("");
    const s = await readState();
    expect(s.activePreset).toBeUndefined();
  });

  it("is a no-op for whitespace-only input", async () => {
    await saveActivePreset("   ");
    const s = await readState();
    expect(s.activePreset).toBeUndefined();
  });

  it("persisted preset is reflected on the next readMergedConfig call", async () => {
    await saveActivePreset("anthropic");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("anthropic");
  });
});

describe("saveActiveMode", () => {
  it("is a no-op for an unknown mode (modes block absent in default config)", async () => {
    await saveActiveMode("unknown-mode");
    const s = await readState();
    expect(s.activeMode).toBeUndefined();
  });

  it("is a no-op for an empty string", async () => {
    await saveActiveMode("");
    const s = await readState();
    expect(s.activeMode).toBeUndefined();
  });

  it("is a no-op for whitespace-only input", async () => {
    await saveActiveMode("   ");
    const s = await readState();
    expect(s.activeMode).toBeUndefined();
  });
});

describe("saveEnforcementMode", () => {
  it("persists 'off' to state", async () => {
    await saveEnforcementMode("off");
    const s = await readState();
    expect(s.enforcementMode).toBe("off");
  });

  it("persists 'advisory' to state", async () => {
    await saveEnforcementMode("advisory");
    const s = await readState();
    expect(s.enforcementMode).toBe("advisory");
  });

  it("persists 'enforced' to state", async () => {
    await saveEnforcementMode("enforced");
    const s = await readState();
    expect(s.enforcementMode).toBe("enforced");
  });

  it("overwrites a previously-persisted enforcement mode", async () => {
    await saveEnforcementMode("off");
    await saveEnforcementMode("enforced");
    const s = await readState();
    expect(s.enforcementMode).toBe("enforced");
  });

  it("does not affect the activePreset key on the state file", async () => {
    await saveEnforcementMode("enforced");
    const s = await readState();
    expect(s.activePreset).toBeUndefined();
  });
});

describe("saveReasoningMode", () => {
  it("persists 'static' to state", async () => {
    await saveReasoningMode("static");
    const s = await readState();
    expect(s.reasoningMode).toBe("static");
  });

  it("persists 'manual' to state", async () => {
    await saveReasoningMode("manual");
    const s = await readState();
    expect(s.reasoningMode).toBe("manual");
  });

  it("overwrites a previously-persisted reasoning mode", async () => {
    await saveReasoningMode("static");
    await saveReasoningMode("manual");
    const s = await readState();
    expect(s.reasoningMode).toBe("manual");
  });

  it("does not affect the enforcementMode key on the state file", async () => {
    await saveReasoningMode("manual");
    const s = await readState();
    expect(s.enforcementMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layered manual config (bundled / global / local) + state overlay
// ---------------------------------------------------------------------------

/** Stage `content` at `<tmpHome>/.config/opencode-model-router/tiers.json`. */
const stageGlobal = (content: string | Record<string, unknown>): void => {
  const dir = join(tmpHome, ".config", "opencode-model-router");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "tiers.json");
  if (typeof content === "string") {
    writeFileSync(p, content, "utf-8");
  } else {
    writeFileSync(p, JSON.stringify(content), "utf-8");
  }
};

/** Stage `content` at `<tmpCwd>/.opencode/tiers.json`. */
const stageLocal = (content: string | Record<string, unknown>): void => {
  const dir = join(tmpCwd, ".opencode");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "tiers.json");
  if (typeof content === "string") {
    writeFileSync(p, content, "utf-8");
  } else {
    writeFileSync(p, JSON.stringify(content), "utf-8");
  }
};

const clearGlobal = (): void => {
  rmSync(globalConfigPath(), { force: true });
};

const clearLocal = (): void => {
  rmSync(localConfigPath(), { force: true });
};

describe("globalConfigPath / localConfigPath", () => {
  it("globalConfigPath resolves under $HOME/.config/opencode-model-router/tiers.json", () => {
    expect(globalConfigPath()).toBe(
      join(tmpHome, ".config", "opencode-model-router", "tiers.json"),
    );
  });

  it("localConfigPath resolves under process.cwd()/.opencode/tiers.json", () => {
    expect(localConfigPath()).toBe(join(tmpCwd, ".opencode", "tiers.json"));
  });

  it("localConfigPath reflects current cwd on each call", () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    process.chdir(otherCwd);
    expect(localConfigPath()).toBe(join(otherCwd, ".opencode", "tiers.json"));
  });
});

describe("Layered config — bundled-only (no overrides)", () => {
  it("loads bundled defaults when global and local are absent", async () => {
    clearGlobal();
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    // Bundled tiers.json sets activePreset to "multi-provider" by default.
    expect(cfg.activePreset).toBe("multi-provider");
    expect(cfg.presets["anthropic"]).toBeDefined();
    expect(cfg.presets["openai"]).toBeDefined();
  });
});

describe("Layered config — precedence table", () => {
  it("global scalar overrides bundled scalar; unrelated bundled fields preserved", async () => {
    stageGlobal({ activePreset: "openai" });
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("openai");
    // Bundled's anthropic preset is unrelated and must survive.
    expect(cfg.presets["anthropic"]).toBeDefined();
    expect(cfg.presets["google"]).toBeDefined();
  });

  it("local scalar overrides bundled scalar when global is absent", async () => {
    clearGlobal();
    stageLocal({ activePreset: "github-copilot" });
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("github-copilot");
    expect(cfg.presets["anthropic"]).toBeDefined();
  });

  it("local wins over global when both present", async () => {
    stageGlobal({ activePreset: "openai" });
    stageLocal({ activePreset: "google" });
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("google");
  });

  it("all three layers: local > global > bundled for the same field", async () => {
    // Bundled has anthropic; global pushes it to openai; local pushes it to google.
    stageGlobal({ activePreset: "openai" });
    stageLocal({ activePreset: "google" });
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("google");
  });

  it("array values: local array replaces bundled (no concat)", async () => {
    clearGlobal();
    stageLocal({
      presets: {
        anthropic: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "fast tier",
            whenToUse: ["only-this-one"],
          },
        },
      },
    });
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    const fast = cfg.presets["anthropic"]?.["fast"];
    expect(fast?.whenToUse).toEqual(["only-this-one"]);
  });

  it("array values: global array replaces bundled", async () => {
    stageGlobal({
      presets: {
        anthropic: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "fast tier",
            whenToUse: ["override-1", "override-2"],
          },
        },
      },
    });
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    const fast = cfg.presets["anthropic"]?.["fast"];
    expect(fast?.whenToUse).toEqual(["override-1", "override-2"]);
  });

  it("nested-object merge: tierPrompts keys merge across layers", async () => {
    // Bundled has tierPrompts.fast/medium/heavy; global adds a new key.
    stageGlobal({
      tierPrompts: { extra: "global-only prompt" },
    });
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.tierPrompts?.["fast"]).toBeDefined();
    expect(cfg.tierPrompts?.["extra"]).toBe("global-only prompt");
  });

  it("nested-object merge: scalar override on a nested key wins, siblings preserved", async () => {
    stageGlobal({
      presets: {
        anthropic: {
          fast: {
            model: "different/model",
            description: "fast tier",
            whenToUse: ["recon"],
          },
        },
      },
    });
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    const fast = cfg.presets["anthropic"]?.["fast"];
    expect(fast?.model).toBe("different/model");
    // Other anthropic tiers must survive the global override.
    expect(cfg.presets["anthropic"]?.["medium"]).toBeDefined();
    expect(cfg.presets["anthropic"]?.["heavy"]).toBeDefined();
  });

  it("nested-object merge: object override on a nested key wins, siblings preserved", async () => {
    // Bundled has tierCaps.fast/medium/heavy; global sets tierCaps.fast = 99.
    stageGlobal({ tierCaps: { fast: 99 } });
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.tierCaps?.["fast"]).toBe(99);
    expect(cfg.tierCaps?.["medium"]).toBeDefined();
    expect(cfg.tierCaps?.["heavy"]).toBeDefined();
  });
});

describe("Layered config — absence cases", () => {
  it("missing global and local falls through to bundled defaults", async () => {
    clearGlobal();
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("multi-provider");
  });

  it("missing global only falls through to bundled (local wins over bundled)", async () => {
    clearGlobal();
    stageLocal({ activePreset: "openai" });
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("openai");
  });

  it("missing local only falls through to bundled (global wins over bundled)", async () => {
    stageGlobal({ activePreset: "openai" });
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("openai");
  });

  it("an empty-object local override is a no-op merge", async () => {
    stageGlobal({ activePreset: "openai" });
    stageLocal({});
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("openai");
    // Bundled's anthropic preset remains intact.
    expect(cfg.presets["anthropic"]).toBeDefined();
  });

  it("an empty-object global override is a no-op merge", async () => {
    clearGlobal();
    stageLocal({ activePreset: "google" });
    stageGlobal({});
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("google");
  });
});

describe("Layered config — error cases", () => {
  it("throws with global path when global contains malformed JSON", async () => {
    stageGlobal("{not valid json");
    clearLocal();
    await expect(readMergedConfig({ cwd: process.cwd() })).rejects.toThrow(/global/);
    await expect(readMergedConfig({ cwd: process.cwd() })).rejects.toThrow(/malformed JSON/);
  });

  it("throws with local path when local contains malformed JSON", async () => {
    clearGlobal();
    stageLocal("{not valid json");
    await expect(readMergedConfig({ cwd: process.cwd() })).rejects.toThrow(/local/);
    await expect(readMergedConfig({ cwd: process.cwd() })).rejects.toThrow(/malformed JSON/);
  });

  it("throws when a global file is empty (empty string is not valid JSON)", async () => {
    stageGlobal("");
    clearLocal();
    await expect(readMergedConfig({ cwd: process.cwd() })).rejects.toThrow(/global/);
  });

  it("throws when a local file is empty", async () => {
    clearGlobal();
    stageLocal("");
    await expect(readMergedConfig({ cwd: process.cwd() })).rejects.toThrow(/local/);
  });

  it("throws when bundled layer is unreadable", async () => {
    // Temporarily move the bundled tiers.json out of the way so the bundled
    // read fails with ENOENT. The bundled file is restored in the finally
    // block even if the assertion throws, so other tests stay green.
    const bundledPath = realConfigPath();
    const backupPath = bundledPath + ".bak-test";
    renameSync(bundledPath, backupPath);
    try {
      await expect(readMergedConfig({ cwd: process.cwd() })).rejects.toThrow(/bundled/);
    } finally {
      renameSync(backupPath, bundledPath);
    }
  });
});

describe("Layered config — state overlay", () => {
  it("state.activePreset wins over bundled defaults", async () => {
    clearGlobal();
    clearLocal();
    await saveActivePreset("openai");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("openai");
  });

  it("state.activePreset wins over global manual layer", async () => {
    stageGlobal({ activePreset: "google" });
    clearLocal();
    await saveActivePreset("openai");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("openai");
  });

  it("state.activeMode wins over manual activeMode when state mode exists", async () => {
    clearGlobal();
    clearLocal();
    // bundled tiers.json already has modes.normal/budget/quality/deep.
    await saveActiveMode("budget");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activeMode).toBe("budget");
  });

  it("state.activeMode is ignored when mode does not exist in cfg.modes", async () => {
    clearGlobal();
    clearLocal();
    await saveActiveMode("not-a-real-mode");
    // bundled activeMode is "normal" — must be preserved.
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activeMode).toBe("normal");
  });

  it("state.enforcementMode wins; cfg.enforcement is created if missing", async () => {
    clearGlobal();
    clearLocal();
    await saveEnforcementMode("enforced");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.enforcement?.mode).toBe("enforced");
  });

  it("state.enforcementMode wins over manual enforcement.mode in merged layers", async () => {
    stageGlobal({ enforcement: { mode: "off" } });
    clearLocal();
    await saveEnforcementMode("enforced");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.enforcement?.mode).toBe("enforced");
  });

  it("invalid enforcementMode in raw state file is ignored", async () => {
    clearGlobal();
    clearLocal();
    // Write a raw state file with an invalid enforcement mode value.
    mkdirSync(join(tmpHome, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".config", "opencode", "opencode-model-router.state.json"),
      JSON.stringify({ enforcementMode: "bogus" }),
      "utf-8",
    );
    // The bundled config has no enforcement block, so when the persisted
    // mode is invalid, cfg.enforcement stays undefined.
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.enforcement).toBeUndefined();
  });

  it("invalid enforcementMode does not wipe out a valid manual enforcement.mode", async () => {
    clearLocal();
    stageGlobal({ enforcement: { mode: "off" } });
    mkdirSync(join(tmpHome, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".config", "opencode", "opencode-model-router.state.json"),
      JSON.stringify({ enforcementMode: "bogus" }),
      "utf-8",
    );
    // Manual "off" should survive when the persisted mode is invalid.
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.enforcement?.mode).toBe("off");
  });

  it("valid enforcementMode in raw state file still overrides manual config", async () => {
    clearLocal();
    stageGlobal({ enforcement: { mode: "off" } });
    mkdirSync(join(tmpHome, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".config", "opencode", "opencode-model-router.state.json"),
      JSON.stringify({ enforcementMode: "enforced" }),
      "utf-8",
    );
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.enforcement?.mode).toBe("enforced");
  });

  it("state.reasoningMode wins; cfg.reasoningPolicy is created if missing", async () => {
    clearGlobal();
    clearLocal();
    await saveReasoningMode("manual");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.reasoningPolicy?.mode).toBe("manual");
  });

  it("state.reasoningMode 'static' wins over manual reasoningPolicy.mode 'manual'", async () => {
    // Bundled reasoningPolicy.mode is "manual"; an overlay of "static" must
    // flip it on the next read.
    clearGlobal();
    clearLocal();
    await saveReasoningMode("static");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.reasoningPolicy?.mode).toBe("static");
  });

  it("state.reasoningMode wins over a local reasoningPolicy.mode override", async () => {
    clearGlobal();
    stageLocal({ reasoningPolicy: { mode: "manual" } });
    // Bundled default is "manual"; overlay with "static" must win.
    await saveReasoningMode("static");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.reasoningPolicy?.mode).toBe("static");
  });

  it("missing state.reasoningMode keeps the bundled reasoningPolicy.mode", async () => {
    // Restart scenario: no overlay is persisted, so the bundled value
    // (manual) survives untouched.
    clearGlobal();
    clearLocal();
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.reasoningPolicy?.mode).toBe("manual");
  });

  it("missing state.reasoningMode keeps a local reasoningPolicy.mode override", async () => {
    clearGlobal();
    stageLocal({ reasoningPolicy: { mode: "static" } });
    // No saveReasoningMode call — the local manual override survives.
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.reasoningPolicy?.mode).toBe("static");
  });

  it("invalid reasoningMode in raw state file is ignored", async () => {
    clearGlobal();
    clearLocal();
    mkdirSync(join(tmpHome, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".config", "opencode", "opencode-model-router.state.json"),
      JSON.stringify({ reasoningMode: "adaptive" }),
      "utf-8",
    );
    // 'adaptive' is not in the persisted overlay's allowed set; the
    // overlay must skip it and the bundled value (manual) must survive.
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.reasoningPolicy?.mode).toBe("manual");
  });

  it("manual activePreset is preserved when no state is written", async () => {
    clearGlobal();
    clearLocal();
    // No saveActivePreset call — bundled default must remain.
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("multi-provider");
  });

  it("state overlay does not leak into unrelated manual fields", async () => {
    stageGlobal({
      presets: {
        anthropic: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "fast tier",
            whenToUse: ["only-this"],
          },
        },
      },
    });
    clearLocal();
    await saveActivePreset("openai");
    const cfg = await readMergedConfig({ cwd: process.cwd() });
    expect(cfg.activePreset).toBe("openai");
    // Manual nested override must survive the state overlay.
    expect(cfg.presets["anthropic"]?.["fast"]?.whenToUse).toEqual(["only-this"]);
  });
});

describe("Layered config — readMergedConfig is always fresh", () => {
  // After PR2 task 2.7, the legacy module-level cache is gone. Every
  // readMergedConfig({ cwd }) call re-reads from disk, so cwd changes and
  // file edits are immediately visible. These tests exercise the new
  // contract directly.

  it("changing cwd is reflected on the next readMergedConfig (no manual invalidation needed)", async () => {
    stageLocal({ activePreset: "openai" });
    expect((await readMergedConfig({ cwd: process.cwd() })).activePreset).toBe("openai");

    const otherCwd = join(tmpHome, "no-local");
    mkdirSync(otherCwd, { recursive: true });
    process.chdir(otherCwd);
    // Bundled default wins because the new cwd has no local override.
    expect((await readMergedConfig({ cwd: process.cwd() })).activePreset).toBe("multi-provider");
  });

  it("editing the local file in place IS reflected on the next read", async () => {
    stageLocal({ activePreset: "openai" });
    expect((await readMergedConfig({ cwd: process.cwd() })).activePreset).toBe("openai");

    // Mutate the local file on disk.
    stageLocal({ activePreset: "google" });
    expect((await readMergedConfig({ cwd: process.cwd() })).activePreset).toBe("google");
  });
});

// ---------------------------------------------------------------------------
// Regression: bundled config path resolution (source vs bundled layout)
// ---------------------------------------------------------------------------

describe("configPath resolution — regression for bundle path bug", () => {
  it("resolves tiers.json from the source layout (src/router/)", () => {
    const path = configPath();
    expect(path).toContain("tiers.json");
    expect(existsSync(path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-instance ConfigStore integration — two-instance and two-CWD isolation.
//
// These exercises prove the Phase-2 invariant at the config-layer surface:
// each ConfigStore has its own cache; one's refresh never mutates another's
// resolved value.
// ---------------------------------------------------------------------------

describe("Per-instance ConfigStore — two-instance isolation", () => {
  it("two stores on the same cwd share disk reads but keep independent caches", async () => {
    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: tmpCwd });
    expect((await storeA.read()).activePreset).toBe((await storeB.read()).activePreset);

    // Stage a new local layer; only the store that refreshes sees it.
    stageLocal({ activePreset: "openai" });
    await storeA.refresh();
    expect((await storeA.read()).activePreset).toBe("openai");
    expect((await storeB.read()).activePreset).toBe("multi-provider");
  });

  it("a ConfigStore's cache survives a fresh readMergedConfig call (no cross-pollination)", async () => {
    // After PR2 task 2.7, readMergedConfig is a pure read; it does not
    // touch any ConfigStore's cache. This was the contract the old
    // invalidateConfigCache(legacy) test asserted indirectly — now we
    // assert it directly on the public surface.
    const store = createConfigStore({ cwd: tmpCwd });
    const before = (await store.read()).activePreset;
    await readMergedConfig({ cwd: process.cwd() });
    expect((await store.read()).activePreset).toBe(before);
  });
});

describe("Per-instance ConfigStore — two-CWD isolation", () => {
  it("two stores on different cwds see different local layers", async () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal({ activePreset: "openai" });
    const otherLocalDir = join(otherCwd, ".opencode");
    mkdirSync(otherLocalDir, { recursive: true });
    writeFileSync(
      join(otherLocalDir, "tiers.json"),
      JSON.stringify({ activePreset: "google" }),
      "utf-8",
    );

    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: otherCwd });
    expect((await storeA.read()).activePreset).toBe("openai");
    expect((await storeB.read()).activePreset).toBe("google");
  });

  it("refreshing one store never invalidates the other store's resolved config", async () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal({ activePreset: "openai" });
    const otherLocalDir = join(otherCwd, ".opencode");
    mkdirSync(otherLocalDir, { recursive: true });
    writeFileSync(
      join(otherLocalDir, "tiers.json"),
      JSON.stringify({ activePreset: "google" }),
      "utf-8",
    );

    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: otherCwd });
    // Snapshot both, refresh one, the other must stay frozen.
    const beforeA = (await storeA.read()).activePreset;
    const beforeB = (await storeB.read()).activePreset;
    expect(beforeA).toBe("openai");
    expect(beforeB).toBe("google");

    await storeA.refresh();
    expect((await storeA.read()).activePreset).toBe("openai");
    expect((await storeB.read()).activePreset).toBe("google");
  });
});
