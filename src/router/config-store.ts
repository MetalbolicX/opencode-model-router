// ---------------------------------------------------------------------------
// src/router/config-store.ts — Per-instance config cache.
//
// `createConfigStore({ cwd })` wraps the pure `readMergedConfig({ cwd })`
// helper (from `./config-loader.ts`) with a per-instance cache. Each
// PluginContext owns one ConfigStore; one instance's refresh no longer
// mutates another instance's cached result.
//
// The legacy `loadConfig()` singleton in `src/router/config.ts` keeps the
// module-level cache for existing callers until PR2 task 2.7 removes it.
// ---------------------------------------------------------------------------

import { readMergedConfig, type RouterConfig } from "./config";

/**
 * Per-instance config cache. One ConfigStore per PluginContext; the cache is
 * private to the store and never shared across instances.
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
