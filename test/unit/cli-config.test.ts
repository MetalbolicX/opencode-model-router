// ---------------------------------------------------------------------------
// test/unit/cli-config.test.ts — Unit tests for src/cli/config.ts.
//
// Strategy:
//   - All disk I/O runs through an injected `CliFs` so we stay in-memory
//     and exercise every code path deterministically.
//   - Path-resolution tests save/restore env vars in a `restoreEnv` helper
//     so the developer's real `$HOME` / `$OPENCODE_CONFIG_DIR` is never
//     read or written.
//   - Temp HOME dirs are created with `tmpdir()` + random suffix and
//     cleaned up in `afterEach`.
//
// These tests cover PR 1 of the omr-cli change: config helpers + unit
// tests. PR 2 will add the install/uninstall/status command flow which
// reuses the same `CliFs` shape under integration-level tests.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_LIMIT,
  backupIfWritable,
  buildSpecifier,
  type CliFs,
  dedupePlugins,
  loadGlobalConfig,
  matchesOmr,
  normalizePlugin,
  PLUGIN_NAME,
  parseJsonc,
  resolveConfigDir,
  resolveGlobalConfigPath,
  rotateBackups,
  writeAtomically,
} from "../../src/cli/config";

// ---------------------------------------------------------------------------
// In-memory CliFs adapter
// ---------------------------------------------------------------------------

interface MemFsOptions {
  /** Pre-existing file entries (path → content). */
  files?: Record<string, string>;
}

const createMemFs = (opts: MemFsOptions = {}): CliFs & { __files: Map<string, string> } => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  for (const [p, c] of Object.entries(opts.files ?? {})) {
    files.set(p, c);
  }
  const ensureParentDir = (path: string): void => {
    // Tracks parent directories on every write. The "dirs" set is a
    // built-in existence directory so mkdirSync stays a no-op once the
    // parent has been observed.
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
    mkdirSync: (path) => {
      dirs.add(path);
    },
    readdirSync: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.length === 0) continue;
        const firstSlash = rest.indexOf("/");
        const entry = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
        seen.add(entry);
      }
      return Array.from(seen).sort();
    },
    existsSync: (path) => files.has(path) || dirs.has(path),
  };
  return fs;
};

// ---------------------------------------------------------------------------
// Env save/restore helper
// ---------------------------------------------------------------------------

interface SavedEnv {
  OPENCODE_CONFIG_DIR?: string;
  HOME?: string;
  USERPROFILE?: string;
  XDG_CONFIG_HOME?: string;
}

const ENV_KEYS: (keyof SavedEnv)[] = [
  "OPENCODE_CONFIG_DIR",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
];

const saveEnv = (): SavedEnv => {
  const out: SavedEnv = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
};

const restoreEnv = (saved: SavedEnv): void => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
};

// ---------------------------------------------------------------------------
// parseJsonc
// ---------------------------------------------------------------------------

describe("parseJsonc", () => {
  it("returns {} for empty input", () => {
    expect(parseJsonc("")).toEqual({});
    expect(parseJsonc("   ")).toEqual({});
    expect(parseJsonc("\n\n\t  \n")).toEqual({});
  });

  it("parses plain JSON without any modifications", () => {
    expect(parseJsonc('{"a":1,"b":"two"}')).toEqual({ a: 1, b: "two" });
  });

  it("strips single-line (//) comments", () => {
    const text = `{
      // a heading
      "name": "opencode", // trailing
      "version": 1
    }`;
    expect(parseJsonc(text)).toEqual({ name: "opencode", version: 1 });
  });

  it("strips block (/* */) comments", () => {
    const text = `{
      /* block */
      "name": "opencode",
      /* multi-line
         block */
      "version": 1
    }`;
    expect(parseJsonc(text)).toEqual({ name: "opencode", version: 1 });
  });

  it("removes trailing commas before }", () => {
    const text = `{
      "a": 1,
      "b": 2,
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
  });

  it("removes trailing commas before ]", () => {
    const text = `{
      "list": [1, 2, 3,]
    }`;
    expect(parseJsonc(text)).toEqual({ list: [1, 2, 3] });
  });

  it("preserves // inside string values (URLs)", () => {
    const text = `{
      "url": "https://example.com/path",
      "another": "x//y"
    }`;
    expect(parseJsonc(text)).toEqual({
      url: "https://example.com/path",
      another: "x//y",
    });
  });

  it('preserves \\" sequences inside strings (no false end-of-string)', () => {
    const text = `{
      "escaped": "he said \\"hi//there\\""
    }`;
    expect(parseJsonc(text)).toEqual({ escaped: 'he said "hi//there"' });
  });

  it("handles comments and trailing commas together", () => {
    const text = `{
      // top
      "name": "opencode",
      "tags": ["a", "b", /* mid */],
      "nested": {
        "k": 1, // trailing
      },
    }`;
    expect(parseJsonc(text)).toEqual({
      name: "opencode",
      tags: ["a", "b"],
      nested: { k: 1 },
    });
  });

  it("throws for non-object roots (array, primitive)", () => {
    expect(() => parseJsonc("[1,2,3]")).toThrow("config root must be a JSON object");
    expect(() => parseJsonc("null")).toThrow("config root must be a JSON object");
    expect(() => parseJsonc("42")).toThrow("config root must be a JSON object");
    expect(() => parseJsonc('"hello"')).toThrow("config root must be a JSON object");
    expect(() => parseJsonc("true")).toThrow("config root must be a JSON object");
  });

  it("throws when JSON is invalid", () => {
    expect(() => parseJsonc("{not valid")).toThrow();
    expect(() => parseJsonc('{"unterminated":')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// matchesOmr
// ---------------------------------------------------------------------------

describe("matchesOmr", () => {
  it("matches the bare plugin name", () => {
    expect(matchesOmr(PLUGIN_NAME)).toBe(true);
  });

  it("matches version-pinned variants", () => {
    expect(matchesOmr(`${PLUGIN_NAME}@1.0.0`)).toBe(true);
    expect(matchesOmr(`${PLUGIN_NAME}@latest`)).toBe(true);
    expect(matchesOmr(`${PLUGIN_NAME}@1.2.3-beta.1`)).toBe(true);
  });

  it("does not match unrelated plugins", () => {
    expect(matchesOmr("some-other-plugin")).toBe(false);
    expect(matchesOmr("some-other-plugin@1.0.0")).toBe(false);
  });

  it("does not match scoped packages", () => {
    expect(matchesOmr(`@scope/${PLUGIN_NAME}`)).toBe(false);
  });

  it("does not match non-strings", () => {
    expect(matchesOmr(undefined)).toBe(false);
    expect(matchesOmr(null)).toBe(false);
    expect(matchesOmr({ name: PLUGIN_NAME })).toBe(false);
    expect(matchesOmr(42)).toBe(false);
  });

  it("does not match empty string", () => {
    expect(matchesOmr("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizePlugin
// ---------------------------------------------------------------------------

describe("normalizePlugin", () => {
  it("returns [] for undefined or null", () => {
    expect(normalizePlugin(undefined)).toEqual([]);
    expect(normalizePlugin(null)).toEqual([]);
  });

  it("returns [] for non-object, non-array values", () => {
    expect(normalizePlugin("a string")).toEqual([]);
    expect(normalizePlugin(42)).toEqual([]);
    expect(normalizePlugin(true)).toEqual([]);
  });

  it("returns the same array (filtered to strings) when given an array", () => {
    expect(normalizePlugin(["foo", "bar"])).toEqual(["foo", "bar"]);
    expect(normalizePlugin([PLUGIN_NAME, "other"])).toEqual([PLUGIN_NAME, "other"]);
  });

  it("drops non-string entries from an array", () => {
    expect(normalizePlugin(["foo", null, 42, { bad: true }, "bar"])).toEqual(["foo", "bar"]);
  });

  it("migrates the broken object form to an array of base names", () => {
    const broken = {
      [PLUGIN_NAME]: { version: "1.0.0" },
      "@scope/some-other-plugin": { foo: 1 },
      plain: { whatever: true },
    };
    expect(normalizePlugin(broken)).toEqual([PLUGIN_NAME, "@scope/some-other-plugin", "plain"]);
  });

  it("returns [] for an empty object (treated as 'no plugins declared')", () => {
    expect(normalizePlugin({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dedupePlugins
// ---------------------------------------------------------------------------

describe("dedupePlugins", () => {
  it("returns [] for empty input", () => {
    expect(dedupePlugins([])).toEqual([]);
  });

  it("returns the same entries when no duplicates exist", () => {
    expect(dedupePlugins(["foo", "bar", "baz"])).toEqual(["foo", "bar", "baz"]);
  });

  it("dedupes by base name (before @) and keeps the LAST occurrence", () => {
    expect(dedupePlugins(["foo@1.0.0", "foo@2.0.0", "bar"])).toEqual(["foo@2.0.0", "bar"]);
    expect(dedupePlugins(["foo", "foo@2.0.0"])).toEqual(["foo@2.0.0"]);
  });

  it("removes every opencode-model-router variant, leaving nothing OMR behind", () => {
    expect(
      dedupePlugins([`${PLUGIN_NAME}`, `${PLUGIN_NAME}@1.0.0`, `${PLUGIN_NAME}@2.0.0-beta`]),
    ).toEqual([]);
  });

  it("removes OMR entries while preserving unrelated ones, with last-wins per base", () => {
    const input = [
      `${PLUGIN_NAME}@1.0.0`,
      "alpha",
      `${PLUGIN_NAME}`,
      "beta",
      `${PLUGIN_NAME}@2.0.0`,
      "alpha@9.9.9", // duplicate base name with the no-version "alpha"
    ];
    // Map iteration follows insertion order; "alpha" is inserted first
    // (so its position is set), then "beta" is appended, then the
    // duplicate "alpha@9.9.9" overwrites the value without changing
    // position. Result: ["alpha@9.9.9", "beta"].
    expect(dedupePlugins(input)).toEqual(["alpha@9.9.9", "beta"]);
  });

  it("ignores non-string entries silently", () => {
    // The function contract says callers feed string arrays; defensive
    // filtering here keeps the install pipeline robust to bad inputs.
    const dirty = ["foo", null, 42, { bad: true }, "bar", "bar@2"];
    expect(dedupePlugins(dirty as unknown as string[])).toEqual(["foo", "bar@2"]);
  });

  it("preserves order of distinct entries based on first-seen base name", () => {
    expect(dedupePlugins(["c", "a", "b"])).toEqual(["c", "a", "b"]);
    expect(dedupePlugins(["c@1", "a@1", "b@1"])).toEqual(["c@1", "a@1", "b@1"]);
  });
});

// ---------------------------------------------------------------------------
// buildSpecifier
// ---------------------------------------------------------------------------

describe("buildSpecifier", () => {
  it("returns the bare plugin name when no version is given", () => {
    expect(buildSpecifier()).toBe(PLUGIN_NAME);
  });

  it("returns the bare plugin name for empty / whitespace version", () => {
    expect(buildSpecifier("")).toBe(PLUGIN_NAME);
    expect(buildSpecifier("   ")).toBe(PLUGIN_NAME);
  });

  it("appends @<version> for non-empty versions", () => {
    expect(buildSpecifier("1.0.0")).toBe(`${PLUGIN_NAME}@1.0.0`);
    expect(buildSpecifier("latest")).toBe(`${PLUGIN_NAME}@latest`);
    expect(buildSpecifier(" 1.2.3 ")).toBe(`${PLUGIN_NAME}@1.2.3`);
  });
});

// ---------------------------------------------------------------------------
// backupIfWritable / rotateBackups
// ---------------------------------------------------------------------------

describe("backupIfWritable", () => {
  it("returns null when the config file does not exist", () => {
    const fs = createMemFs();
    const target = "/etc/opencode/opencode.json";
    expect(backupIfWritable(target, fs)).toBeNull();
  });

  it("creates a timestamped backup next to the config", () => {
    const target = "/home/me/.config/opencode/opencode.json";
    const fs = createMemFs({ files: { [target]: '{"plugin":["x"]}' } });

    const backup = backupIfWritable(target, fs);
    expect(backup).not.toBeNull();
    expect(backup).toMatch(/^.*opencode\.json\.bak\.\d{8}T\d{9}Z$/);
    expect(fs.__files.get(backup as string)).toBe('{"plugin":["x"]}');
  });

  it("does not touch the source file", () => {
    const target = "/home/me/.config/opencode/opencode.json";
    const fs = createMemFs({ files: { [target]: '{"plugin":["x"]}' } });
    backupIfWritable(target, fs);
    expect(fs.__files.get(target)).toBe('{"plugin":["x"]}');
  });
});

describe("rotateBackups", () => {
  it("keeps at most `limit` backups (newest first) and removes the rest", () => {
    const dir = "/home/me/.config/opencode";
    const target = `${dir}/opencode.json`;
    // Backups in lexical order from oldest to newest.
    const backups = [
      "opencode.json.bak.20260101T000000000Z",
      "opencode.json.bak.20260102T000000000Z",
      "opencode.json.bak.20260103T000000000Z",
      "opencode.json.bak.20260104T000000000Z",
      "opencode.json.bak.20260105T000000000Z",
    ];
    const files: Record<string, string> = { [target]: "{}" };
    for (const b of backups) files[`${dir}/${b}`] = "{}";
    const fs = createMemFs({ files });

    rotateBackups(target, BACKUP_LIMIT, fs);

    const surviving = (fs.readdirSync(dir) as string[]).filter((n) => n.includes(".bak.")).sort();
    expect(surviving).toEqual(backups.slice(-BACKUP_LIMIT));
  });

  it("does nothing when there are fewer backups than the limit", () => {
    const dir = "/home/me/.config/opencode";
    const target = `${dir}/opencode.json`;
    const backups = [
      "opencode.json.bak.20260101T000000000Z",
      "opencode.json.bak.20260102T000000000Z",
    ];
    const files: Record<string, string> = { [target]: "{}" };
    for (const b of backups) files[`${dir}/${b}`] = "{}";
    const fs = createMemFs({ files });

    rotateBackups(target, 3, fs);

    const surviving = (fs.readdirSync(dir) as string[]).filter((n) => n.includes(".bak."));
    expect(surviving).toEqual([...backups].sort());
  });

  it("does not delete unrelated files in the same directory", () => {
    const dir = "/home/me/.config/opencode";
    const target = `${dir}/opencode.json`;
    const files: Record<string, string> = {
      [target]: "{}",
      [`${dir}/README.md`]: "ignore me",
      [`${dir}/opencode.json.bak.20260101T000000000Z`]: "{}",
      [`${dir}/opencode.json.bak.20260102T000000000Z`]: "{}",
    };
    const fs = createMemFs({ files });

    rotateBackups(target, 1, fs);

    expect(fs.__files.has(`${dir}/README.md`)).toBe(true);
    const surviving = (fs.readdirSync(dir) as string[]).filter((n) => n.includes(".bak."));
    expect(surviving).toEqual(["opencode.json.bak.20260102T000000000Z"]);
  });

  it("BACKUP_LIMIT defaults to 3", () => {
    expect(BACKUP_LIMIT).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// writeAtomically
// ---------------------------------------------------------------------------

describe("writeAtomically", () => {
  it("creates the target file with the expected content", () => {
    const target = "/tmp/opencode/opencode.json";
    const fs = createMemFs();
    writeAtomically(target, '{"plugin":["x"]}', fs);
    expect(fs.__files.get(target)).toBe('{"plugin":["x"]}');
  });

  it("leaves no leftover .tmp-* files after success", () => {
    const target = "/tmp/opencode/opencode.json";
    const fs = createMemFs();
    writeAtomically(target, "{}", fs);
    const entries = fs.readdirSync("/tmp/opencode") as string[];
    const tmps = entries.filter((n) => n.includes(".tmp-"));
    expect(tmps).toEqual([]);
  });

  it("creates parent directories recursively when missing", () => {
    const target = "/tmp/newly/created/dir/opencode.json";
    const fs = createMemFs();
    expect(fs.existsSync("/tmp/newly/created/dir")).toBe(false);
    writeAtomically(target, "{}", fs);
    expect(fs.__files.get(target)).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// resolveGlobalConfigPath
// ---------------------------------------------------------------------------

describe("resolveGlobalConfigPath", () => {
  let saved: SavedEnv;

  beforeEach(() => {
    saved = saveEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("prefers $OPENCODE_CONFIG_DIR over $HOME/.config/opencode", () => {
    process.env["OPENCODE_CONFIG_DIR"] = "/etc/opencode-cli-test";
    delete process.env["HOME"];
    const fs = createMemFs({
      files: {
        "/etc/opencode-cli-test/opencode.json": "{}",
        "/home/elsewhere/.config/opencode/opencode.json": "{}",
      },
    });
    const resolved = resolveGlobalConfigPath(fs);
    expect(resolved.path).toBe("/etc/opencode-cli-test/opencode.json");
    expect(resolved.existed).toBe(true);
    expect(resolved.format).toBe("json");
  });

  it("prefers .json over .jsonc when both exist", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    delete process.env["XDG_CONFIG_HOME"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      files: {
        "/home/me/.config/opencode/opencode.json": "{}",
        "/home/me/.config/opencode/opencode.jsonc": "/* */ {}",
      },
    });
    const resolved = resolveGlobalConfigPath(fs);
    expect(resolved.path).toBe("/home/me/.config/opencode/opencode.json");
    expect(resolved.format).toBe("json");
  });

  it("falls back to .jsonc when .json does not exist", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      files: {
        "/home/me/.config/opencode/opencode.jsonc": "/* hi */ {}",
      },
    });
    const resolved = resolveGlobalConfigPath(fs);
    expect(resolved.path).toBe("/home/me/.config/opencode/opencode.jsonc");
    expect(resolved.format).toBe("jsonc");
  });

  it("returns the default .json path with existed=false when nothing exists", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs();
    const resolved = resolveGlobalConfigPath(fs);
    expect(resolved.existed).toBe(false);
    expect(resolved.format).toBe("json");
    // The resolved path is the install target — primary dir if OPENCODE_CONFIG_DIR is set,
    // else $HOME/.config/opencode. Without OPENCODE_CONFIG_DIR, that's /home/me/.config/opencode.
    expect(resolved.path).toBe("/home/me/.config/opencode/opencode.json");
  });

  it("uses OPENCODE_CONFIG_DIR for the target even when no file exists", () => {
    process.env["OPENCODE_CONFIG_DIR"] = "/custom/dir";
    delete process.env["HOME"];
    const fs = createMemFs();
    const resolved = resolveGlobalConfigPath(fs);
    expect(resolved.path).toBe("/custom/dir/opencode.json");
    expect(resolved.existed).toBe(false);
  });

  it("ignores empty $OPENCODE_CONFIG_DIR and falls back to $HOME", () => {
    process.env["OPENCODE_CONFIG_DIR"] = "   ";
    process.env["HOME"] = "/home/me";
    delete process.env["XDG_CONFIG_HOME"];
    const fs = createMemFs({
      files: { "/home/me/.config/opencode/opencode.json": "{}" },
    });
    const resolved = resolveGlobalConfigPath(fs);
    expect(resolved.path).toBe("/home/me/.config/opencode/opencode.json");
  });
});

// ---------------------------------------------------------------------------
// loadGlobalConfig
// ---------------------------------------------------------------------------

describe("loadGlobalConfig", () => {
  let saved: SavedEnv;

  beforeEach(() => {
    saved = saveEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("returns config={} and existed=false when the file is missing", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs();
    const loaded = loadGlobalConfig(fs);
    expect(loaded.existed).toBe(false);
    expect(loaded.config).toEqual({});
    expect(loaded.path).toBe("/home/me/.config/opencode/opencode.json");
  });

  it("parses an existing .json file", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      files: {
        "/home/me/.config/opencode/opencode.json": '{"plugin":["alpha","beta"]}',
      },
    });
    const loaded = loadGlobalConfig(fs);
    expect(loaded.existed).toBe(true);
    expect(loaded.config).toEqual({ plugin: ["alpha", "beta"] });
    expect(loaded.path).toBe("/home/me/.config/opencode/opencode.json");
  });

  it("strips comments when reading an existing .jsonc file", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      files: {
        "/home/me/.config/opencode/opencode.jsonc": `{
          // top comment
          "plugin": ["a", "b",],
        }`,
      },
    });
    const loaded = loadGlobalConfig(fs);
    expect(loaded.existed).toBe(true);
    expect(loaded.config).toEqual({ plugin: ["a", "b"] });
  });

  it("uses OPENCODE_CONFIG_DIR when set, regardless of $HOME", () => {
    process.env["OPENCODE_CONFIG_DIR"] = "/custom/opencode-test";
    delete process.env["HOME"];
    const fs = createMemFs({
      files: { "/custom/opencode-test/opencode.json": '{"k":1}' },
    });
    const loaded = loadGlobalConfig(fs);
    expect(loaded.path).toBe("/custom/opencode-test/opencode.json");
    expect(loaded.config).toEqual({ k: 1 });
  });

  it("returns parseError when existing config is malformed JSON", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      files: {
        "/home/me/.config/opencode/opencode.json": '{"broken": invalid}',
      },
    });
    const loaded = loadGlobalConfig(fs);
    expect(loaded.existed).toBe(true);
    expect(loaded.config).toEqual({});
    expect(loaded.parseError).toBeDefined();
    expect(loaded.parseError).toContain("Unexpected token");
  });
});

// ---------------------------------------------------------------------------
// `configDir` is an internal helper — re-exported here only to assert the
// precedence rules directly. It is intentionally internal in `config.ts`.
// ---------------------------------------------------------------------------

describe("resolveConfigDir (env precedence)", () => {
  let saved: SavedEnv;

  beforeEach(() => {
    saved = saveEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it("uses OPENCODE_CONFIG_DIR when set", () => {
    process.env["OPENCODE_CONFIG_DIR"] = "/etc/opencode-cli-test";
    delete process.env["HOME"];
    expect(resolveConfigDir()).toBe("/etc/opencode-cli-test");
  });

  it("falls back to $HOME/.config/opencode when OPENCODE_CONFIG_DIR is unset", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    expect(resolveConfigDir()).toBe("/home/me/.config/opencode");
  });
});
