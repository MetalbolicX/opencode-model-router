// ---------------------------------------------------------------------------
// src/plugin/context.ts — Per-plugin runtime context.
//
// PluginContext is the single object that owns every per-instance store,
// seam, mutex, and bypass state for one loaded copy of the plugin. Hooks
// read/write ctx instead of closing over plugin-scoped locals, so future
// slices (verify dispatch, scorecard dump, registration) can move into
// their own modules while reading identical state.
//
// PR3b changes:
//   - `createPluginContext()` is now `async` because the config loader's
//     disk reads use `node:fs/promises` end-to-end. The initial snapshot
//     `initialConfig` is captured via `await store.read()`.
//   - `getConfig()`, `refreshConfig()`, and `getFreshConfig()` now return
//     `Promise<RouterConfig>`. `getFreshConfig()` retains its fail-soft
//     semantics: it tries a forced refresh and falls back to the cached
//     value on read failure so a transient disk hiccup never crashes a
//     real session.
//
// PR1 of the core-refactor-plan swapped the legacy module-level
// `loadConfig()` singleton for a per-instance `ConfigStore` (see
// `../router/config-store.ts`):
//   - `getConfig()`     → `store.read()`     — returns the cached value
//                                            or re-reads.
//   - `refreshConfig()` → `store.refresh()`  — forces a re-read and
//                                            replaces the cache.
// One instance's refresh no longer mutates another instance's cached
// result.
// ---------------------------------------------------------------------------

import type { PluginInput } from "@opencode-ai/plugin";
import { createGuardStore } from "../guard/store";
import { createReasoningStore } from "../reasoning/store";
import type { Preset, RouterConfig } from "../router/config";
import { createConfigStore } from "../router/config-store";
import { getActiveTiers } from "../router/protocol";
import { createSessionStore } from "../router/sessions";
import { createTrajectoryStore } from "../telemetry/trajectory";
import { createFsSeam } from "../utils/fs";
import { createExecSeam } from "../utils/shell";
import { createMutexRegistry } from "../verify/deterministic";
import { createChangedFileStore } from "../verify/dispatch";
import type { ExecSeam, FsSeam, MutexRegistry } from "../verify/types";

/**
 * Mutable per-plugin runtime state that isn't a store (today: only the bypass flag).
 * Exposed as a single object so that hook adapters can mutate fields without
 * the context object itself having to be replaced.
 */
export interface PluginState {
  /** When true, the router skips all system-prompt injection, subagent tracking,
   *  cap enforcement, and narration detection for the current plugin lifetime. */
  bypassed: boolean;
  /** PR5: track any active timers/intervals so `dispose()` can clear them.
   *  Currently empty (no intervals), but the field exists so adding a
   *  background driver later requires no context-shape change. */
  cleanupTasks: Array<() => void>;
  /** PR5: monotonically-incrementing counter flipped the first time
   *  `dispose()` runs. Subsequent calls are no-ops so a double-shutdown
   *  (opencode sometimes calls dispose twice on hot-reload) cannot
   *  flush a half-cleaned context. */
  shutdownStarted: boolean;
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
  getConfig(): Promise<RouterConfig>;

  /** Force a fresh read from disk and replace the cached value. */
  refreshConfig(): Promise<RouterConfig>;

  /** Read the latest config: try a forced refresh, fall back to the cached
   *  value on read failure. Replaces the 7+ duplicated try/refresh/catch
   *  blocks that used to live in `commands.ts` and `hooks.ts`. */
  getFreshConfig(): Promise<RouterConfig>;

  /** PR5: graceful shutdown. Idempotent — second call is a no-op. Runs
   *  every registered cleanup task in reverse registration order, clears
   *  the timer registry, invalidates the config cache, and flips
   *  `state.shutdownStarted` so any in-flight hook that observes it can
   *  short-circuit. Never throws — a shutdown must not turn into a
   *  crash. The dispose hook in `src/plugin/runtime.ts` is the single
   *  production caller; tests call `dispose()` directly. */
  dispose(): Promise<void>;

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

  /** PR 2 of adaptive-reasoning: per-session override store + per-tier
   *  baseline snapshots + deferred advisory notes. See
   *  `src/reasoning/store.ts`. */
  reasoningStore: ReturnType<typeof createReasoningStore>;

  /** The live `opencodeConfig` reference, captured at `handleConfig` time.
   *  Runtime hooks (tool.execute.before/after) use this to apply / revert
   *  reasoning patches on the targeted tier agent without rebuilding every
   *  tier. Only the agent map is exposed — the rest of the OpenCode config
   *  surface is out of scope for the reasoning feature. */
  opencodeConfig?: { agent?: Record<string, Record<string, unknown>> };

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
 *
 * The factory is `async` because the initial `configStore.read()` uses
 * `node:fs/promises` (PR3b). The remaining store factories are all sync.
 *
 * The three config methods are wired through a mutable holder so that
 * `getFreshConfig()` can call `this.refreshConfig()` / `this.getConfig()`
 * rather than the underlying store directly. This preserves the spy-able
 * surface that `test/unit/get-fresh-config.test.ts` relies on, and keeps
 * the fail-soft fallback symmetric with the pre-async implementation.
 */
export const createPluginContext = async (plugin: PluginInput): Promise<PluginContext> => {
  const configStore = createConfigStore({
    cwd: plugin.directory ?? process.cwd(),
  });
  const initialConfig = await configStore.read();
  const activeTiersAtLoad = getActiveTiers(initialConfig);

  // Build the context as a literal with method-shorthand syntax so
  // `getFreshConfig` can call `this.refreshConfig()` / `this.getConfig()`
  // and remain spy-able via vi.spyOn(ctx, "refreshConfig").
  const ctx: PluginContext = {
    plugin,
    initialConfig,
    activeTiersAtLoad,
    async getConfig(): Promise<RouterConfig> {
      return configStore.read();
    },
    async refreshConfig(): Promise<RouterConfig> {
      return configStore.refresh();
    },
    async getFreshConfig(this: PluginContext): Promise<RouterConfig> {
      try {
        return await this.refreshConfig();
      } catch {
        return await this.getConfig();
      }
    },
    async dispose(this: PluginContext): Promise<void> {
      // Idempotent: a second dispose() call is a no-op. This matters
      // because opencode's plugin lifecycle can call dispose() twice on
      // hot-reload, and a half-cleaned context must not be re-flushed.
      if (this.state.shutdownStarted) return;
      this.state.shutdownStarted = true;
      // Run cleanup tasks in reverse registration order so the last
      // registered task runs first (LIFO matches typical "release"
      // semantics — most recently acquired resource released first).
      // Each task is wrapped in try/catch so one failing cleanup cannot
      // block the others.
      for (const task of this.state.cleanupTasks.slice().reverse()) {
        try {
          task();
        } catch {
          // best-effort: a shutdown must never throw
        }
      }
      this.state.cleanupTasks.length = 0;
      // Invalidate the config cache so any late read after dispose
      // surfaces as a fresh load (the cache cannot outlive the plugin
      // instance — see src/index.ts).
      try {
        configStore.invalidate();
      } catch {
        // best-effort
      }
    },
    state: {
      bypassed: false,
      cleanupTasks: [],
      shutdownStarted: false,
    },
    sessionStore: createSessionStore(),
    trajectoryStore: createTrajectoryStore(),
    guardStore: createGuardStore(),
    changedFileStore: createChangedFileStore(),
    reasoningStore: createReasoningStore(),
    graderSessions: new Set<string>(),
    verifyMutex: createMutexRegistry(),
    seams: {
      exec: createExecSeam({ directory: plugin.directory }),
      fs: createFsSeam({ directory: plugin.directory }),
    },
  };

  return ctx;
};
