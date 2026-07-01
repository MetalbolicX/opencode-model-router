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
//
// PR2 task 2.8: the prior `(input: any, output: any)` callbacks and the
// `as unknown as Parameters<typeof handler>[N]` chain have been replaced
// with typed wrappers. Each wrapper accepts the SDK's exact hook input/
// output shape (`ChatParamsInput`, `ToolExecuteInput`, etc.) and forwards
// the values to the handler with one narrow `as Record<string, unknown>`
// at the boundary. No `as unknown as` remains in this file.
// ---------------------------------------------------------------------------

import { type Hooks, type ToolContext, tool } from "@opencode-ai/plugin";

import { handleCommandBefore } from "../router/commands";
import type { Preset } from "../router/config";
import { log, logEvent } from "../utils/observability";
import type { PluginContext } from "./context";
import { executeDelegate } from "./delegate";
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
import type { DelegateArgs, HookEventPayload, HookPayload } from "./types";

const DELEGATE_DESCRIPTION =
  "Delegate a task to a tier subagent (fast | medium | heavy). The subagent's result is INDEPENDENTLY VERIFIED (deterministic checks, or an independent grader at >= the producer tier in a fresh session) before it is returned. Returns an accepted result on PASS, or an honest 'unmet' status on FAIL — never a self-reported completion. Optionally pass an [acceptance]...[/acceptance] block to define the Definition of Done.";

// ---------------------------------------------------------------------------
// Typed hook wrapper lambdas.
//
// Each wrapper has the SDK's narrow hook signature so the compiler can
// verify the adapter's parameter types against the `Hooks` interface. The
// handler bodies continue to use `HookPayload` (loose shape); the wrapper
// performs a single typed assertion `as Record<string, unknown>` at the
// boundary, which is the only cast in the module.
// ---------------------------------------------------------------------------

type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ChatParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];
type ChatMessageInput = Parameters<NonNullable<Hooks["chat.message"]>>[0];
type ChatMessageOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];
type ToolExecuteBeforeInput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[0];
type ToolExecuteBeforeOutput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[1];
type ToolExecuteAfterInput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[0];
type ToolExecuteAfterOutput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[1];
type TextCompleteInput = Parameters<NonNullable<Hooks["experimental.text.complete"]>>[0];
type TextCompleteOutput = Parameters<NonNullable<Hooks["experimental.text.complete"]>>[1];
type EventInput = Parameters<NonNullable<Hooks["event"]>>[0];
type ConfigInput = Parameters<NonNullable<Hooks["config"]>>[0];
type SystemTransformInput = Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0];
type SystemTransformOutput = Parameters<
  NonNullable<Hooks["experimental.chat.system.transform"]>
>[1];
type CommandExecuteBeforeInput = Parameters<NonNullable<Hooks["command.execute.before"]>>[0];
type CommandExecuteBeforeOutput = Parameters<NonNullable<Hooks["command.execute.before"]>>[1];

const toHookPayload = <T extends object>(v: T): HookPayload => v as Record<string, unknown>;
const toEventPayload = (v: object): HookEventPayload =>
  v as { event?: { type?: string; properties?: unknown } };

/**
 * Build the hook record for one plugin instance. `enableDelegateTool`
 * preserves the pre-refactor gating: the delegate tool only ships when
 * the experimental config flag is set OR `MODEL_ROUTER_VERIFIED_DELEGATE=1`.
 */
export const assembleRuntimeHooks = (
  ctx: PluginContext,
  activeTiersAtLoad: Preset,
  enableDelegateTool: boolean,
): Hooks => {
  return {
    tool: {
      ...(enableDelegateTool
        ? {
            delegate: tool({
              description: DELEGATE_DESCRIPTION,
              args: {
                task: tool.schema.string().describe("The task for the subagent to perform."),
                tier: tool.schema
                  .string()
                  .optional()
                  .describe("fast | medium | heavy. Defaults to the router default tier."),
                acceptance: tool.schema
                  .string()
                  .optional()
                  .describe(
                    "Optional [acceptance]...[/acceptance] block defining the Definition of Done (check: / criteria: / deliverable: directives).",
                  ),
              },
              async execute(args: DelegateArgs, context: ToolContext): Promise<string> {
                return executeDelegate(ctx, args, context.sessionID, context.abort);
              },
            }),
          }
        : {}),
    },

    "chat.params": (input: ChatParamsInput, output: ChatParamsOutput) =>
      handleChatParams(ctx, toHookPayload(input), toHookPayload(output)),

    "chat.message": (input: ChatMessageInput, output: ChatMessageOutput) =>
      handleChatMessage(ctx, toHookPayload(input), toHookPayload(output)),

    "tool.execute.before": (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) =>
      handleToolExecuteBefore(ctx, toHookPayload(input), toHookPayload(output)),

    "tool.execute.after": (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput) =>
      handleToolExecuteAfter(ctx, toHookPayload(input), toHookPayload(output)),

    "experimental.text.complete": (input: TextCompleteInput, output: TextCompleteOutput) =>
      handleTextComplete(ctx, toHookPayload(input), toHookPayload(output)),

    event: (payload: EventInput) => handleSessionIdle(ctx, toEventPayload(payload)),

    config: (opencodeConfig: ConfigInput) => handleConfig(ctx, activeTiersAtLoad, opencodeConfig),

    "experimental.chat.system.transform": (
      input: SystemTransformInput,
      output: SystemTransformOutput,
    ) => handleSystemTransform(ctx, toHookPayload(input), toHookPayload(output)),

    "command.execute.before": (
      input: CommandExecuteBeforeInput,
      output: CommandExecuteBeforeOutput,
    ) =>
      handleCommandBefore(
        ctx,
        {
          command: input.command,
          arguments: input.arguments ?? "",
          sessionID: input.sessionID,
        },
        output,
      ),

    // PR5: graceful shutdown hook. opencode's plugin SDK exposes a
    // `Hooks.dispose` callback that fires when the plugin is unloaded
    // (graceful shutdown, hot-reload, or opencode exit). We delegate to
    // `ctx.dispose()` which is idempotent and never throws; any errors
    // are surfaced as a structured error-level lifecycle event so
    // operators can see the unload path without parsing the trajectory
    // dir.
    async dispose(): Promise<void> {
      const startedAt = Date.now();
      logEvent.lifecycle.shutdown({ phase: "starting" });
      try {
        await ctx.dispose();
        logEvent.lifecycle.shutdown({ phase: "complete", durationMs: Date.now() - startedAt });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Error-level: surface the unload failure so it lands on stderr
        // and is grep-able separately from successful shutdowns.
        log.error({
          event: "lifecycle.shutdown",
          phase: "error",
          error: reason,
          durationMs: Date.now() - startedAt,
        });
      }
    },
  };
};
