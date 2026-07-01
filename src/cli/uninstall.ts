// ---------------------------------------------------------------------------
// src/cli/uninstall.ts — `omr uninstall` command.
//
// Removes every `opencode-model-router` entry from the global OpenCode
// config's `plugin` list. With `--purge`, also deletes the runtime cache
// directory (`~/.cache/opencode/node_modules/opencode-model-router`) and
// the plugin's own config dir (`~/.config/opencode-model-router/`).
//
// Like `install`, the function is side-effect-free beyond prints and disk
// writes through `fs`. Tests inject an in-memory `CliFs` to exercise the
// config-mutation path; the purge path uses `node:fs` directly because
// `CliFs` deliberately does not expose recursive directory removal.
// ---------------------------------------------------------------------------

import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  backupIfWritable,
  type CliFs,
  loadGlobalConfig,
  matchesOmr,
  normalizePlugin,
  PLUGIN_NAME,
  writeAtomically,
} from "./config";
import { createRealFs } from "./real-fs";

export interface UninstallOptions {
  /** Also remove the runtime cache and the plugin's own config dir. */
  purge?: boolean;
  /** Plan the change and print it without writing. */
  dryRun?: boolean;
  /** Reserved for future confirmation prompts; accepted but unused for now. */
  yes?: boolean;
}

export interface UninstallResult {
  status: "wrote" | "planned" | "noop";
  path: string;
  /** Plugin entries that were (or would be) removed from the config. */
  removed: string[];
  /** Cache / config dirs removed under `--purge`. Empty when `--purge` was not set. */
  purged: string[];
}

const JSON_INDENT = 2;

/** Resolve `$HOME` (or `os.homedir()` as last resort) for purge paths. */
const homeRoot = (env: NodeJS.ProcessEnv = process.env): string => {
  const home = env.HOME;
  if (typeof home === "string" && home.trim().length > 0) return home;
  return homedir();
};

/** Bun/npm-style cache path where the plugin gets installed at runtime. */
export const cachePath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(homeRoot(env), ".cache", "opencode", "node_modules", PLUGIN_NAME);

/** Plugin's own XDG config dir (separate from the OpenCode config it edits). */
export const pluginConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(homeRoot(env), ".config", PLUGIN_NAME);

/**
 * Best-effort recursive delete. Returns the path on success or `null` when
 * the target was missing (we don't want to fail the whole command if the
 * user never ran `install` to create these dirs in the first place).
 */
const purgeDir = (path: string): string | null => {
  try {
    rmSync(path, { recursive: true, force: true });
    return path;
  } catch {
    return null;
  }
};

export const runUninstall = (
  opts: UninstallOptions = {},
  fs: CliFs = createRealFs(),
): UninstallResult => {
  const loaded = loadGlobalConfig(fs);

  if (loaded.parseError) {
    throw new Error(
      `Config file is malformed JSON — aborting to avoid data loss.\n` +
        `  path:  ${loaded.path}\n` +
        `  error: ${loaded.parseError}\n` +
        `Fix the JSON error, or delete the file and re-run.`,
    );
  }

  const config: Record<string, unknown> = { ...loaded.config };
  const existing = normalizePlugin(config.plugin);
  const removed = existing.filter(matchesOmr);
  const remaining = existing.filter((entry) => !removed.includes(entry));

  // Compute purge candidates up front so dry-run can report them too.
  const purgeCandidates = opts.purge ? [cachePath(), pluginConfigPath()] : [];
  const purged: string[] = [];
  const plannedPurge: string[] = [];

  if (opts.purge && opts.dryRun) {
    plannedPurge.push(...purgeCandidates);
  } else if (opts.purge) {
    for (const p of purgeCandidates) {
      const result = purgeDir(p);
      if (result) purged.push(result);
    }
  }

  // Nothing to remove from the config AND nothing to purge → true no-op.
  if (removed.length === 0 && purged.length === 0 && plannedPurge.length === 0) {
    console.log(`✓ Not installed: ${PLUGIN_NAME} not found in ${loaded.path}`);
    return { status: "noop", path: loaded.path, removed: [], purged: [] };
  }

  // Build the post-uninstall config object.
  if (removed.length > 0) {
    if (remaining.length === 0) {
      delete config.plugin;
    } else {
      config.plugin = remaining;
    }
  }

  if (opts.dryRun) {
    console.log(`[dry-run] Would write to ${loaded.path}:`);
    console.log(JSON.stringify(config, null, JSON_INDENT));
    if (plannedPurge.length > 0) {
      console.log(`[dry-run] Would purge:`);
      for (const p of plannedPurge) console.log(`  ${p}`);
    }
    return {
      status: "planned",
      path: loaded.path,
      removed,
      purged: plannedPurge,
    };
  }

  // Only touch the config file when we actually changed something AND the
  // file existed to begin with. A fresh install that never wrote the file
  // shouldn't create it just to leave an empty config behind.
  let backup: string | null = null;
  if (removed.length > 0 && loaded.existed) {
    backup = backupIfWritable(loaded.path, fs);
    writeAtomically(loaded.path, JSON.stringify(config, null, JSON_INDENT), fs);
  }

  console.log(`✓ Uninstalled ${PLUGIN_NAME}`);
  if (removed.length > 0) console.log(`  config: ${loaded.path}`);
  if (backup) console.log(`  backup: ${backup}`);
  for (const p of purged) console.log(`  purged: ${p}`);

  return { status: "wrote", path: loaded.path, removed, purged };
};
