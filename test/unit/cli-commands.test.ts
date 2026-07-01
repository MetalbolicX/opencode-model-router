// ---------------------------------------------------------------------------
// test/unit/cli-commands.test.ts — Integration tests for CLI commands.
//
// Tests runInstall and runUninstall with an in-memory CliFs to exercise
// the full command orchestration layer without touching disk.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliFs } from "../../src/cli/config";
import { PLUGIN_NAME } from "../../src/cli/config";
import { runInstall } from "../../src/cli/install";
import { runUninstall } from "../../src/cli/uninstall";

// ---------------------------------------------------------------------------
// In-memory CliFs (same pattern as cli-config.test.ts)
// ---------------------------------------------------------------------------

const createMemFs = (initialFiles: Record<string, string> = {}): CliFs & { __files: Map<string, string> } => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  for (const [p, c] of Object.entries(initialFiles)) {
    files.set(p, c);
  }
  const ensureParentDir = (path: string): void => {
    const parts = path.split("/");
    let acc = parts[0] === "" ? "/" : "";
    for (let i = parts[0] === "" ? 1 : 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string);
      if (acc.length > 0) dirs.add(acc);
    }
    if (path.endsWith("/")) dirs.add(path);
  };
  const fs: CliFs & { __files: Map<string, string> } = {
    __files: files,
    readFileSync: (path) => {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(path) as string;
    },
    writeFileSync: (path, content) => {
      ensureParentDir(path);
      files.set(path, content);
    },
    renameSync: (from, to) => {
      if (!files.has(from)) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      ensureParentDir(to);
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    copyFileSync: (from, to) => {
      if (!files.has(from)) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      ensureParentDir(to);
      files.set(to, files.get(from) as string);
    },
    unlinkSync: (path) => {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.delete(path);
    },
    mkdirSync: (path) => { dirs.add(path); },
    readdirSync: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
          if (segment.length > 0) seen.add(segment);
        }
      }
      return [...seen];
    },
    existsSync: (path) => files.has(path) || dirs.has(path),
  };
  return fs;
};

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const CONFIG_PATH = "/home/test/.config/opencode/opencode.json";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    HOME: process.env["HOME"],
    OPENCODE_CONFIG_DIR: process.env["OPENCODE_CONFIG_DIR"],
  };
  delete process.env["OPENCODE_CONFIG_DIR"];
  process.env["HOME"] = "/home/test";
});

afterEach(() => {
  if (savedEnv.HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedEnv.HOME;
  if (savedEnv.OPENCODE_CONFIG_DIR === undefined) delete process.env["OPENCODE_CONFIG_DIR"];
  else process.env["OPENCODE_CONFIG_DIR"] = savedEnv.OPENCODE_CONFIG_DIR;
});

// ---------------------------------------------------------------------------
// Silence console.log during tests
// ---------------------------------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

describe("runInstall", () => {
  it("creates a fresh config when no file exists", () => {
    const fs = createMemFs();
    const result = runInstall({}, fs);

    expect(result.status).toBe("wrote");
    expect(result.specifier).toBe(PLUGIN_NAME);
    expect(result.path).toBe(CONFIG_PATH);

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual([PLUGIN_NAME]);
  });

  it("adds to existing config without losing other keys", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-sonnet-4-5",
        plugin: ["some-other-plugin"],
      }),
    });

    const result = runInstall({}, fs);
    expect(result.status).toBe("wrote");

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.model).toBe("anthropic/claude-sonnet-4-5");
    expect(written.plugin).toEqual(["some-other-plugin", PLUGIN_NAME]);
  });

  it("is idempotent — re-running with same version is a no-op", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });

    const result = runInstall({}, fs);
    expect(result.status).toBe("noop");
  });

  it("replaces existing omr entry with new version", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: ["other", `${PLUGIN_NAME}@1.0.0`] }),
    });

    const result = runInstall({ version: "2.0.0" }, fs);
    expect(result.status).toBe("wrote");

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual(["other", `${PLUGIN_NAME}@2.0.0`]);
  });

  it("dry-run prints but does not write", () => {
    const fs = createMemFs();

    const result = runInstall({ dryRun: true }, fs);
    expect(result.status).toBe("planned");

    // File should NOT exist
    expect(fs.__files.has(CONFIG_PATH)).toBe(false);
    expect(logSpy).toHaveBeenCalled();
  });

  it("throws on corrupt existing config", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: '{"broken": invalid}',
    });

    expect(() => runInstall({}, fs)).toThrow("malformed JSON");
  });

  it("creates a backup before writing", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: ["old"] }),
    });

    const result = runInstall({}, fs);
    expect(result.backup).toBeTruthy();
    expect(result.backup).toMatch(/\.bak\./);
  });

  it("handles config with no plugin array", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ model: "test" }),
    });

    const result = runInstall({}, fs);
    expect(result.status).toBe("wrote");

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual([PLUGIN_NAME]);
    expect(written.model).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// runUninstall
// ---------------------------------------------------------------------------

describe("runUninstall", () => {
  it("removes omr from plugin array", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: ["other", PLUGIN_NAME] }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("wrote");
    expect(result.removed).toEqual([PLUGIN_NAME]);

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual(["other"]);
  });

  it("removes plugin key entirely when array becomes empty", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: [PLUGIN_NAME], model: "test" }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("wrote");

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toBeUndefined();
    expect(written.model).toBe("test");
  });

  it("is a no-op when not installed", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: ["other"] }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("noop");
    expect(result.removed).toEqual([]);
  });

  it("is a no-op when config has no plugin array", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ model: "test" }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("noop");
  });

  it("is a no-op when config file doesn't exist", () => {
    const fs = createMemFs();

    const result = runUninstall({}, fs);
    expect(result.status).toBe("noop");
  });

  it("dry-run prints but does not write", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });

    const result = runUninstall({ dryRun: true }, fs);
    expect(result.status).toBe("planned");

    // Config should be unchanged
    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual([PLUGIN_NAME]);
  });

  it("throws on corrupt existing config", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: '{"broken": invalid}',
    });

    expect(() => runUninstall({}, fs)).toThrow("malformed JSON");
  });

  it("removes versioned omr entries", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`, `${PLUGIN_NAME}@2.0.0`, "other"],
      }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("wrote");
    expect(result.removed).toEqual([`${PLUGIN_NAME}@1.0.0`, `${PLUGIN_NAME}@2.0.0`]);

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual(["other"]);
  });
});
