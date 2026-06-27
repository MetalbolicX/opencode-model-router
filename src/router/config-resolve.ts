// ---------------------------------------------------------------------------
// src/router/config-resolve.ts — Shared preset-name resolver + enforcement
// mode constants.
//
// Previously, `resolvePresetName()` lived inline in `config-loader.ts` and
// was duplicated as an inlined mirror in `config-state.ts`. PR3a collapses
// both to a single canonical implementation here so the state-overlay
// (loader) and the user-driven `/preset` command (state) agree on the
// exact-match + case-insensitive-fallback contract.
//
// The enforcement-mode constants here are the single source of truth used
// by both runtime validation (`config-validate.ts`) and the runtime
// resolver (`enforcement.ts`). `config-validate.ts` previously had the
// string arrays hard-coded at three call sites; PR3a routes them through
// these named constants so the schema and runtime stay in lockstep.
// ---------------------------------------------------------------------------

import type { RouterConfig } from "./config.types";

/**
 * Resolve a user-supplied preset name to the canonical key in
 * `cfg.presets`. Matching is:
 *   1. Exact key match (returns the requested name unchanged).
 *   2. Trimmed, lower-cased comparison against every preset key
 *      (case-insensitive fallback).
 *   3. `undefined` if the name is blank after trim, or no preset matches.
 *
 * Pure: no fs / network / process.env.
 */
export const resolvePresetName = (
  cfg: RouterConfig,
  requestedPreset: string,
): string | undefined => {
  if (cfg.presets[requestedPreset]) {
    return requestedPreset;
  }

  const normalized = requestedPreset.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return Object.keys(cfg.presets).find((name) => name.toLowerCase() === normalized);
};

// ---------------------------------------------------------------------------
// Enforcement mode constants
// ---------------------------------------------------------------------------

/** Runtime + config-shape union for the three supported enforcement modes. */
export type EnforcementMode = "off" | "advisory" | "enforced";

/** Allowed values for `enforcement.mode` and `enforcement.perTier[*]`. */
export const ENFORCEMENT_MODES: readonly EnforcementMode[] = ["off", "advisory", "enforced"];

/**
 * Allowed values for `enforcement.verify.require` — when the runtime gate
 * (src/verify/gate.ts) should run. `whenDoDPresent` is the default and
 * means "verify only when the dispatch carries a checkable DoD".
 */
export type VerifyRequireMode = "never" | "whenDoDPresent" | "always";

/** Allowed values for `enforcement.verify.require`. */
export const VERIFY_REQUIRE_MODES: readonly VerifyRequireMode[] = [
  "never",
  "whenDoDPresent",
  "always",
];

/**
 * Allowed values for `enforcement.verify.graderPolicy`. Centralized so the
 * config-shape validator and the runtime type union cannot drift.
 */
export type GraderPolicy = "atLeastProducerTier";

/** Allowed values for `enforcement.verify.graderPolicy`. */
export const GRADER_POLICIES: readonly GraderPolicy[] = ["atLeastProducerTier"];
