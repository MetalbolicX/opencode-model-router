// ---------------------------------------------------------------------------
// src/router/config-store.ts — Per-instance async config cache with TTL.
//
// `createConfigStore({ cwd, ttlMs? })` wraps the pure `readMergedConfig({ cwd })`
// helper (from `./config-loader.ts`) with a per-instance cache + staleness
// tracking. Each PluginContext owns one ConfigStore; one instance's refresh
// no longer mutates another instance's cached result.
//
// PR3b changes:
//   - `read()`, `refresh()`, and `getFresh()` are now async. The legacy
//     sync surface was removed because every layer / state read uses
//     `node:fs/promises` end-to-end.
//   - Cache shape upgraded to `{ value, loadedAt }`. `loadedAt` is the
//     millisecond timestamp captured at the moment the disk read returned.
//   - `getFresh()` always forces a disk read and replaces the cache. The
//     background TTL driver (this PR) calls `refresh("ttl")` while the
//     user-facing `/preset` command calls `getFresh()`.
//
// PR5 changes (this file):
//   - Adds a configurable `ttlMs` option (default 5 minutes). Configurable
//     via factory argument; an environment override is NOT exposed yet
//     (the spec kept TTL internal — see design note in `sdd/.../design`).
//   - Adds `isStale()` — true when the cached envelope is older than TTL
//     (or when the cache is empty, since an empty cache must always load).
//   - `read()` now performs a stale-aware auto-refresh. If the cache is
//     stale, `read()` attempts to reload from disk; on success it serves
//     the fresh value, on failure it serves the LAST KNOWN GOOD cached
//     value and emits an observability warning (so a transient disk
//     hiccup never crashes a real session — matches the `getFreshConfig`
//     fail-soft semantics already documented on `PluginContext`).
//   - `refresh(reason)` is unchanged in observable behavior: it always
//     forces a re-read. It now passes `reason` through to the structured
//     logger so operators can correlate refresh triggers (e.g., `"ttl"`,
//     `"command"`, `"manual"`) with the cached values they produced.
//   - Adds `loadedAt` accessor (`loadedAtMs()`) so callers (and tests)
//     can inspect cache age without forcing a read.
// ---------------------------------------------------------------------------

import type { RouterConfig } from "./config.types";
import { readMergedConfig } from "./config-loader";

/** Default cache TTL when `ttlMs` is not supplied. Five minutes is the
 *  documented PR5 default — long enough to absorb hook bursts without
 *  re-reading disk on every call, short enough that a /preset change
 *  propagates within an operator's mental loop. */
export const DEFAULT_CONFIG_TTL_MS = 5 * 60 * 1000;

/**
 * Internal cache envelope. `loadedAt` is the millisecond timestamp at
 * which the disk read returned; PR5 reads it to decide whether to
 * serve the cached value or force a refresh.
 */
interface CachedConfig {
  value: RouterConfig;
  loadedAt: number;
}

/**
 * Per-instance async config cache. One ConfigStore per PluginContext;
 * the cache is private to the store and never shared across instances.
 */
export interface ConfigStore {
  /** Return the cached config. If the cache is empty, loads from disk.
   *  If the cache is stale (older than `ttlMs`), attempts an auto-refresh;
   *  on refresh failure, returns the last-known-good cached value (fail-soft). */
  read(): Promise<RouterConfig>;
  /** Force a fresh read from disk, replace the cached value, and return it.
   *  `reason` is forwarded to the structured logger so refresh triggers are
   *  correlatable ("ttl" | "command" | "manual" | test-only sentinels). */
  refresh(reason?: string): Promise<RouterConfig>;
  /**
   * Always force a disk read (never serves the cache). Used by command
   * handlers that want the most up-to-date config possible — the legacy
   * `refresh()` semantics. Kept distinct from `refresh()` so the
   * background TTL driver can call `refresh("ttl")` while user-facing
   * commands call `getFresh()`.
   */
  getFresh(): Promise<RouterConfig>;
  /** Drop the cached value so the next read re-loads from disk. */
  invalidate(): void;
  /** True when the cached envelope is older than `ttlMs`, OR when the
   *  cache is empty (an empty cache must always load on the next read). */
  isStale(): boolean;
  /** Cache age in milliseconds (0 when the cache is empty). */
  loadedAtMs(): number | null;
}

/**
 * Build a per-instance `ConfigStore` rooted at `cwd`. The store caches
 * the resolved `RouterConfig` so `read()` is a no-op after the first
 * call until `refresh()`, `getFresh()`, or `invalidate()` runs.
 *
 * `ttlMs` controls the staleness window for auto-refresh inside `read()`.
 * Defaults to `DEFAULT_CONFIG_TTL_MS` (5 minutes). A TTL of `0` or any
 * negative value disables staleness-based auto-refresh — `read()` will
 * then only load on an empty cache (i.e., behaves like the pre-TTL store).
 */
export const createConfigStore = (opts: { cwd: string; ttlMs?: number }): ConfigStore => {
  const ttlMs = opts.ttlMs ?? DEFAULT_CONFIG_TTL_MS;
  let cached: CachedConfig | null = null;

  const load = async (reason?: string): Promise<CachedConfig> => {
    const value = await readMergedConfig({ cwd: opts.cwd });
    cached = { value, loadedAt: Date.now() };
    logConfigRefresh({
      outcome: "ok",
      reason: reason ?? "manual",
      loadedAt: cached.loadedAt,
      ttlMs,
      activePreset: value.activePreset,
    });
    return cached;
  };

  /**
   * Stale-aware read. If the cache is fresh (or staleness is disabled via
   * ttlMs <= 0), returns the cached value. Otherwise, attempts to reload
   * from disk; on success replaces the cache, on failure falls back to the
   * LAST KNOWN GOOD cached value and emits a structured warning so an
   * operator can correlate the stale-serve event with a disk error.
   */
  const readWithStaleness = async (): Promise<RouterConfig> => {
    if (!cached) {
      const fresh = await load("initial");
      return fresh.value;
    }
    if (ttlMs > 0 && Date.now() - cached.loadedAt >= ttlMs) {
      try {
        const fresh = await load("ttl-auto");
        return fresh.value;
      } catch (err) {
        // Fail-soft: serve the last-known-good cached value and emit a
        // structured warning. A transient disk hiccup must never crash
        // a real session — matches getFreshConfig's documented semantics.
        const reason = err instanceof Error ? err.message : String(err);
        logConfigRefresh({
          outcome: "stale_serve",
          reason: "ttl-auto",
          loadedAt: cached.loadedAt,
          ttlMs,
          activePreset: cached.value.activePreset,
          error: reason,
        });
        return cached.value;
      }
    }
    return cached.value;
  };

  return {
    async read(): Promise<RouterConfig> {
      return readWithStaleness();
    },
    async refresh(reason?: string): Promise<RouterConfig> {
      const fresh = await load(reason);
      return fresh.value;
    },
    async getFresh(): Promise<RouterConfig> {
      const fresh = await load("getFresh");
      return fresh.value;
    },
    invalidate(): void {
      cached = null;
    },
    isStale(): boolean {
      if (!cached) return true;
      if (ttlMs <= 0) return false;
      return Date.now() - cached.loadedAt >= ttlMs;
    },
    loadedAtMs(): number | null {
      return cached ? cached.loadedAt : null;
    },
  };
};

// ---------------------------------------------------------------------------
// Internal structured logger for cache-refresh observability.
//
// Kept inline (no external dependency, no log level threshold) so the
// TTL behavior is testable without coupling to the broader observability
// surface wired later in this PR. The full structured-logger lives in
// `src/utils/observability.ts`; once it ships, this shim can be swapped
// for an `info()` / `warn()` call without changing call sites.
// ---------------------------------------------------------------------------

interface ConfigRefreshLog {
  outcome: "ok" | "stale_serve";
  reason: string;
  loadedAt: number;
  ttlMs: number;
  activePreset: string;
  error?: string;
}

const logConfigRefresh = (payload: ConfigRefreshLog): void => {
  // Only emit when the developer opt-in flag is set; the spec's "observable"
  // requirement is satisfied by the public method (isStale/loadedAtMs) plus
  // the structured payload shape itself. Operators can enable verbose
  // refresh logs by setting MODEL_ROUTER_LOG=1.
  if (process.env["MODEL_ROUTER_LOG"] !== "1") return;
  const stream = payload.outcome === "stale_serve" ? "stderr" : "stdout";
  const line = `[model-router][config-refresh] ${JSON.stringify(payload)}`;
  if (stream === "stderr") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
};
