// ---------------------------------------------------------------------------
// src/router/config.types.ts — Type definitions and type guards.
//
// Pure types and small predicates. No file IO, no module-level state.
// ---------------------------------------------------------------------------

// Re-export the canonical reasoning types from `src/reasoning/capability.ts`.
// `capability.ts` is the canonical home (single source of truth for the
// capability model + inference); `config.types.ts` re-exports so existing
// `import { ReasoningCapability } from "./config"` style keeps working
// without forcing every consumer to learn the new module path.
export type {
  ReasoningCapability,
  ReasoningField,
  ReasoningLevel,
} from "../reasoning/capability.js";

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
  /**
   * Optional explicit capability declaration for this tier. When present,
   * `resolveReasoningOverride` (PR 2 of adaptive-reasoning) consults this
   * before falling back to `inferCapability(tier)`. Leaving it absent keeps
   * pre-Plan-010 configs working unchanged.
   */
  capability?: import("../reasoning/capability.js").ReasoningCapability;
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
  guard?: {
    readDraftCap?: number;
    sameOpRetryCap?: number;
    blockSelfScript?: boolean;
    deliverableFirst?: boolean;
    budget?: number;
    blockScriptWrites?: boolean;
  };
  verify?: {
    require?: "never" | "whenDoDPresent" | "always";
    requireExplicitDoD?: boolean;
    preferDeterministic?: boolean;
    graderPolicy?: "atLeastProducerTier";
    graderTemperature?: number;
    minGraderTier?: string;
  };
  escalate?: {
    floorTier?: string | null;
    ladder?: string[];
    maxAttemptsPerTier?: number;
    maxTotalAttempts?: number;
    costCeiling?: { base?: string; multiple?: number };
  };
  proportional?: { trivialBypass?: boolean; trivialClassifier?: string };
}

/**
 * Reasoning policy mode and per-session override knobs (PR 2 of
 * adaptive-reasoning).
 *
 * - `mode` defaults to `"static"` (today's behaviour preserved).
 * - `defaultLevel` is the level applied under `manual` mode when the session
 *   has no per-session override. Defaults to undefined (no implicit level).
 * - `surfaceLimits` defaults to `false` — unsupported-level requests stay
 *   silent. Set to `true` to emit a debug log + `/reasoning` advisory note
 *   when a tier's capability cannot satisfy the requested level.
 */
export interface ReasoningPolicyConfig {
  mode?: "static" | "manual" | "adaptive";
  defaultLevel?: import("../reasoning/capability.js").ReasoningLevel;
  surfaceLimits?: boolean;
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
  /** PR 2 of adaptive-reasoning: per-tier override + runtime patch wiring.
   *  All fields optional → pre-change configs work unedited. */
  reasoningPolicy?: ReasoningPolicyConfig;
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
  /**
   * Persisted reasoning policy mode overlay. Set via
   * `saveReasoningMode()` and applied by `applyStateOverlay()` over
   * `cfg.reasoningPolicy.mode`. `adaptive` is intentionally absent from
   * the persisted overlay — it is not implemented yet and the command
   * surface rejects it explicitly.
   */
  reasoningMode?: "static" | "manual";
}

export type ConfigLayer = {
  kind: "bundled" | "global" | "local";
  path: string;
  required: boolean;
};

export const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  return typeof v === "object" && v !== null && !Array.isArray(v);
};
