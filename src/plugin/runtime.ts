// ---------------------------------------------------------------------------
// src/plugin/runtime.ts — Hook assembly for the plugin runtime.
//
// Builds the opencode hook record from the handler adapters in
// `./hooks.ts`, the delegate tool from `./delegate.ts`, and the command
// dispatcher from `../router/commands`. Each handler is wired with the
// live `PluginContext` and, where the original closure captured them,
// the load-time `activeTiersAtLoad` snapshot.
//
// This module owns no state — it is a pure factory that returns a fresh
// hooks object for each plugin instance.
// ---------------------------------------------------------------------------

import { tool } from "@opencode-ai/plugin";

import { handleCommandBefore } from "../router/commands";
import type { Preset } from "../router/config";
import { executeDelegate, type DelegateArgs } from "./delegate";
import {
  handleChatMessage,
  handleChatParams,
  handleConfig,
  handleSessionIdle,
  handleSystemTransform,
  handleTextComplete,
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from "./hooks";
import type { PluginContext } from "./context";

const DELEGATE_DESCRIPTION =
  "Delegate a task to a tier subagent (fast | medium | heavy). The subagent's result is INDEPENDENTLY VERIFIED (deterministic checks, or an independent grader at >= the producer tier in a fresh session) before it is returned. Returns an accepted result on PASS, or an honest 'unmet' status on FAIL — never a self-reported completion. Optionally pass an [acceptance]...[/acceptance] block to define the Definition of Done.";

/**
 * Build the hook record for one plugin instance. `enableDelegateTool`
 * preserves the pre-refactor gating: the delegate tool only ships when
 * the experimental config flag is set OR `MODEL_ROUTER_VERIFIED_DELEGATE=1`.
 */
export function assembleRuntimeHooks(
  ctx: PluginContext,
  activeTiersAtLoad: Preset,
  enableDelegateTool: boolean,
) {
  return {
    tool: {
      ...(enableDelegateTool
        ? {
            delegate: tool({
              description: DELEGATE_DESCRIPTION,
              args: {
                task: tool.schema
                  .string()
                  .describe("The task for the subagent to perform."),
                tier: tool.schema
                  .string()
                  .optional()
                  .describe(
                    "fast | medium | heavy. Defaults to the router default tier.",
                  ),
                acceptance: tool.schema
                  .string()
                  .optional()
                  .describe(
                    "Optional [acceptance]...[/acceptance] block defining the Definition of Done (check: / criteria: / deliverable: directives).",
                  ),
              },
              async execute(args: DelegateArgs): Promise<string> {
                return executeDelegate(ctx, args);
              },
            }),
          }
        : {}),
    },

    "chat.params": (input: any, output: any) =>
      handleChatParams(ctx, input, output),

    "chat.message": (input: any, output: any) =>
      handleChatMessage(ctx, input, output),

    "tool.execute.before": (input: any, output: any) =>
      handleToolExecuteBefore(ctx, input, output),

    "tool.execute.after": (input: any, output: any) =>
      handleToolExecuteAfter(ctx, input, output),

    "experimental.text.complete": (input: any, output: any) =>
      handleTextComplete(ctx, input, output),

    event: (payload: any) => handleSessionIdle(ctx, payload),

    config: (opencodeConfig: any) =>
      handleConfig(ctx, activeTiersAtLoad, opencodeConfig),

    "experimental.chat.system.transform": (input: any, output: any) =>
      handleSystemTransform(ctx, input, output),

    "command.execute.before": (input: any, output: any) =>
      handleCommandBefore(ctx, input, output),
  };
}
