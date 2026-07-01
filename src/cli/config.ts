// ---------------------------------------------------------------------------
// src/cli/config.ts — Discovery, JSONC-safe parse, plugin migration helpers,
// backup rotation, and atomic writes for the `omr` CLI.
//
// The CLI edits only the global OpenCode config (`$OPENCODE_CONFIG_DIR` or
// `~/.config/opencode/opencode.json[.jsonc]`). Helpers are split so the
// install / uninstall / status flows in PR 2 can stay thin: pure path and
// merge helpers live here, disk I/O goes through the injected `CliFs` so
// unit tests can run entirely in-memory.
//
// Conventions (PR 1):
//   - All disk I/O is sync. The CLI is short-lived; async buys nothing here
//     and complicates test mock plumbing.
//   - JSONC is stripped before `JSON.parse`; rewritten output is plain JSON.
//   - Plugin migration: legacy object form `{ "<name>": <value> }` is
//     converted to an array of base names before install/uninstall dedup.
//   - Backups are timestamped, kept to the newest `BACKUP_LIMIT` siblings
//     of the config file in the same directory.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** npm package name for this plugin. */
export const PLUGIN_NAME = "opencode-model-router";

/** Maximum number of CLI-created backups retained in the config directory. */
export const BACKUP_LIMIT = 3;

/** Filename used for the OpenCode global config (preferred). */
export const CONFIG_FILE_BASENAME = "opencode";

/** Subdirectory under the user config root that holds `opencode.json`. */
export const OPENCODE_CONFIG_SUBDIR = "opencode";

// ---------------------------------------------------------------------------
// Filesystem abstraction
//
// Sync by design (see file header). Methods mirror the `node:fs` surface
// we actually use; nothing more so tests stay small.
// ---------------------------------------------------------------------------

export interface CliFs {
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface ResolvedConfigPath {
  /** Absolute path to use for reads/writes. `.json` by default. */
  path: string;
  /** "json" when the resolved file ends in `.json`, "jsonc" otherwise. */
  format: "json" | "jsonc";
  /** True when `path` already existed on disk before resolution. */
  existed: boolean;
}

/**
 * Resolve the parent directory that holds the global OpenCode config.
 * `$OPENCODE_CONFIG_DIR` wins; otherwise we fall back to
 * `$HOME/.config/opencode` (or `os.homedir()` as a last-resort).
 *
 * Exposed separately so tests and the rotation helper can reuse it
 * without re-deriving the precedence rules.
 */
export const resolveConfigDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = env.OPENCODE_CONFIG_DIR;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  const home = env.HOME;
  if (typeof home === "string" && home.trim().length > 0) {
    return join(home, ".config", OPENCODE_CONFIG_SUBDIR);
  }
  return join(homedir(), ".config", OPENCODE_CONFIG_SUBDIR);
};

/**
 * Resolve the global OpenCode config file path.
 *
 * Precedence (per spec — "JSONC handling and precedence"):
 *   1. If `$OPENCODE_CONFIG_DIR/opencode.json` exists, use it.
 *   2. Else if `$OPENCODE_CONFIG_DIR/opencode.jsonc` exists, use it.
 *   3. Else fall back to `$HOME/.config/opencode/opencode.json`, then `.jsonc`.
 *   4. If nothing exists, return the preferred target `.json` in the
 *      resolved directory so `install` knows where to create the file.
 *
 * `.json` always wins over `.jsonc` when both exist (spec §"JSONC handling").
 */
export const resolveGlobalConfigPath = (
  fs: CliFs,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfigPath => {
  const primaryDir = resolveConfigDir(env);

  // `$OPENCODE_CONFIG_DIR` always wins; compute its candidates first.
  const explicit = env.OPENCODE_CONFIG_DIR;
  const hasExplicit =
    typeof explicit === "string" && explicit.trim().length > 0 && explicit !== primaryDir;

  // Fallback dir is `$HOME/.config/opencode` — compute it on its own so we
  // can walk both sets independently.
  const fallbackDir = computeFallbackDir(env);

  const json = (dir: string): { path: string; format: "json" } => ({
    path: join(dir, `${CONFIG_FILE_BASENAME}.json`),
    format: "json",
  });
  const jsonc = (dir: string): { path: string; format: "jsonc" } => ({
    path: join(dir, `${CONFIG_FILE_BASENAME}.jsonc`),
    format: "jsonc",
  });

  const candidateFns: ((dir: string) => { path: string; format: "json" | "jsonc" })[] = [
    json,
    jsonc,
  ];
  const dirs: string[] = hasExplicit
    ? [primaryDir]
    : fallbackDir && fallbackDir !== primaryDir
      ? [primaryDir, fallbackDir]
      : [primaryDir];

  for (const dir of dirs) {
    for (const fn of candidateFns) {
      const candidate = fn(dir);
      if (fs.existsSync(candidate.path)) {
        return { path: candidate.path, format: candidate.format, existed: true };
      }
    }
  }

  // No existing file — return the preferred target (`.json` in primary dir).
  const target = json(dirs[0] as string);
  return { ...target, existed: false };
};

const computeFallbackDir = (env: NodeJS.ProcessEnv): string | null => {
  const explicit = env.OPENCODE_CONFIG_DIR;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    // OPENCODE_CONFIG_DIR is authoritative; no `$HOME`-based fallback.
    return null;
  }
  const home = env.HOME;
  if (typeof home === "string" && home.trim().length > 0) {
    return join(home, ".config", OPENCODE_CONFIG_SUBDIR);
  }
  return join(homedir(), ".config", OPENCODE_CONFIG_SUBDIR);
};

// ---------------------------------------------------------------------------
// JSONC stripping
//
// Walks the input character-by-character, tracking string state so we never
// strip `//` that lives inside a JSON string (URLs, "https://...").
// After stripping comments we also remove trailing commas before `}` or `]`.
// ---------------------------------------------------------------------------

/**
 * Strip JSONC-style comments and trailing commas, then parse with `JSON.parse`.
 *
 * Returns `{}` for empty input or whitespace-only input.
 * **Throws** on malformed JSON — callers must handle the error to avoid
 * silently overwriting a corrupt config with an empty one.
 */
export const parseJsonc = (text: string): Record<string, unknown> => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};

  const stripped = stripJsoncComments(trimmed);
  const parsed = JSON.parse(stripped) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config root must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

/**
 * Internal: walk the input, dropping `// ...` and `/* ... * /` comments
 * while preserving everything inside string literals (including strings
 * that contain URL slashes). Trailing commas are removed after the
 * comment pass.
 */
const stripJsoncComments = (text: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const c = text[i] as string;

    if (inString) {
      out += c;
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }

    // Line comment: skip until EOL
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < len && text[i] !== "\n") i++;
      continue;
    }

    // Block comment: skip until closing */
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip past */
      continue;
    }

    out += c;
    i++;
  }

  // Trailing commas before } or ] (with optional whitespace between)
  return out.replace(/,(\s*[}\]])/g, "$1");
};

// ---------------------------------------------------------------------------
// Plugin helpers
// ---------------------------------------------------------------------------

/**
 * True when `entry` is a string that resolves to this plugin by base name.
 * Matches `opencode-model-router` and any `opencode-model-router@<spec>`
 * variant. Non-string entries (legacy object-form leftover) return false.
 */
export const matchesOmr = (entry: unknown): boolean => {
  if (typeof entry !== "string") return false;
  const at = entry.indexOf("@");
  const base = at === -1 ? entry : entry.slice(0, at);
  return base === PLUGIN_NAME;
};

/**
 * Coerce the raw value of `config.plugin` into a clean string array.
 *
 * Handles:
 *   - `undefined` / `null`                 → `[]`
 *   - array of strings (or mixed)          → only the string entries
 *   - the broken object form `{ "<name>": ... }` → the keys (in declaration order)
 *   - any other non-object, non-array shape → `[]` (doctor surfaces it)
 */
export const normalizePlugin = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item === "string") out.push(item);
    }
    return out;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return Object.keys(obj);
  }
  return [];
};

/**
 * Dedupe the plugin list by base name (the part before the first `@`),
 * keeping the LAST occurrence of each base. Any `opencode-model-router`
 * entries are removed entirely so the install flow can append one fresh
 * entry at the end without leaving stale versions behind.
 *
 * Order is preserved for the surviving entries (last-wins per base).
 */
export const dedupePlugins = (entries: readonly string[]): string[] => {
  // Strip all OMR entries first — they will be re-added by the caller
  // with the requested version. This guarantees at most one OMR entry
  // survives, regardless of how many variants already exist.
  const filtered: string[] = [];
  for (const entry of entries) {
    if (!matchesOmr(entry)) filtered.push(entry);
  }

  // Walk in order, overwriting the same base with the latest variant so
  // "last occurrence wins" falls out naturally. Defensive against
  // non-string entries: callers (e.g. `normalizePlugin`) are supposed to
  // pre-filter, but bad input from a corrupt config must not crash the
  // install pipeline.
  const byBase = new Map<string, string>();
  for (const raw of filtered) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const at = raw.indexOf("@");
    const base = at === -1 ? raw : raw.slice(0, at);
    if (base.length === 0) continue; // guard against bare "@scope/spec" split artifacts
    byBase.set(base, raw);
  }
  return Array.from(byBase.values());
};

/**
 * Build the npm specifier we will write into `plugin[]`:
 * `"opencode-model-router"` when no version is supplied, otherwise
 * `"opencode-model-router@<version>"`. Empty / whitespace-only versions
 * are treated as "no version".
 */
export const buildSpecifier = (version?: string): string => {
  if (typeof version !== "string") return PLUGIN_NAME;
  const trimmed = version.trim();
  if (trimmed.length === 0) return PLUGIN_NAME;
  return `${PLUGIN_NAME}@${trimmed}`;
};

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * If `configPath` already exists, copy it next to itself as a timestamped
 * sibling and prune older CLI-created backups so at most `BACKUP_LIMIT`
 * survive (newest first). Returns the backup path, or `null` when no
 * backup was needed (file missing or not writable).
 */
export const backupIfWritable = (configPath: string, fs: CliFs): string | null => {
  if (!fs.existsSync(configPath)) return null;

  const dir = dirname(configPath);
  const base = basename(configPath);
  const stamp = backupTimestamp(new Date());
  const backupPath = join(dir, `${base}.bak.${stamp}`);
  fs.copyFileSync(configPath, backupPath);

  // Rotation is best-effort — a failure here should not abort the install.
  try {
    rotateBackups(configPath, BACKUP_LIMIT, fs);
  } catch {
    // Rotation failed (permission denied, file locked, etc.).
    // The backup was still created; we just have more than BACKUP_LIMIT.
  }

  return backupPath;
};

/**
 * Prune CLI-created backups of `configPath`, keeping only the newest
 * `limit` siblings (lexical order on the timestamp suffix is fine because
 * the stamp is fixed-width and ISO-8601-derived).
 */
export const rotateBackups = (configPath: string, limit: number, fs: CliFs): void => {
  if (limit < 1) return;
  const dir = dirname(configPath);
  const base = basename(configPath);
  const prefix = `${base}.bak.`;
  const entries = fs.readdirSync(dir);
  const backups = entries.filter((name) => name.startsWith(prefix)).sort(); // ISO-derived stamp → lexical sort = chronological sort

  if (backups.length <= limit) return;
  const toRemove = backups.slice(0, backups.length - limit);
  for (const oldName of toRemove) {
    fs.unlinkSync(join(dir, oldName));
  }
};

/**
 * Internal: build a filesystem-safe, chronologically-sortable timestamp
 * for backup filenames. Format: `YYYYMMDDTHHmmssSSSZ` — fixed-width, no
 * colons (Windows-safe), and lexical-sortable from newest to oldest.
 */
const backupTimestamp = (date: Date): string => {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    `${pad(date.getUTCMilliseconds(), 3)}Z`
  );
};

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `targetPath` via a temp sibling + rename. The
 * rename is atomic on POSIX (and best-effort on Windows), so a crashed
 * CLI never leaves a half-written config behind. Any parent directories
 * are created with `{ recursive: true }` so first-run installs Just Work.
 */
export const writeAtomically = (targetPath: string, content: string, fs: CliFs): void => {
  const dir = dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    // Clean up the temp file if rename failed — avoids orphaned .tmp-* files.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadedConfig {
  /** Absolute path the loader used (existing or newly-targeted). */
  path: string;
  /** Parsed config object — `{}` if the file was absent or unreadable. */
  config: Record<string, unknown>;
  /** Whether the file existed on disk before loading. */
  existed: boolean;
  /**
   * If the existing config file is malformed JSON, this contains the
   * error message. Commands must check this and abort rather than
   * silently overwriting the corrupt file with an empty config.
   */
  parseError?: string;
}

/**
 * Resolve the global config path, read it (if it exists), and parse it.
 * Missing files yield `config = {}` and `existed = false` so the install
 * flow can treat "fresh install" and "already installed" the same way.
 *
 * **Throws on corrupt config** — if the file exists but contains malformed
 * JSON, the error propagates so the caller can abort instead of silently
 * overwriting the user's config with an empty one.
 */
export const loadGlobalConfig = (fs: CliFs, env: NodeJS.ProcessEnv = process.env): LoadedConfig => {
  const resolved = resolveGlobalConfigPath(fs, env);
  if (!resolved.existed) {
    return { path: resolved.path, config: {}, existed: false };
  }
  const raw = fs.readFileSync(resolved.path);
  try {
    return { path: resolved.path, config: parseJsonc(raw), existed: true };
  } catch (err) {
    return {
      path: resolved.path,
      config: {},
      existed: true,
      parseError: (err as Error).message,
    };
  }
};
