// ---------------------------------------------------------------------------
// src/plugin/context.ts — Per-plugin runtime context.
//
// PluginContext is the single object that owns every per-instance store,
// seam, mutex, and bypass state for one loaded copy of the plugin. Hooks
// read/write ctx instead of closing over plugin-scoped locals, so future
// slices (verify dispatch, scorecard dump, registration) can move into
// their own modules while reading identical state.
//
// createPluginContext() constructs the stores lazily from PluginInput and
// returns the fully-wired context. The factory never throws — the inner
// store factories are all safe to call with no arguments.
//
// PR1 of the core-refactor-plan swaps the legacy module-level `loadConfig()`
// singleton for a per-instance `ConfigStore` (see `../router/config-store.ts`):
// - `getConfig()`    → `store.read()`   — returns the cached value or re-reads.
// - `refreshConfig()`→ `store.refresh()`— forces a re-read and replaces the cache.
// One instance's refresh no longer mutates another instance's cached result.
// ---------------------------------------------------------------------------

import type { PluginInput } from "@opencode-ai/plugin";
import type { RouterConfig, Preset } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { createSessionStore } from "../router/sessions";
import { createTrajectoryStore } from "../telemetry/trajectory";
import { createGuardStore } from "../guard/store";
import { createChangedFileStore } from "../verify/dispatch";
import { createMutexRegistry } from "../verify/deterministic";
import type { MutexRegistry } from "../verify/types";
import { createExecSeam } from "../utils/shell";
import { createFsSeam } from "../utils/fs";
import type { ExecSeam, FsSeam } from "../verify/types";
import { createConfigStore } from "../router/config-store";

/**
 * Mutable per-plugin state that isn't a store (today: only the bypass flag).
 * Exposed as a single object so that hook adapters can mutate fields without
 * the context object itself having to be replaced.
 */
export interface PluginState {
  /** When true, the router skips all system-prompt injection, subagent tracking,
   *  cap enforcement, and narration detection for the current plugin lifetime. */
  bypassed: boolean;
}

/** The per-plugin seam bundle. */
export interface PluginSeams {
  exec: ExecSeam;
  fs: FsSeam;
}

/** The full per-plugin context. Hooks in src/index.ts read/write this object. */
export interface PluginContext {
  /** The original PluginInput (for client, directory, $schema, etc.). */
  plugin: PluginInput;

  /** Snapshot of the config as it was when the plugin was loaded. */
  initialConfig: RouterConfig;

  /** Snapshot of `getActiveTiers(initialConfig)` — the load-time preset. */
  activeTiersAtLoad: Preset;

  /** Return the current cached config (may be the initial snapshot, or whatever
   *  /preset / /budget / /router last wrote + re-read). */
  getConfig(): RouterConfig;

  /** Force a fresh read from disk and replace the cached value. */
  refreshConfig(): RouterConfig;

  /** Read the latest config: try a forced refresh, fall back to the cached
   *  value on read failure. Replaces the 7+ duplicated try/refresh/catch
   *  blocks that used to live in `commands.ts` and `hooks.ts`. */
  getFreshConfig(): RouterConfig;

  /** Mutable per-plugin runtime state (bypass flag). */
  state: PluginState;

  /** Per-plugin subagent session store (subagentSessionIDs + subagentCapState). */
  sessionStore: ReturnType<typeof createSessionStore>;

  /** Per-plugin trajectory store (record-only scorecards, opt-in debug dump). */
  trajectoryStore: ReturnType<typeof createTrajectoryStore>;

  /** Per-plugin guard store (Layer 1 hard-block state). */
  guardStore: ReturnType<typeof createGuardStore>;

  /** Per-plugin changed-file store (used by verify-dispatch). */
  changedFileStore: ReturnType<typeof createChangedFileStore>;

  /** Set of currently-open grader session IDs (used to skip grader sessions
   *  in the chat.params temperature override). */
  graderSessions: Set<string>;

  /** Per-cwd mutex registry for deterministic verification runs. */
  verifyMutex: MutexRegistry;

  /** Live adapter seams (exec + fs). */
  seams: PluginSeams;
}

/**
 * Build a fully-wired PluginContext for one plugin instance. Stores are
 * fresh per call, the config is loaded from disk once via the per-instance
 * ConfigStore, and seams are bound to the plugin's working directory.
 */
export function createPluginContext(plugin: PluginInput): PluginContext {
  const configStore = createConfigStore({
    cwd: plugin.directory ?? process.cwd(),
  });
  const initialConfig = configStore.read();
  const activeTiersAtLoad = getActiveTiers(initialConfig);

  return {
    plugin,
    initialConfig,
    activeTiersAtLoad,
    getConfig(): RouterConfig {
      return configStore.read();
    },
    refreshConfig(): RouterConfig {
      return configStore.refresh();
    },
    getFreshConfig(): RouterConfig {
      try {
        return this.refreshConfig();
      } catch {
        // Best-effort: a disk-read error must never crash a real session.
        // Fall back to the cached config so callers can keep using the last
        // known good value.
        return this.getConfig();
      }
    },
    state: {
      bypassed: false,
    },
    sessionStore: createSessionStore(),
    trajectoryStore: createTrajectoryStore(),
    guardStore: createGuardStore(),
    changedFileStore: createChangedFileStore(),
    graderSessions: new Set<string>(),
    verifyMutex: createMutexRegistry(),
    seams: {
      exec: createExecSeam({ directory: plugin.directory }),
      fs: createFsSeam({ directory: plugin.directory }),
    },
  };
}
