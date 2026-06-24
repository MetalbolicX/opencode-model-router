// ---------------------------------------------------------------------------
// src/router/config-state.ts — Runtime state persistence.
//
// `readState()` / `writeState()` manage the on-disk state file at
// `~/.config/opencode/opencode-model-router.state.json`. The state
// overlays ONLY `activePreset`, `activeMode`, and `enforcementMode` on
// top of the merged manual config; it never touches `tiers.json`.
//
// `saveActivePreset()`, `saveActiveMode()`, and `saveEnforcementMode()`
// are the user-facing state-mutation helpers called from `/preset`,
// `/budget`, and `/router enforce` commands. They each validate the
// requested value against the current merged config and skip the
// write if the value is invalid.
//
// PR2 task 2.6 migrates these helpers from the legacy `loadConfig()`
// singleton to the pure `readMergedConfig()` pipeline so the singleton
// can be removed (task 2.7).
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RouterConfig, RouterState } from "./config.types";
import { readMergedConfig } from "./config-loader";

// ---------------------------------------------------------------------------
// State file path
// ---------------------------------------------------------------------------

export function statePath(): string {
  return join(
    homedir(),
    ".config",
    "opencode",
    "opencode-model-router.state.json",
  );
}

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

/** Read current persisted state (or empty object on failure). */
export function readState(): RouterState {
  try {
    if (existsSync(statePath())) {
      return JSON.parse(readFileSync(statePath(), "utf-8")) as RouterState;
    }
  } catch {
    // ignore
  }
  return {};
}

/** Write state to disk atomically (merges with existing keys). */
export function writeState(patch: Partial<RouterState>): void {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// State save helpers — write user-selected state.
//
// PR2 task 2.6: these now resolve the requested value against a freshly
// read merged config (`readMergedConfig`) and write ONLY to the state
// file. The legacy module-level cache invalidation is gone — every
// `readMergedConfig` call is a pure disk read.
// ---------------------------------------------------------------------------

export function saveActivePreset(presetName: string): void {
  const cfg = readMergedConfig({ cwd: process.cwd() });
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }

  // Persist user-selected preset to state file only — never mutate tiers.json
  writeState({ activePreset: resolved });
}

export function saveActiveMode(modeName: string): void {
  const cfg = readMergedConfig({ cwd: process.cwd() });
  if (!cfg.modes?.[modeName]) {
    return;
  }

  writeState({ activeMode: modeName });
}

export function saveEnforcementMode(mode: "off" | "advisory" | "enforced"): void {
  writeState({ enforcementMode: mode });
}

/** Inlined mirror of `config-loader.ts → resolvePresetName()`. Kept local to
 *  avoid widening the runtime dependency surface for a single call site. */
function resolvePresetName(
  cfg: RouterConfig,
  requestedPreset: string,
): string | undefined {
  if (cfg.presets[requestedPreset]) {
    return requestedPreset;
  }
  const normalized = requestedPreset.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return Object.keys(cfg.presets).find(
    (name) => name.toLowerCase() === normalized,
  );
}
