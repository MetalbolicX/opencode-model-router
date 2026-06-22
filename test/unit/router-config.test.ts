import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  loadConfig,
  invalidateConfigCache,
  saveActivePreset,
  saveActiveMode,
  saveEnforcementMode,
  globalConfigPath,
  localConfigPath,
  configPath as realConfigPath,
  configPath,
} from "../../src/router/config";
import { createConfigStore } from "../../src/router/config-store";

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origCwd: string;
let tmpCwd: string;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  tmpHome = join(
    tmpdir(),
    `oc-test-cfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;

  origCwd = process.cwd();
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
});

describe("saveActivePreset", () => {
  it("writes the resolved preset to state when valid", () => {
    saveActivePreset("anthropic");
    expect(readState().activePreset).toBe("anthropic");
  });

  it("resolves case-insensitively and persists the canonical name", () => {
    saveActivePreset("Anthropic");
    expect(readState().activePreset).toBe("anthropic");
  });

  it("is a no-op for an unknown preset", () => {
    saveActivePreset("nonexistent");
    expect(readState().activePreset).toBeUndefined();
  });

  it("is a no-op for an empty string", () => {
    saveActivePreset("");
    expect(readState().activePreset).toBeUndefined();
  });

  it("is a no-op for whitespace-only input", () => {
    saveActivePreset("   ");
    expect(readState().activePreset).toBeUndefined();
  });

  it("invalidateConfigCache makes the next loadConfig re-read state", () => {
    saveActivePreset("anthropic");
    invalidateConfigCache();
    expect(loadConfig().activePreset).toBe("anthropic");
  });
});

describe("saveActiveMode", () => {
  it("is a no-op for an unknown mode (modes block absent in default config)", () => {
    saveActiveMode("unknown-mode");
    expect(readState().activeMode).toBeUndefined();
  });

  it("is a no-op for an empty string", () => {
    saveActiveMode("");
    expect(readState().activeMode).toBeUndefined();
  });

  it("is a no-op for whitespace-only input", () => {
    saveActiveMode("   ");
    expect(readState().activeMode).toBeUndefined();
  });
});

describe("saveEnforcementMode", () => {
  it("persists 'off' to state", () => {
    saveEnforcementMode("off");
    expect(readState().enforcementMode).toBe("off");
  });

  it("persists 'advisory' to state", () => {
    saveEnforcementMode("advisory");
    expect(readState().enforcementMode).toBe("advisory");
  });

  it("persists 'enforced' to state", () => {
    saveEnforcementMode("enforced");
    expect(readState().enforcementMode).toBe("enforced");
  });

  it("overwrites a previously-persisted enforcement mode", () => {
    saveEnforcementMode("off");
    saveEnforcementMode("enforced");
    expect(readState().enforcementMode).toBe("enforced");
  });

  it("does not affect the activePreset key on the state file", () => {
    saveEnforcementMode("enforced");
    expect(readState().activePreset).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layered manual config (bundled / global / local) + state overlay
// ---------------------------------------------------------------------------

/** Stage `content` at `<tmpHome>/.config/opencode-model-router/tiers.json`. */
function stageGlobal(content: string | Record<string, unknown>): void {
  const dir = join(tmpHome, ".config", "opencode-model-router");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "tiers.json");
  if (typeof content === "string") {
    writeFileSync(p, content, "utf-8");
  } else {
    writeFileSync(p, JSON.stringify(content), "utf-8");
  }
}

/** Stage `content` at `<tmpCwd>/.opencode/tiers.json`. */
function stageLocal(content: string | Record<string, unknown>): void {
  const dir = join(tmpCwd, ".opencode");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "tiers.json");
  if (typeof content === "string") {
    writeFileSync(p, content, "utf-8");
  } else {
    writeFileSync(p, JSON.stringify(content), "utf-8");
  }
}

function clearGlobal(): void {
  rmSync(globalConfigPath(), { force: true });
}

function clearLocal(): void {
  rmSync(localConfigPath(), { force: true });
}

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
  it("loads bundled defaults when global and local are absent", () => {
    clearGlobal();
    clearLocal();
    const cfg = loadConfig();
    // Bundled tiers.json sets activePreset to "multi-provider" by default.
    expect(cfg.activePreset).toBe("multi-provider");
    expect(cfg.presets["anthropic"]).toBeDefined();
    expect(cfg.presets["openai"]).toBeDefined();
  });
});

describe("Layered config — precedence table", () => {
  it("global scalar overrides bundled scalar; unrelated bundled fields preserved", () => {
    stageGlobal({ activePreset: "openai" });
    clearLocal();
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("openai");
    // Bundled's anthropic preset is unrelated and must survive.
    expect(cfg.presets["anthropic"]).toBeDefined();
    expect(cfg.presets["google"]).toBeDefined();
  });

  it("local scalar overrides bundled scalar when global is absent", () => {
    clearGlobal();
    stageLocal({ activePreset: "github-copilot" });
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("github-copilot");
    expect(cfg.presets["anthropic"]).toBeDefined();
  });

  it("local wins over global when both present", () => {
    stageGlobal({ activePreset: "openai" });
    stageLocal({ activePreset: "google" });
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("google");
  });

  it("all three layers: local > global > bundled for the same field", () => {
    // Bundled has anthropic; global pushes it to openai; local pushes it to google.
    stageGlobal({ activePreset: "openai" });
    stageLocal({ activePreset: "google" });
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("google");
  });

  it("array values: local array replaces bundled (no concat)", () => {
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
    const cfg = loadConfig();
    const fast = cfg.presets["anthropic"]?.["fast"];
    expect(fast?.whenToUse).toEqual(["only-this-one"]);
  });

  it("array values: global array replaces bundled", () => {
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
    const cfg = loadConfig();
    const fast = cfg.presets["anthropic"]?.["fast"];
    expect(fast?.whenToUse).toEqual(["override-1", "override-2"]);
  });

  it("nested-object merge: tierPrompts keys merge across layers", () => {
    // Bundled has tierPrompts.fast/medium/heavy; global adds a new key.
    stageGlobal({
      tierPrompts: { extra: "global-only prompt" },
    });
    clearLocal();
    const cfg = loadConfig();
    expect(cfg.tierPrompts?.["fast"]).toBeDefined();
    expect(cfg.tierPrompts?.["extra"]).toBe("global-only prompt");
  });

  it("nested-object merge: scalar override on a nested key wins, siblings preserved", () => {
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
    const cfg = loadConfig();
    const fast = cfg.presets["anthropic"]?.["fast"];
    expect(fast?.model).toBe("different/model");
    // Other anthropic tiers must survive the global override.
    expect(cfg.presets["anthropic"]?.["medium"]).toBeDefined();
    expect(cfg.presets["anthropic"]?.["heavy"]).toBeDefined();
  });

  it("nested-object merge: object override on a nested key wins, siblings preserved", () => {
    // Bundled has tierCaps.fast/medium/heavy; global sets tierCaps.fast = 99.
    stageGlobal({ tierCaps: { fast: 99 } });
    clearLocal();
    const cfg = loadConfig();
    expect(cfg.tierCaps?.["fast"]).toBe(99);
    expect(cfg.tierCaps?.["medium"]).toBeDefined();
    expect(cfg.tierCaps?.["heavy"]).toBeDefined();
  });
});

describe("Layered config — absence cases", () => {
  it("missing global and local falls through to bundled defaults", () => {
    clearGlobal();
    clearLocal();
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("multi-provider");
  });

  it("missing global only falls through to bundled (local wins over bundled)", () => {
    clearGlobal();
    stageLocal({ activePreset: "openai" });
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("openai");
  });

  it("missing local only falls through to bundled (global wins over bundled)", () => {
    stageGlobal({ activePreset: "openai" });
    clearLocal();
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("openai");
  });

  it("an empty-object local override is a no-op merge", () => {
    stageGlobal({ activePreset: "openai" });
    stageLocal({});
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("openai");
    // Bundled's anthropic preset remains intact.
    expect(cfg.presets["anthropic"]).toBeDefined();
  });

  it("an empty-object global override is a no-op merge", () => {
    clearGlobal();
    stageLocal({ activePreset: "google" });
    stageGlobal({});
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("google");
  });
});

describe("Layered config — error cases", () => {
  it("throws with global path when global contains malformed JSON", () => {
    stageGlobal("{not valid json");
    clearLocal();
    expect(() => loadConfig()).toThrow(/global/);
    expect(() => loadConfig()).toThrow(/malformed JSON/);
  });

  it("throws with local path when local contains malformed JSON", () => {
    clearGlobal();
    stageLocal("{not valid json");
    expect(() => loadConfig()).toThrow(/local/);
    expect(() => loadConfig()).toThrow(/malformed JSON/);
  });

  it("throws when a global file is empty (empty string is not valid JSON)", () => {
    stageGlobal("");
    clearLocal();
    expect(() => loadConfig()).toThrow(/global/);
  });

  it("throws when a local file is empty", () => {
    clearGlobal();
    stageLocal("");
    expect(() => loadConfig()).toThrow(/local/);
  });

  it("throws when bundled layer is unreadable", () => {
    // Temporarily move the bundled tiers.json out of the way so the bundled
    // read fails with ENOENT. The bundled file is restored in the finally
    // block even if the assertion throws, so other tests stay green.
    const bundledPath = realConfigPath();
    const backupPath = bundledPath + ".bak-test";
    renameSync(bundledPath, backupPath);
    try {
      expect(() => loadConfig()).toThrow(/bundled/);
    } finally {
      renameSync(backupPath, bundledPath);
      invalidateConfigCache();
    }
  });
});

describe("Layered config — state overlay", () => {
  it("state.activePreset wins over bundled defaults", () => {
    clearGlobal();
    clearLocal();
    saveActivePreset("openai");
    expect(loadConfig().activePreset).toBe("openai");
  });

  it("state.activePreset wins over global manual layer", () => {
    stageGlobal({ activePreset: "google" });
    clearLocal();
    saveActivePreset("openai");
    expect(loadConfig().activePreset).toBe("openai");
  });

  it("state.activeMode wins over manual activeMode when state mode exists", () => {
    clearGlobal();
    clearLocal();
    // bundled tiers.json already has modes.normal/budget/quality/deep.
    saveActiveMode("budget");
    expect(loadConfig().activeMode).toBe("budget");
  });

  it("state.activeMode is ignored when mode does not exist in cfg.modes", () => {
    clearGlobal();
    clearLocal();
    saveActiveMode("not-a-real-mode");
    // bundled activeMode is "normal" — must be preserved.
    expect(loadConfig().activeMode).toBe("normal");
  });

  it("state.enforcementMode wins; cfg.enforcement is created if missing", () => {
    clearGlobal();
    clearLocal();
    saveEnforcementMode("enforced");
    expect(loadConfig().enforcement?.mode).toBe("enforced");
  });

  it("state.enforcementMode wins over manual enforcement.mode in merged layers", () => {
    stageGlobal({ enforcement: { mode: "off" } });
    clearLocal();
    saveEnforcementMode("enforced");
    expect(loadConfig().enforcement?.mode).toBe("enforced");
  });

  it("manual activePreset is preserved when no state is written", () => {
    clearGlobal();
    clearLocal();
    // No saveActivePreset call — bundled default must remain.
    expect(loadConfig().activePreset).toBe("multi-provider");
  });

  it("state overlay does not leak into unrelated manual fields", () => {
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
    saveActivePreset("openai");
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("openai");
    // Manual nested override must survive the state overlay.
    expect(cfg.presets["anthropic"]?.["fast"]?.whenToUse).toEqual(["only-this"]);
  });
});

describe("Layered config — cwd change requires cache invalidation", () => {
  it("without invalidateConfigCache, changing cwd returns the cached local result", () => {
    stageLocal({ activePreset: "openai" });
    expect(loadConfig().activePreset).toBe("openai");

    // Move to a different cwd with NO local override. The cache still holds
    // the previous local-overriding result until invalidated.
    const otherCwd = join(tmpHome, "no-local");
    mkdirSync(otherCwd, { recursive: true });
    process.chdir(otherCwd);
    expect(loadConfig().activePreset).toBe("openai");
  });

  it("after invalidateConfigCache, changing cwd re-resolves the local layer", () => {
    stageLocal({ activePreset: "openai" });
    expect(loadConfig().activePreset).toBe("openai");

    const otherCwd = join(tmpHome, "no-local");
    mkdirSync(otherCwd, { recursive: true });
    process.chdir(otherCwd);
    invalidateConfigCache();
    // Bundled default wins back once cache is cleared and cwd no longer has a local file.
    expect(loadConfig().activePreset).toBe("multi-provider");
  });

  it("editing the local file in place does NOT reload until cache is invalidated", () => {
    stageLocal({ activePreset: "openai" });
    expect(loadConfig().activePreset).toBe("openai");

    // Mutate the local file on disk.
    stageLocal({ activePreset: "google" });
    // Still the cached value.
    expect(loadConfig().activePreset).toBe("openai");

    invalidateConfigCache();
    expect(loadConfig().activePreset).toBe("google");
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
  it("two stores on the same cwd share disk reads but keep independent caches", () => {
    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: tmpCwd });
    expect(storeA.read().activePreset).toBe(storeB.read().activePreset);

    // Stage a new local layer; only the store that refreshes sees it.
    stageLocal({ activePreset: "openai" });
    storeA.refresh();
    expect(storeA.read().activePreset).toBe("openai");
    expect(storeB.read().activePreset).toBe("multi-provider");
  });

  it("invalidateConfigCache (legacy) does not affect a ConfigStore's cache", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const before = store.read().activePreset;
    invalidateConfigCache();
    expect(store.read().activePreset).toBe(before);
  });
});

describe("Per-instance ConfigStore — two-CWD isolation", () => {
  it("two stores on different cwds see different local layers", () => {
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
    expect(storeA.read().activePreset).toBe("openai");
    expect(storeB.read().activePreset).toBe("google");
  });

  it("refreshing one store never invalidates the other store's resolved config", () => {
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
    const beforeA = storeA.read().activePreset;
    const beforeB = storeB.read().activePreset;
    expect(beforeA).toBe("openai");
    expect(beforeB).toBe("google");

    storeA.refresh();
    expect(storeA.read().activePreset).toBe("openai");
    expect(storeB.read().activePreset).toBe("google");
  });
});
