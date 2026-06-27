// ---------------------------------------------------------------------------
// src/router/config-validate.ts — Config-shape validation and enforcement
// normalization.
//
// `validateConfig()` is the orchestrator and the single source of truth for
// what a parsed tiers.json (or merged multi-layer result) must look like. It
// delegates each top-level section to a focused, ≤60-line validator:
//
//   validateRootFields / validateRulesAndDefaultTier — primitive scalars
//   validatePresets → validatePreset → validateTier  — preset tree
//   validateModes   → validateMode                    — mode overrides
//   validateTierCaps / validateTierPrompts / validateTaskPatterns
//   validateEnforcement →
//     validateEnforcementMode / validateEnforcementVerify /
//     validateEnforcementEscalate → validateEscalateCostCeiling /
//     validateEnforcementPerTier / validateEnforcementGuard
//
// Every sub-validator throws with a `tiers.json: …` prefix on the first
// failure so the operator sees the exact problem without re-running.
//
// `normalizeEnforcement()` collapses an optional `EnforcementConfig` into a
// record with a default `mode` of `"advisory"` so downstream consumers never
// branch on `undefined`.
// ---------------------------------------------------------------------------

import { type EnforcementConfig, isPlainObject, type RouterConfig } from "./config.types";
import { ENFORCEMENT_MODES, GRADER_POLICIES, VERIFY_REQUIRE_MODES } from "./config-resolve";

const ENFORCEMENT_MODES_LIST = ENFORCEMENT_MODES.join("|");
const VERIFY_REQUIRE_MODES_LIST = VERIFY_REQUIRE_MODES.join("|");
const EXPECTED_GRADER_POLICY = GRADER_POLICIES[0];

// ---------------------------------------------------------------------------
// validateConfig — orchestrator
// ---------------------------------------------------------------------------

export const validateConfig = (raw: unknown): RouterConfig => {
  if (!isPlainObject(raw)) {
    throw new Error("tiers.json: expected a JSON object at root");
  }
  validateRootFields(raw);
  validatePresets(raw);
  validateRulesAndDefaultTier(raw);
  validateModes(raw);
  validateTierCaps(raw);
  validateTierPrompts(raw);
  validateTaskPatterns(raw);
  validateEnforcement(raw);
  return raw as unknown as RouterConfig;
};

// ---------------------------------------------------------------------------
// Root scalars
// ---------------------------------------------------------------------------

export const validateRootFields = (obj: Record<string, unknown>): void => {
  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }
};

export const validateRulesAndDefaultTier = (obj: Record<string, unknown>): void => {
  if (!Array.isArray(obj.rules)) {
    throw new Error("tiers.json: 'rules' must be an array of strings");
  }
  if (typeof obj.defaultTier !== "string") {
    throw new Error("tiers.json: 'defaultTier' must be a string");
  }
};

// ---------------------------------------------------------------------------
// Presets — nested tree: presets → presetName → tierName → tier
// ---------------------------------------------------------------------------

export const validatePresets = (obj: Record<string, unknown>): void => {
  if (!isPlainObject(obj.presets) || Array.isArray(obj.presets)) {
    throw new Error("tiers.json: 'presets' must be a non-null object");
  }
  if (Object.keys(obj.presets).length === 0) {
    throw new Error("tiers.json: 'presets' must have at least one preset");
  }
  for (const [presetName, preset] of Object.entries(obj.presets)) {
    validatePreset(presetName, preset);
  }
};

export const validatePreset = (presetName: string, preset: unknown): void => {
  if (!isPlainObject(preset) || Array.isArray(preset)) {
    throw new Error(`tiers.json: preset '${presetName}' must be an object`);
  }
  for (const [tierName, tier] of Object.entries(preset)) {
    validateTier(presetName, tierName, tier);
  }
};

export const validateTier = (presetName: string, tierName: string, tier: unknown): void => {
  if (!isPlainObject(tier)) {
    throw new Error(`tiers.json: tier '${presetName}.${tierName}' must be an object`);
  }
  if (typeof tier.model !== "string" || !tier.model) {
    throw new Error(`tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`);
  }
  if (typeof tier.description !== "string") {
    throw new Error(`tiers.json: '${presetName}.${tierName}.description' must be a string`);
  }
  if (!Array.isArray(tier.whenToUse)) {
    throw new Error(`tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`);
  }
};

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export const validateModes = (obj: Record<string, unknown>): void => {
  if (obj.modes === undefined) return;
  if (!isPlainObject(obj.modes) || Array.isArray(obj.modes)) {
    throw new Error("tiers.json: 'modes' must be an object");
  }
  for (const [modeName, mode] of Object.entries(obj.modes)) {
    validateMode(modeName, mode);
  }
};

export const validateMode = (modeName: string, mode: unknown): void => {
  if (!isPlainObject(mode)) {
    throw new Error(`tiers.json: mode '${modeName}' must be an object`);
  }
  if (typeof mode.defaultTier !== "string") {
    throw new Error(`tiers.json: mode '${modeName}.defaultTier' must be a string`);
  }
  if (typeof mode.description !== "string") {
    throw new Error(`tiers.json: mode '${modeName}.description' must be a string`);
  }
};

// ---------------------------------------------------------------------------
// Tier caps / prompts / patterns — simple Record<string, …> blocks
// ---------------------------------------------------------------------------

export const validateTierCaps = (obj: Record<string, unknown>): void => {
  if (obj.tierCaps === undefined) return;
  if (!isPlainObject(obj.tierCaps) || Array.isArray(obj.tierCaps)) {
    throw new Error("tiers.json: 'tierCaps' must be an object");
  }
  for (const [tierName, cap] of Object.entries(obj.tierCaps)) {
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
      throw new Error(`tiers.json: tierCaps.'${tierName}' must be a positive integer`);
    }
  }
};

export const validateTierPrompts = (obj: Record<string, unknown>): void => {
  if (obj.tierPrompts === undefined) return;
  if (!isPlainObject(obj.tierPrompts) || Array.isArray(obj.tierPrompts)) {
    throw new Error("tiers.json: 'tierPrompts' must be an object");
  }
  for (const [tierName, prompt] of Object.entries(obj.tierPrompts)) {
    if (typeof prompt !== "string") {
      throw new Error(`tiers.json: tierPrompts.'${tierName}' must be a string`);
    }
  }
};

export const validateTaskPatterns = (obj: Record<string, unknown>): void => {
  if (obj.taskPatterns === undefined) return;
  if (!isPlainObject(obj.taskPatterns) || Array.isArray(obj.taskPatterns)) {
    throw new Error("tiers.json: 'taskPatterns' must be an object");
  }
  for (const [tierName, patterns] of Object.entries(obj.taskPatterns)) {
    if (!Array.isArray(patterns)) {
      throw new Error(`tiers.json: taskPatterns.'${tierName}' must be an array of strings`);
    }
  }
};

// ---------------------------------------------------------------------------
// Enforcement — split into per-key validators
// ---------------------------------------------------------------------------

export const validateEnforcement = (obj: Record<string, unknown>): void => {
  if (obj.enforcement === undefined) return;
  if (!isPlainObject(obj.enforcement) || Array.isArray(obj.enforcement)) {
    throw new Error("tiers.json: enforcement must be an object");
  }
  const enf = obj.enforcement;
  validateEnforcementMode(enf);
  validateEnforcementVerify(enf);
  validateEnforcementEscalate(enf);
  validateEnforcementPerTier(enf);
  validateEnforcementGuard(enf);
};

export const validateEnforcementMode = (enf: Record<string, unknown>): void => {
  if (enf.mode === undefined) return;
  if (
    typeof enf.mode !== "string" ||
    !(ENFORCEMENT_MODES as readonly string[]).includes(enf.mode)
  ) {
    throw new Error(`tiers.json: enforcement.mode must be one of ${ENFORCEMENT_MODES_LIST}`);
  }
};

export const validateEnforcementVerify = (enf: Record<string, unknown>): void => {
  if (enf.verify === undefined) return;
  // Permissive skip: a non-object verify is ignored so older configs survive.
  if (!isPlainObject(enf.verify)) return;
  const verify = enf.verify;
  if (
    verify.graderPolicy !== undefined &&
    !(GRADER_POLICIES as readonly string[]).includes(verify.graderPolicy as string)
  ) {
    throw new Error(
      `tiers.json: enforcement.verify.graderPolicy must be "${EXPECTED_GRADER_POLICY}"`,
    );
  }
  if (verify.require !== undefined) {
    if (
      typeof verify.require !== "string" ||
      !(VERIFY_REQUIRE_MODES as readonly string[]).includes(verify.require)
    ) {
      throw new Error(
        `tiers.json: enforcement.verify.require must be one of ${VERIFY_REQUIRE_MODES_LIST} (got ${JSON.stringify(verify.require)})`,
      );
    }
  }
};

export const validateEnforcementEscalate = (enf: Record<string, unknown>): void => {
  if (enf.escalate === undefined) return;
  // Permissive skip: a non-object escalate is ignored so older configs survive.
  if (!isPlainObject(enf.escalate)) return;
  const escalate = enf.escalate;
  validateEscalateCostCeiling(escalate);
  if (escalate.ladder !== undefined) {
    if (
      !Array.isArray(escalate.ladder) ||
      !escalate.ladder.every((s: unknown) => typeof s === "string")
    ) {
      throw new Error("tiers.json: enforcement.escalate.ladder must be an array of strings");
    }
  }
  if (escalate.maxAttemptsPerTier !== undefined) {
    if (
      typeof escalate.maxAttemptsPerTier !== "number" ||
      !Number.isInteger(escalate.maxAttemptsPerTier) ||
      escalate.maxAttemptsPerTier < 0
    ) {
      throw new Error(
        "tiers.json: enforcement.escalate.maxAttemptsPerTier must be an integer >= 0",
      );
    }
  }
  if (escalate.maxTotalAttempts !== undefined) {
    if (
      typeof escalate.maxTotalAttempts !== "number" ||
      !Number.isInteger(escalate.maxTotalAttempts) ||
      escalate.maxTotalAttempts < 1
    ) {
      throw new Error("tiers.json: enforcement.escalate.maxTotalAttempts must be an integer >= 1");
    }
  }
  if (
    escalate.floorTier !== undefined &&
    escalate.floorTier !== null &&
    typeof escalate.floorTier !== "string"
  ) {
    throw new Error("tiers.json: enforcement.escalate.floorTier must be a string or null");
  }
};

export const validateEscalateCostCeiling = (escalate: Record<string, unknown>): void => {
  if (escalate.costCeiling === undefined) return;
  // Permissive skip: a non-object costCeiling is ignored so older configs survive.
  if (!isPlainObject(escalate.costCeiling)) return;
  const costCeiling = escalate.costCeiling;
  if (costCeiling.multiple !== undefined) {
    if (typeof costCeiling.multiple !== "number" || costCeiling.multiple <= 0) {
      throw new Error("tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0");
    }
  }
};

export const validateEnforcementPerTier = (enf: Record<string, unknown>): void => {
  if (enf.perTier === undefined) return;
  // Permissive skip: a non-object perTier is ignored so older configs survive.
  if (!isPlainObject(enf.perTier) || Array.isArray(enf.perTier)) return;
  for (const [tierName, tierMode] of Object.entries(enf.perTier)) {
    if (
      typeof tierMode !== "string" ||
      !(ENFORCEMENT_MODES as readonly string[]).includes(tierMode)
    ) {
      throw new Error(
        `tiers.json: enforcement.perTier.${tierName} must be one of ${ENFORCEMENT_MODES_LIST}`,
      );
    }
  }
};

export const validateEnforcementGuard = (enf: Record<string, unknown>): void => {
  if (enf.guard === undefined) return;
  // Permissive skip: a non-object guard is ignored so older configs survive.
  if (!isPlainObject(enf.guard)) return;
  const guard = enf.guard;
  if (guard.budget !== undefined) {
    if (typeof guard.budget !== "number" || !Number.isFinite(guard.budget) || guard.budget < 1) {
      throw new Error("enforcement.guard.budget must be a number >= 1");
    }
  }
  if (guard.blockScriptWrites !== undefined) {
    if (typeof guard.blockScriptWrites !== "boolean") {
      throw new Error("enforcement.guard.blockScriptWrites must be a boolean");
    }
  }
};

// ---------------------------------------------------------------------------
// Enforcement helpers
// ---------------------------------------------------------------------------

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"advisory". */
export const normalizeEnforcement = (
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } => {
  return { mode: e?.mode ?? "advisory" };
};
