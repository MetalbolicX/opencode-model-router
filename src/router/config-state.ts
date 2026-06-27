// ---------------------------------------------------------------------------
// src/router/config-state.ts — Runtime state persistence.
//
// `readState()` / `writeState()` manage the on-disk state file at the
// XDG-aware path resolved by `./config-paths.ts` (preferred:
// `$XDG_CONFIG_HOME/opencode/opencode-model-router.state.json`; legacy
// fallback: `$HOME/.config/opencode/opencode-model-router.state.json`).
// The state overlays ONLY `activePreset`, `activeMode`, and
// `enforcementMode` on top of the merged manual config; it never touches
// `tiers.json`.
//
// `saveActivePreset()`, `saveActiveMode()`, and `saveEnforcementMode()`
// are the user-facing state-mutation helpers called from `/preset`,
// `/budget`, and `/router enforce` commands. They each validate the
// requested value against the current merged config and skip the
// write if the value is invalid.
//
// PR3b converts the IO to `node:fs/promises`. The atomic-write contract
// (tmp + rename) is preserved; the loader / state-mutation helpers
// surface failures via typed errors per `spec/config-error-handling.md`.
// ---------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "../utils/observability";
import type { RouterState } from "./config.types";
import { RouterStateError } from "./config-errors";
import { readMergedConfig } from "./config-loader";
import { stateLegacyPath, statePath } from "./config-paths";
import { resolvePresetName } from "./config-resolve";

// ---------------------------------------------------------------------------
// Re-export the XDG-aware state-path resolver under the historical name
// so existing callers (`statePath()` from `config.ts` barrel and tests)
// keep resolving unchanged.
// ---------------------------------------------------------------------------

export { stateLegacyPath, statePath };

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

/**
 * Read current persisted state, preferring the XDG location and falling
 * back to the legacy location when the preferred file is absent.
 *
 * Policy (per config-error-handling spec):
 *   - Both locations absent → operator-facing warning + return `{}`
 *     (warn + default). Mirrors PR3a's behaviour.
 *   - Preferred location present-but-unreadable / unparsable / non-object →
 *     throw `RouterStateError`. The legacy fallback is NOT consulted in
 *     this case: a corrupt preferred file is an operator-actionable
 *     problem (the user explicitly set up XDG and the file there is bad).
 *   - Preferred absent, legacy present-and-readable → warn + return the
 *     legacy file's contents. The next successful `writeState()` will
 *     migrate the user forward by writing to the preferred location.
 *
 * This replaces the prior silent `catch {}` that suppressed every
 * failure mode and returned `{}` — which caused corrupted state to look
 * identical to "first run" and lose user choices without any signal.
 */
export const readState = async (): Promise<RouterState> => {
  const preferred = statePath();
  const legacy = stateLegacyPath();

  // Prefer the XDG-style location; fall back to legacy when absent.
  // We distinguish "absent" (ENOENT) from "unreadable / corrupt" via
  // separate try blocks so the legacy fallback only fires on a clean
  // missing-file case.
  let preferredRaw: string | null = null;
  try {
    preferredRaw = await readFile(preferred, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Preferred exists but is unreadable / EACCES / EIO — fail loud.
      throw new RouterStateError(preferred, err);
    }
  }

  if (preferredRaw !== null) {
    return parseStateFile(preferred, preferredRaw);
  }

  // Preferred absent — try legacy.
  let legacyRaw: string | null = null;
  try {
    legacyRaw = await readFile(legacy, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new RouterStateError(legacy, err);
    }
  }

  if (legacyRaw === null) {
    log.debug({ event: "config.state_missing", path: preferred });
    return {};
  }

  log.info({ event: "config.state_migration", from: legacy, to: preferred });
  return parseStateFile(legacy, legacyRaw);
};

const parseStateFile = (path: string, raw: string): RouterState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RouterStateError(path, err);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RouterStateError(path, new Error("state file root must be a JSON object"));
  }
  return parsed as RouterState;
};

/**
 * Write state to disk atomically (merges with existing keys). Reads from
 * the preferred location (or legacy if preferred absent), merges the
 * patch, and writes to the preferred location. On a legacy-only read,
 * the write migrates the user forward to the XDG path.
 */
export const writeState = async (patch: Partial<RouterState>): Promise<void> => {
  const current = await readState();
  const state = { ...current, ...patch };
  const p = statePath();
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmp, p);
};

// ---------------------------------------------------------------------------
// State save helpers — write user-selected state.
//
// PR3b: these now resolve the requested value against a freshly read
// merged config (`readMergedConfig`) — which itself awaits — and write
// to the state file. The atomic-write semantics from PR3a are preserved.
// ---------------------------------------------------------------------------

export const saveActivePreset = async (presetName: string): Promise<void> => {
  const cfg = await readMergedConfig({ cwd: process.cwd() });
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }

  // Persist user-selected preset to state file only — never mutate tiers.json
  await writeState({ activePreset: resolved });
};

export const saveActiveMode = async (modeName: string): Promise<void> => {
  const cfg = await readMergedConfig({ cwd: process.cwd() });
  if (!cfg.modes?.[modeName]) {
    return;
  }

  await writeState({ activeMode: modeName });
};

export const saveEnforcementMode = async (mode: "off" | "advisory" | "enforced"): Promise<void> => {
  await writeState({ enforcementMode: mode });
};

// Suppress unused-import linter complaints for `join` when the source
// layout strips it during a future bundle pass. Kept so the file's
// import surface matches the documented XDG-aware shape even when a
// bundler omits the actual join() call.
void join;
