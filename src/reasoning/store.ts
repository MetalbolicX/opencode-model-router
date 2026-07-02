// ---------------------------------------------------------------------------
// src/reasoning/store.ts — Per-plugin-instance reasoning override store.
//
// Mirrors `src/guard/store.ts` (closure-factory pattern, Map keyed by
// sessionID / tier name). Owns three concerns:
//
//   1. Per-session override (`set/get/clear` for a `ReasoningLevel`)
//   2. Per-tier baseline (`set/get` for the static agent def, captured once
//      at config time so the runtime `tool.execute.after` hook can restore it
//      after a `tool.execute.before` patch)
//   3. Per-tier in-flight ownership (`acquireTierOwner` / `releaseTierOwner`)
//      — lets the plugin instance serialise concurrent patches on the same
//      tier. A second same-tier dispatch observes `acquireTierOwner` returning
//      `false` and skips the patch rather than overwriting the in-flight one.
//
// `setPendingNote` / `takePendingNote` from earlier drafts were removed:
// the `surfaceLimits` advisory was never consumed downstream, so the deferred
// note path was dead code. The runtime surfaces surfacing concerns via
// `log.debug({ event: "reasoning.patch_applied" | "reasoning.patch_unsupported" })`
// instead.
// ---------------------------------------------------------------------------

import type { ReasoningLevel } from "./capability.js";

/**
 * Static agent def snapshot taken at config time. The runtime
 * `tool.execute.before` patch mutates a SHALLOW COPY in-place; `tool.execute.after`
 * restores the captured baseline reference, so concurrent unrelated patches
 * to other tiers never see each other's state.
 */
export type AgentBaseline = Record<string, unknown>;

/**
 * Factory: returns a fresh store per plugin instance. No module-level
 * singleton — concurrent plugin instances must not share mutable state.
 */
export const createReasoningStore = () => {
  const overrides = new Map<string, ReasoningLevel>();
  const baselines = new Map<string, AgentBaseline>();
  // Per-tier in-flight owner: the sessionID currently holding the patch lock
  // for a given tier, or `undefined` when no patch is in flight.
  const tierOwners = new Map<string, string>();

  return {
    // ----- session override ------------------------------------------------
    getOverride(sessionID: string): ReasoningLevel | undefined {
      return overrides.get(sessionID);
    },
    setOverride(sessionID: string, level: ReasoningLevel): void {
      overrides.set(sessionID, level);
    },
    clearOverride(sessionID: string): void {
      overrides.delete(sessionID);
    },

    // ----- tier baseline (captured at config time) ------------------------
    setBaseline(tierName: string, baseline: AgentBaseline): void {
      baselines.set(tierName, baseline);
    },
    getBaseline(tierName: string): AgentBaseline | undefined {
      return baselines.get(tierName);
    },

    // ----- per-tier in-flight ownership -----------------------------------
    /**
     * Try to acquire exclusive ownership of `tierName` for `sessionID`.
     * Returns `true` when the caller now owns the tier (either it was
     * free or the caller was already the owner — re-acquiring is a no-op,
     * so a retry on the same session is safe). Returns `false` when a
     * different session already owns the tier; the caller MUST skip the
     * patch and emit a `reasoning.patch_skipped_concurrent` log event.
     */
    acquireTierOwner(tierName: string, sessionID: string): boolean {
      const current = tierOwners.get(tierName);
      if (current === undefined || current === sessionID) {
        tierOwners.set(tierName, sessionID);
        return true;
      }
      return false;
    },
    /**
     * Release ownership of `tierName` for `sessionID`. Returns `true` only
     * when the caller was the owner — a foreign release returns `false`
     * and leaves the owner untouched. The after-hook uses this to ensure
     * a same-tier overlap can't accidentally drop another session's lock.
     */
    releaseTierOwner(tierName: string, sessionID: string): boolean {
      if (tierOwners.get(tierName) !== sessionID) return false;
      tierOwners.delete(tierName);
      return true;
    },
    /**
     * Return the current owner of `tierName`, or `undefined` when free.
     * Exposed for tests + diagnostics; the runtime never reads this.
     */
    getTierOwner(tierName: string): string | undefined {
      return tierOwners.get(tierName);
    },

    // ----- session teardown ------------------------------------------------
    /** Drop every per-session record for `sessionID`. Baselines are kept.
     *  Also releases any tier ownership the session was holding. */
    clear(sessionID: string): void {
      overrides.delete(sessionID);
      for (const [tier, owner] of tierOwners) {
        if (owner === sessionID) tierOwners.delete(tier);
      }
    },
  };
};
