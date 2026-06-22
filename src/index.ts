import type { Plugin, PluginInput } from "@opencode-ai/plugin";

import { createPluginContext } from "./plugin/context";
import { assembleRuntimeHooks } from "./plugin/runtime";

// ---------------------------------------------------------------------------
// Re-exports — type-only re-exports for IDE/test consumers.
// NOTE: value re-exports are intentionally absent. opencode's plugin loader
// calls every function export as a factory (Ck iterates Object.values(mod));
// adding named function exports would cause spurious factory calls.
// Tests import from their specific source files instead of this entry point.
// ---------------------------------------------------------------------------

export type {
  RouterConfig,
  TierConfig,
  Preset,
  ModeConfig,
  FallbackConfig,
  EnforcementConfig,
} from "./router/config";
export type { Cap, SubagentState } from "./router/sessions";
export type { TrajectoryState, TrajectoryToolEvent } from "./telemetry/trajectory";
export type { EnforcementMode } from "./router/enforcement";
export type { GuardPolicy, GuardState, GuardCall, GuardDecision } from "./guard/guards";

// ---------------------------------------------------------------------------
// Plugin factory — composition root.
//
// Builds the per-instance PluginContext and delegates hook assembly to
// `src/plugin/runtime.ts`. All hook bodies, the delegate tool, and the
// command dispatcher live in their own modules; this file only wires
// the runtime and the delegate-tool gate.
// ---------------------------------------------------------------------------

const ModelRouterPlugin: Plugin = async (plugin: PluginInput) => {
  // Single source of truth for per-plugin runtime state: stores, seams,
  // mutex, bypass flag, config cache, and grader-session tracking. Hooks
  // read/write ctx.* instead of closing over plugin-scoped locals.
  const ctx = createPluginContext(plugin);

  const enableDelegateTool =
    ctx.initialConfig.experimental?.verifiedDelegateTool === true ||
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE === "1";

  return assembleRuntimeHooks(ctx, ctx.activeTiersAtLoad, enableDelegateTool);
};

export default ModelRouterPlugin;
