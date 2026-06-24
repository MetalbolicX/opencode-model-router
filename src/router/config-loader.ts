// ---------------------------------------------------------------------------
// src/router/config-loader.ts — Layer loading, merging, and config paths.
//
// Pure layer IO + the deep-merge pipeline. No module-level cache here. The
// legacy module-level `loadConfig()` singleton that lived at the bottom of
// `src/router/config.ts` is preserved here during PR1 so existing callers
// keep working; PR2 migrates them and then deletes it (see the "Legacy
// singleton" section at the bottom of this file).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPlainObject } from "./config.types";
import type { ConfigLayer, RouterConfig, RouterState } from "./config.types";
import { validateConfig } from "./config-validate";
import { readState } from "./config-state";

// ---------------------------------------------------------------------------
// Pure merged-config reader.
//
// `readMergedConfig({ cwd })` reads the bundled, global, and local layers for
// `cwd`, deep-merges them in precedence order, validates the merged shape, and
// overlays the persisted runtime state. No module-level cache, no shared
// mutable state — safe to call from multiple callers concurrently.
//
// `createConfigStore()` in `./config-store.ts` wraps this with a per-instance
// cache; the legacy module-level `loadConfig()` singleton below is removed
// in PR2 task 2.7 once all callers migrate to `readMergedConfig`.
// ---------------------------------------------------------------------------

/**
 * Pure config loader: read bundled + global + local layers for `cwd`,
 * deep-merge in precedence order, validate the merged shape, and overlay
 * the persisted runtime state.
 *
 * Layer precedence (highest → lowest): local > global > bundled.
 * State precedence (highest): persisted state file.
 */
export function readMergedConfig(opts: { cwd: string }): RouterConfig {
  const layers: ConfigLayer[] = [
    { kind: "bundled", path: configPath(), required: true },
    { kind: "global", path: globalConfigPath(), required: false },
    {
      kind: "local",
      path: join(opts.cwd, ".opencode", "tiers.json"),
      required: false,
    },
  ];

  const bundled = readConfigLayer(layers[0]!);
  const global = readConfigLayer(layers[1]!);
  const local = readConfigLayer(layers[2]!);

  const mergedManual = deepMergeConfig(
    deepMergeConfig(bundled, global),
    local,
  );
  const cfg = validateConfig(mergedManual);

  // Runtime state overlays only its owned fields and never mutates tiers.json.
  const state = readState();
  applyStateOverlay(cfg, state);

  return cfg;
}

function getPluginRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Probe both layouts:
  // 1. Source layout: src/router/config-loader.ts → ../../tiers.json (repo root)
  // 2. Bundled layout: dist/plugin.mjs → ../tiers.json (repo root)
  const sourceRoot = join(__dirname, "../..");
  const bundledRoot = join(__dirname, "..");
  if (existsSync(join(bundledRoot, "tiers.json"))) return bundledRoot;
  return sourceRoot;
}

export function configPath(): string {
  return join(getPluginRoot(), "tiers.json");
}

/** Global user-level override path (`~/.config/opencode-model-router/tiers.json`). */
export function globalConfigPath(): string {
  return join(homedir(), ".config", "opencode-model-router", "tiers.json");
}

/** Repo-local override path (`<cwd>/.opencode/tiers.json`). Re-evaluated per call. */
export function localConfigPath(): string {
  return join(process.cwd(), ".opencode", "tiers.json");
}

/**
 * Read a single manual config layer from disk.
 * - Returns the parsed JSON object on success.
 * - Returns `undefined` ONLY when an optional layer is missing (ENOENT).
 * - Throws a path-prefixed error for any other read or parse failure, or when
 *   a required layer is missing.
 *
 * Exported for `src/router/config-store.ts`; pure with respect to module state
 * (no shared mutable globals).
 */
export function readConfigLayer(layer: ConfigLayer): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(layer.path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (layer.required) {
        throw new Error(`bundled config missing at ${layer.path}`);
      }
      return undefined;
    }
    throw new Error(
      `${layer.kind} layer (${layer.path}) is unreadable: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${layer.kind} layer (${layer.path}) contains malformed JSON: ${(err as Error).message}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `${layer.kind} layer (${layer.path}) must be a JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }

  return parsed;
}

/**
 * Deep-merge two config-shaped values with these rules:
 * - `undefined` in either position returns the other.
 * - Both plain objects ⇒ recursive merge by key union.
 * - Arrays and scalars (including `null`) ⇒ override replaces base.
 * - `null` is NOT a plain object; it is treated as a scalar replacement.
 *
 * Exported for `src/router/config-store.ts`; pure.
 */
export function deepMergeConfig(base: unknown, override: unknown): unknown {
  if (base === undefined) return override;
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMergeConfig(base[key], override[key]);
    }
    return result;
  }
  return override;
}

/**
 * Narrow state overlay. Writes ONLY:
 * - `state.activePreset` → `cfg.activePreset` when `resolvePresetName()` succeeds
 * - `state.activeMode`   → `cfg.activeMode` when the mode exists in `cfg.modes`
 * - `state.enforcementMode` → `cfg.enforcement.mode`, creating `cfg.enforcement` if missing
 * All other manual fields are preserved unchanged.
 *
 * Exported for `src/router/config-store.ts`; mutates `cfg` in place but has
 * no shared state.
 */
export function applyStateOverlay(cfg: RouterConfig, state: RouterState): void {
  if (state.activePreset) {
    const resolved = resolvePresetName(cfg, state.activePreset);
    if (resolved) {
      cfg.activePreset = resolved;
    }
  }
  if (state.activeMode && cfg.modes?.[state.activeMode]) {
    cfg.activeMode = state.activeMode;
  }
  if (state.enforcementMode) {
    cfg.enforcement = { ...(cfg.enforcement ?? {}), mode: state.enforcementMode };
  }
}

export function resolvePresetName(
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
