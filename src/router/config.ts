// ---------------------------------------------------------------------------
// src/router/config.ts — Re-export barrel.
//
// PR2 of the core-refactor-plan splits this file into four focused modules:
//   - `./config.types`     — type interfaces and `isPlainObject`
//   - `./config-loader`    — layer loading, merging, paths
//   - `./config-validate`  — `validateConfig()` and `normalizeEnforcement()`
//   - `./config-state`     — `readState()`, `writeState()`, `saveActive*()`
//
// All public exports are re-exported from here so existing imports of the
// shape `from "./config"` continue to resolve unchanged.
// ---------------------------------------------------------------------------

export * from "./config.types";
export * from "./config-loader";
export * from "./config-validate";
export * from "./config-state";
