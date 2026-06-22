// ---------------------------------------------------------------------------
// src/router/config-store.ts — Per-instance config cache.
//
// Splits the layer-merge pipeline into a pure `readMergedConfig({cwd})` function
// (no module-level state) and a `ConfigStore` factory that wraps it with a
// per-instance cache. Each PluginContext owns one ConfigStore; one instance's
// refresh no longer mutates another instance's cached result.
//
// The legacy `loadConfig()` singleton in `src/router/config.ts` keeps the
// module-level cache for existing callers; PR1 does not change that surface.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import {
  applyStateOverlay,
  configPath,
  deepMergeConfig,
  globalConfigPath,
  readConfigLayer,
  readState,
  validateConfig,
  type ConfigLayer,
} from "./config";
import type { RouterConfig } from "./config";

/**
 * Per-instance config cache. One ConfigStore per PluginContext; the cache is
 * private to the store and never shared across instances or with the legacy
 * `loadConfig()` singleton.
 */
export interface ConfigStore {
  /** Return the cached config (re-read from disk if the cache is empty). */
  read(): RouterConfig;
  /** Force a fresh read from disk, replace the cached value, and return it. */
  refresh(): RouterConfig;
  /** Drop the cached value so the next read re-loads from disk. */
  invalidate(): void;
}

/**
 * Pure config loader: read bundled + global + local layers for `cwd`,
 * deep-merge in precedence order, validate the merged shape, and overlay
 * the persisted runtime state. No module-level cache, no shared mutable
 * state — safe to call from multiple ConfigStore instances concurrently.
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

/**
 * Build a per-instance `ConfigStore` rooted at `cwd`. The store caches the
 * resolved `RouterConfig` so `read()` is a no-op after the first call until
 * `refresh()` or `invalidate()` runs.
 */
export function createConfigStore(opts: { cwd: string }): ConfigStore {
  let cached: RouterConfig | null = null;

  return {
    read(): RouterConfig {
      if (cached) return cached;
      cached = readMergedConfig(opts);
      return cached;
    },
    refresh(): RouterConfig {
      cached = readMergedConfig(opts);
      return cached;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
