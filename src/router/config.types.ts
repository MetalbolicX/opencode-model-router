// ---------------------------------------------------------------------------
// src/router/config.types.ts — Type definitions and type guards.
//
// Pure types and small predicates. No file IO, no module-level state.
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

export type ConfigLayer = {
  kind: "bundled" | "global" | "local";
  path: string;
  required: boolean;
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
