// ---------------------------------------------------------------------------
// src/router/config-loader.ts — Layer loading, merging, and config paths.
//
// Pure layer IO + the deep-merge pipeline. No module-level cache here.
//
// PR3b converts every fs call to `node:fs/promises` and routes failures
// through the typed `RouterConfigError` taxonomy from `./config-errors`.
// Resolution order remains identical (bundled → global → local → state)
// so the observable merged-config contract is unchanged.
//
// Behaviour map (per `spec/config-error-handling.md`):
//   - Required layer (bundled) missing / unreadable / malformed →
//     `RouterConfigError` with `kind` "unreadable" / "malformed".
//   - Optional layer (global, local) missing → `console.warn` + undefined
//     so the loader continues with the next layer.
//   - Optional layer present but unreadable / malformed / invalid →
//     `RouterConfigError` with the matching `kind`. Operators see a hard
//     failure with the offending path instead of silently using defaults.
//   - Bundled layer invalid (semantic violation) → "invalid".
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/observability";
import type { ConfigLayer, RouterConfig, RouterState } from "./config.types";
import { isPlainObject } from "./config.types";
import { RouterConfigError } from "./config-errors";
import { globalConfigPath, resolveConfigPaths } from "./config-paths";
import { resolvePresetName } from "./config-resolve";
import { readState } from "./config-state";
import { validateConfig } from "./config-validate";
import { isValidEnforcementMode } from "./enforcement";

// ---------------------------------------------------------------------------
// Pure merged-config reader.
//
// `readMergedConfig({ cwd })` reads the bundled, global, and local layers for
// `cwd`, deep-merges them in precedence order, validates the merged shape, and
// overlays the persisted runtime state. No module-level cache, no shared
// mutable state — safe to call from multiple callers concurrently.
// ---------------------------------------------------------------------------

/**
 * Pure async config loader: read bundled + global + local layers for `cwd`,
 * deep-merge in precedence order, validate the merged shape, and overlay
 * the persisted runtime state.
 *
 * Layer precedence (highest → lowest): local > global > bundled.
 * State precedence (highest): persisted state file.
 *
 * Throws `RouterConfigError` on any I/O / parse / validation failure. A
 * missing optional layer (global / local) does NOT throw — it warns and
 * is treated as `undefined` so the loader continues with the next layer.
 */
export const readMergedConfig = async (opts: { cwd: string }): Promise<RouterConfig> => {
  const layers: ConfigLayer[] = [
    { kind: "bundled", path: configPath(), required: true },
    { kind: "global", path: globalConfigPath(), required: false },
    {
      kind: "local",
      path: join(opts.cwd, ".opencode", "tiers.json"),
      required: false,
    },
  ];

  const bundled = await readConfigLayer(layers[0]!);
  const global = await readConfigLayer(layers[1]!);
  const local = await readConfigLayer(layers[2]!);

  const mergedManual = deepMergeConfig(deepMergeConfig(bundled, global), local);
  const cfg = validateConfig(mergedManual);

  // Runtime state overlays only its owned fields and never mutates tiers.json.
  const state = await readState();
  applyStateOverlay(cfg, state);

  return cfg;
};

const getPluginRoot = (): string => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Probe both layouts:
  // 1. Source layout: src/router/config-loader.ts → ../../tiers.json (repo root)
  // 2. Bundled layout: dist/plugin.mjs → ../tiers.json (repo root)
  const sourceRoot = join(__dirname, "../..");
  const bundledRoot = join(__dirname, "..");
  if (existsSync(join(bundledRoot, "tiers.json"))) return bundledRoot;
  return sourceRoot;
};

export const configPath = (): string => {
  return join(getPluginRoot(), "tiers.json");
};

/**
 * Re-export the XDG-aware global config path resolver. The signature is
 * preserved (`globalConfigPath(): string`) so callers do not change; the
 * implementation now honours `$XDG_CONFIG_HOME` before falling back to
 * `$HOME/.config/opencode-model-router/tiers.json`.
 */
export { globalConfigPath };

/** Repo-local override path (`<cwd>/.opencode/tiers.json`). Re-evaluated per call. */
export const localConfigPath = (): string => {
  return join(process.cwd(), ".opencode", "tiers.json");
};

// ---------------------------------------------------------------------------
// Per-layer IO
// ---------------------------------------------------------------------------

/**
 * Read a single manual config layer from disk asynchronously.
 * - Returns the parsed JSON object on success.
 * - Returns `undefined` ONLY when an optional layer is missing (ENOENT).
 * - Throws `RouterConfigError` for every other failure mode (missing +
 *   required, unreadable, malformed JSON, non-object root). The `kind`
 *   discriminator lets the caller / startup handler choose between
 *   warn+default (the loader never reaches this branch for optional
 *   missing files; see `warnAndSkip` below) and fail-loud.
 *
 * Exported for `src/router/config-store.ts`; pure with respect to module
 * state (no shared mutable globals).
 */
export const readConfigLayer = async (
  layer: ConfigLayer,
): Promise<Record<string, unknown> | undefined> => {
  let raw: string;
  try {
    raw = await readFile(layer.path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (layer.required) {
        // A required layer (the bundled tiers.json) being absent is an
        // unreadable builtin, not a "missing" condition — the operator
        // cannot recover from it by writing a config file.
        throw new RouterConfigError(
          "unreadable",
          layer.path,
          err,
          `bundled config missing at ${layer.path}`,
        );
      }
      // Optional layer absent → warn + skip (do NOT throw).
      warnAndSkip(layer, "missing");
      return undefined;
    }
    throw new RouterConfigError(
      "unreadable",
      layer.path,
      err,
      `${layer.kind} layer (${layer.path}) is unreadable`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RouterConfigError(
      "malformed",
      layer.path,
      err,
      `${layer.kind} layer (${layer.path}) contains malformed JSON`,
    );
  }

  if (!isPlainObject(parsed)) {
    const shape = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new RouterConfigError(
      "malformed",
      layer.path,
      new Error(`expected JSON object, got ${shape}`),
      `${layer.kind} layer (${layer.path}) must be a JSON object, got ${shape}`,
    );
  }

  return parsed;
};

/**
 * Operator-facing warning for an absent optional layer. Centralized so
 * the format matches the golden-error-message suite (`test/golden/`).
 */
const warnAndSkip = (layer: ConfigLayer, _kind: "missing"): void => {
  log.debug({ event: "config.layer_missing", kind: layer.kind, path: layer.path });
};

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/**
 * Deep-merge two config-shaped values with these rules:
 * - `undefined` in either position returns the other.
 * - Both plain objects ⇒ recursive merge by key union.
 * - Arrays and scalars (including `null`) ⇒ override replaces base.
 * - `null` is NOT a plain object; it is treated as a scalar replacement.
 *
 * Exported for `src/router/config-store.ts`; pure.
 */
export const deepMergeConfig = (base: unknown, override: unknown): unknown => {
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
};

// ---------------------------------------------------------------------------
// State overlay
// ---------------------------------------------------------------------------

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
export const applyStateOverlay = (cfg: RouterConfig, state: RouterState): void => {
  if (state.activePreset) {
    const resolved = resolvePresetName(cfg, state.activePreset);
    if (resolved) {
      cfg.activePreset = resolved;
    }
  }
  if (state.activeMode && cfg.modes?.[state.activeMode]) {
    cfg.activeMode = state.activeMode;
  }
  if (state.enforcementMode && isValidEnforcementMode(state.enforcementMode)) {
    cfg.enforcement = { ...(cfg.enforcement ?? {}), mode: state.enforcementMode };
  }
};

// ---------------------------------------------------------------------------
// Test-only export: re-export `resolveConfigPaths` so tests that want to
// inspect the resolved triple (globalConfig, statePreferred, stateLegacy)
// can import from a single location. Production code uses the convenience
// accessors above.
// ---------------------------------------------------------------------------

export { resolveConfigPaths };
