import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Layered manual config helpers
//
// `loadConfig()` resolves three static manual layers — bundled, global,
// local — merges them in precedence order (bundled → global → local),
// validates the merged result once, and finally overlays runtime state.
// ---------------------------------------------------------------------------

export type ConfigLayer = {
  kind: "bundled" | "global" | "local";
  path: string;
  required: boolean;
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThinkingConfig {
  budgetTokens?: number;
}

export interface ReasoningConfig {
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "always" | "never";
}

export interface TierConfig {
  model: string;
  variant?: string;
  thinking?: ThinkingConfig;
  reasoning?: ReasoningConfig;
  costRatio?: number;
  color?: string;
  description: string;
  steps?: number;
  prompt?: string;
  whenToUse: string[];
}

export type Preset = Record<string, TierConfig>;

export interface FallbackConfig {
  global?: Record<string, string[]>;
  presets?: Record<string, Record<string, string[]>>;
}

export interface ModeConfig {
  defaultTier: string;
  description: string;
  overrideRules?: string[];
}

export interface EnforcementConfig {
  mode?: "off" | "advisory" | "enforced";
  envGate?: string;
  perTier?: Record<string, "off" | "advisory" | "enforced">;
  guard?: { readDraftCap?: number; sameOpRetryCap?: number; blockSelfScript?: boolean; deliverableFirst?: boolean; budget?: number; blockScriptWrites?: boolean };
  verify?: { require?: "never" | "whenDoDPresent" | "always"; requireExplicitDoD?: boolean; preferDeterministic?: boolean; graderPolicy?: "atLeastProducerTier"; graderTemperature?: number; minGraderTier?: string };
  escalate?: { floorTier?: string | null; ladder?: string[]; maxAttemptsPerTier?: number; maxTotalAttempts?: number; costCeiling?: { base?: string; multiple?: number } };
  proportional?: { trivialBypass?: boolean; trivialClassifier?: string };
}

export interface RouterConfig {
  activePreset: string;
  activeMode?: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
  fallback?: FallbackConfig;
  taskPatterns?: Record<string, string[]>;
  modes?: Record<string, ModeConfig>;
  /** Global default prompts per tier name. A preset-level tier.prompt overrides this. */
  tierPrompts?: Record<string, string>;
  /** Read-only tool-call caps per tier, enforced at runtime via tool.execute.after banner injection. */
  tierCaps?: Record<string, number>;
  enforcement?: EnforcementConfig;
  /** Experimental, opt-in features. Off by default. */
  experimental?: { verifiedDelegateTool?: boolean };
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
}

// ---------------------------------------------------------------------------
// Config loader with caching
// ---------------------------------------------------------------------------

let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

/** Mark config cache as stale so it is re-read on next access. */
export function invalidateConfigCache(): void {
  _configDirty = true;
}

function getPluginRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Probe both layouts:
  // 1. Source layout: src/router/config.ts → ../../tiers.json (repo root)
  // 2. Bundled layout: dist/plugin.mjs → ../tiers.json (repo root)
  const sourceRoot = join(__dirname, "../..");
  const bundledRoot = join(__dirname, "..");
  if (existsSync(join(bundledRoot, "tiers.json"))) return bundledRoot;
  return sourceRoot;
}

export function configPath(): string {
  return join(getPluginRoot(), "tiers.json");
}

/** Global user-level override path (`~/.config/opencode-model-router/tiers.json`). */
export function globalConfigPath(): string {
  return join(homedir(), ".config", "opencode-model-router", "tiers.json");
}

/** Repo-local override path (`<cwd>/.opencode/tiers.json`). Re-evaluated per call. */
export function localConfigPath(): string {
  return join(process.cwd(), ".opencode", "tiers.json");
}

export function statePath(): string {
  return join(
    homedir(),
    ".config",
    "opencode",
    "opencode-model-router.state.json",
  );
}

/**
 * Read a single manual config layer from disk.
 * - Returns the parsed JSON object on success.
 * - Returns `undefined` ONLY when an optional layer is missing (ENOENT).
 * - Throws a path-prefixed error for any other read or parse failure, or when
 *   a required layer is missing.
 */
/**
 * Read a single manual config layer from disk.
 * - Returns the parsed JSON object on success.
 * - Returns `undefined` ONLY when an optional layer is missing (ENOENT).
 * - Throws a path-prefixed error for any other read or parse failure, or when
 *   a required layer is missing.
 *
 * Exported for `src/router/config-store.ts`; pure with respect to module state
 * (no shared mutable globals).
 */
export function readConfigLayer(layer: ConfigLayer): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(layer.path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (layer.required) {
        throw new Error(`bundled config missing at ${layer.path}`);
      }
      return undefined;
    }
    throw new Error(
      `${layer.kind} layer (${layer.path}) is unreadable: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${layer.kind} layer (${layer.path}) contains malformed JSON: ${(err as Error).message}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `${layer.kind} layer (${layer.path}) must be a JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }

  return parsed;
}

/**
 * Deep-merge two config-shaped values with these rules:
 * - `undefined` in either position returns the other.
 * - Both plain objects ⇒ recursive merge by key union.
 * - Arrays and scalars (including `null`) ⇒ override replaces base.
 * - `null` is NOT a plain object; it is treated as a scalar replacement.
 */
/**
 * Deep-merge two config-shaped values with these rules:
 * - `undefined` in either position returns the other.
 * - Both plain objects ⇒ recursive merge by key union.
 * - Arrays and scalars (including `null`) ⇒ override replaces base.
 * - `null` is NOT a plain object; it is treated as a scalar replacement.
 *
 * Exported for `src/router/config-store.ts`; pure.
 */
export function deepMergeConfig(base: unknown, override: unknown): unknown {
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
}

/**
 * Narrow state overlay. Writes ONLY:
 * - `state.activePreset` → `cfg.activePreset` when `resolvePresetName()` succeeds
 * - `state.activeMode`   → `cfg.activeMode` when the mode exists in `cfg.modes`
 * - `state.enforcementMode` → `cfg.enforcement.mode`, creating `cfg.enforcement` if missing
 * All other manual fields are preserved unchanged.
 */
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
export function applyStateOverlay(cfg: RouterConfig, state: RouterState): void {
  if (state.activePreset) {
    const resolved = resolvePresetName(cfg, state.activePreset);
    if (resolved) {
      cfg.activePreset = resolved;
    }
  }
  if (state.activeMode && cfg.modes?.[state.activeMode]) {
    cfg.activeMode = state.activeMode;
  }
  if (state.enforcementMode) {
    cfg.enforcement = { ...(cfg.enforcement ?? {}), mode: state.enforcementMode };
  }
}

export function resolvePresetName(
  cfg: RouterConfig,
  requestedPreset: string,
): string | undefined {
  if (cfg.presets[requestedPreset]) {
    return requestedPreset;
  }

  const normalized = requestedPreset.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return Object.keys(cfg.presets).find(
    (name) => name.toLowerCase() === normalized,
  );
}

export function validateConfig(raw: unknown): RouterConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tiers.json: expected a JSON object at root");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }
  if (
    typeof obj.presets !== "object" ||
    obj.presets === null ||
    Array.isArray(obj.presets)
  ) {
    throw new Error("tiers.json: 'presets' must be a non-null object");
  }

  const presets = obj.presets as Record<string, unknown>;
  for (const [presetName, preset] of Object.entries(presets)) {
    if (
      typeof preset !== "object" ||
      preset === null ||
      Array.isArray(preset)
    ) {
      throw new Error(`tiers.json: preset '${presetName}' must be an object`);
    }
    const tiers = preset as Record<string, unknown>;
    for (const [tierName, tier] of Object.entries(tiers)) {
      if (typeof tier !== "object" || tier === null) {
        throw new Error(
          `tiers.json: tier '${presetName}.${tierName}' must be an object`,
        );
      }
      const t = tier as Record<string, unknown>;
      if (typeof t.model !== "string" || !t.model) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`,
        );
      }
      if (typeof t.description !== "string") {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.description' must be a string`,
        );
      }
      if (!Array.isArray(t.whenToUse)) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`,
        );
      }
    }
  }

  if (!Array.isArray(obj.rules)) {
    throw new Error("tiers.json: 'rules' must be an array of strings");
  }
  if (typeof obj.defaultTier !== "string") {
    throw new Error("tiers.json: 'defaultTier' must be a string");
  }

  // Validate modes if present
  if (obj.modes !== undefined) {
    if (
      typeof obj.modes !== "object" ||
      obj.modes === null ||
      Array.isArray(obj.modes)
    ) {
      throw new Error("tiers.json: 'modes' must be an object");
    }
    const modes = obj.modes as Record<string, unknown>;
    for (const [modeName, mode] of Object.entries(modes)) {
      if (typeof mode !== "object" || mode === null) {
        throw new Error(`tiers.json: mode '${modeName}' must be an object`);
      }
      const m = mode as Record<string, unknown>;
      if (typeof m.defaultTier !== "string") {
        throw new Error(
          `tiers.json: mode '${modeName}.defaultTier' must be a string`,
        );
      }
      if (typeof m.description !== "string") {
        throw new Error(
          `tiers.json: mode '${modeName}.description' must be a string`,
        );
      }
    }
  }

  // Validate tierCaps if present
  if (obj.tierCaps !== undefined) {
    if (
      typeof obj.tierCaps !== "object" ||
      obj.tierCaps === null ||
      Array.isArray(obj.tierCaps)
    ) {
      throw new Error("tiers.json: 'tierCaps' must be an object");
    }
    const tc = obj.tierCaps as Record<string, unknown>;
    for (const [tierName, cap] of Object.entries(tc)) {
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
        throw new Error(
          `tiers.json: tierCaps.'${tierName}' must be a positive integer`,
        );
      }
    }
  }

  // Validate tierPrompts if present
  if (obj.tierPrompts !== undefined) {
    if (
      typeof obj.tierPrompts !== "object" ||
      obj.tierPrompts === null ||
      Array.isArray(obj.tierPrompts)
    ) {
      throw new Error("tiers.json: 'tierPrompts' must be an object");
    }
    const tp = obj.tierPrompts as Record<string, unknown>;
    for (const [tierName, prompt] of Object.entries(tp)) {
      if (typeof prompt !== "string") {
        throw new Error(
          `tiers.json: tierPrompts.'${tierName}' must be a string`,
        );
      }
    }
  }

  // Validate taskPatterns if present
  if (obj.taskPatterns !== undefined) {
    if (
      typeof obj.taskPatterns !== "object" ||
      obj.taskPatterns === null ||
      Array.isArray(obj.taskPatterns)
    ) {
      throw new Error("tiers.json: 'taskPatterns' must be an object");
    }
    const tp = obj.taskPatterns as Record<string, unknown>;
    for (const [tierName, patterns] of Object.entries(tp)) {
      if (!Array.isArray(patterns)) {
        throw new Error(
          `tiers.json: taskPatterns.'${tierName}' must be an array of strings`,
        );
      }
    }
  }

  // Validate enforcement if present (optional — absent means no enforcement)
  if (obj.enforcement !== undefined) {
    if (
      typeof obj.enforcement !== "object" ||
      obj.enforcement === null ||
      Array.isArray(obj.enforcement)
    ) {
      throw new Error("tiers.json: enforcement must be an object");
    }
    const enforcement = obj.enforcement as Record<string, unknown>;
    if (enforcement.mode !== undefined) {
      if (!["off", "advisory", "enforced"].includes(enforcement.mode as string)) {
        throw new Error(
          "tiers.json: enforcement.mode must be one of off|advisory|enforced",
        );
      }
    }
    if (
      enforcement.verify !== undefined &&
      typeof enforcement.verify === "object" &&
      enforcement.verify !== null
    ) {
      const verify = enforcement.verify as Record<string, unknown>;
      if (
        verify.graderPolicy !== undefined &&
        verify.graderPolicy !== "atLeastProducerTier"
      ) {
        throw new Error(
          'tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"',
        );
      }
    }
    if (
      enforcement.escalate !== undefined &&
      typeof enforcement.escalate === "object" &&
      enforcement.escalate !== null
    ) {
      const escalate = enforcement.escalate as Record<string, unknown>;
      if (
        escalate.costCeiling !== undefined &&
        typeof escalate.costCeiling === "object" &&
        escalate.costCeiling !== null
      ) {
        const costCeiling = escalate.costCeiling as Record<string, unknown>;
        if (costCeiling.multiple !== undefined) {
          if (
            typeof costCeiling.multiple !== "number" ||
            costCeiling.multiple <= 0
          ) {
            throw new Error(
              "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
            );
          }
        }
      }
      if (escalate.ladder !== undefined) {
        if (
          !Array.isArray(escalate.ladder) ||
          !escalate.ladder.every((s: unknown) => typeof s === "string")
        ) {
          throw new Error(
            "tiers.json: enforcement.escalate.ladder must be an array of strings",
          );
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
          throw new Error(
            "tiers.json: enforcement.escalate.maxTotalAttempts must be an integer >= 1",
          );
        }
      }
      if (
        escalate.floorTier !== undefined &&
        escalate.floorTier !== null &&
        typeof escalate.floorTier !== "string"
      ) {
        throw new Error(
          "tiers.json: enforcement.escalate.floorTier must be a string or null",
        );
      }
    }
    if (
      enforcement.perTier !== undefined &&
      typeof enforcement.perTier === "object" &&
      enforcement.perTier !== null &&
      !Array.isArray(enforcement.perTier)
    ) {
      const perTier = enforcement.perTier as Record<string, unknown>;
      for (const [tierName, tierMode] of Object.entries(perTier)) {
        if (!["off", "advisory", "enforced"].includes(tierMode as string)) {
          throw new Error(
            `tiers.json: enforcement.perTier.${tierName} must be one of off|advisory|enforced`,
          );
        }
      }
    }
    if (
      enforcement.guard !== undefined &&
      typeof enforcement.guard === "object" &&
      enforcement.guard !== null
    ) {
      const guard = enforcement.guard as Record<string, unknown>;
      if (guard.budget !== undefined) {
        if (
          typeof guard.budget !== "number" ||
          !Number.isFinite(guard.budget) ||
          guard.budget < 1
        ) {
          throw new Error("enforcement.guard.budget must be a number >= 1");
        }
      }
      if (guard.blockScriptWrites !== undefined) {
        if (typeof guard.blockScriptWrites !== "boolean") {
          throw new Error("enforcement.guard.blockScriptWrites must be a boolean");
        }
      }
    }
  }

  return raw as RouterConfig;
}

/**
 * Legacy module-level config cache. Kept during PR1 for existing callers
 * (router-config.test.ts, layer2-wiring.test.ts, saveActive* helpers,
 * etc.); the plugin runtime no longer uses it — `createPluginContext()`
 * creates its own per-instance `ConfigStore` via
 * `src/router/config-store.ts`. Removal is planned for a later slice once
 * every call site migrates to `ctx.getConfig()` / `ctx.refreshConfig()`.
 */
export function loadConfig(): RouterConfig {
  if (_cachedConfig && !_configDirty) {
    return _cachedConfig;
  }

  // `loadConfig()` pipeline (highest → lowest precedence):
  //   state  >  local  >  global  >  bundled
  //
  // 1. Read three MANUAL layers (bundled required; global/local optional,
  //    absent only on ENOENT). Deep-merge in precedence order — plain
  //    objects merge by key, arrays/scalars/explicit null REPLACE the
  //    lower value (not delete).
  // 2. Validate the merged manual result exactly once with `validateConfig()`.
  // 3. RUNTIME STATE overlays only `activePreset`, `activeMode`, and
  //    `enforcement.mode`. Runtime state never mutates `tiers.json`.
  //
  // `_configDirty` is the cache invalidation signal; callers that change
  // `process.cwd()` or a layer file must call `invalidateConfigCache()`.
  const layers: ConfigLayer[] = [
    { kind: "bundled", path: configPath(), required: true },
    { kind: "global", path: globalConfigPath(), required: false },
    { kind: "local", path: localConfigPath(), required: false },
  ];

  const bundled = readConfigLayer(layers[0]!);
  const global = readConfigLayer(layers[1]!);
  const local = readConfigLayer(layers[2]!);

  const mergedManual = deepMergeConfig(
    deepMergeConfig(bundled, global),
    local,
  );
  const cfg = validateConfig(mergedManual);

  // Runtime state is best-effort and overlays only its owned fields.
  const state = readState();
  applyStateOverlay(cfg, state);

  _cachedConfig = cfg;
  _configDirty = false;
  return cfg;
}

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

/** Read current persisted state (or empty object on failure). */
export function readState(): RouterState {
  try {
    if (existsSync(statePath())) {
      return JSON.parse(readFileSync(statePath(), "utf-8")) as RouterState;
    }
  } catch {
    // ignore
  }
  return {};
}

/** Write state to disk atomically (merges with existing keys). */
export function writeState(patch: Partial<RouterState>): void {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// State save helpers — write user-selected state and invalidate config cache
// ---------------------------------------------------------------------------

export function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }

  cfg.activePreset = resolved;

  // Persist user-selected preset to state file only — never mutate tiers.json
  writeState({ activePreset: resolved });

  // Invalidate cache so next read picks up the new active preset
  invalidateConfigCache();
}

export function saveActiveMode(modeName: string): void {
  const cfg = loadConfig();
  if (!cfg.modes?.[modeName]) {
    return;
  }

  cfg.activeMode = modeName;
  writeState({ activeMode: modeName });
  invalidateConfigCache();
}

export function saveEnforcementMode(mode: "off" | "advisory" | "enforced"): void {
  writeState({ enforcementMode: mode });
  invalidateConfigCache();
}

// ---------------------------------------------------------------------------
// Enforcement helpers
// ---------------------------------------------------------------------------

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"advisory". */
export function normalizeEnforcement(
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } {
  return { mode: e?.mode ?? "advisory" };
}
