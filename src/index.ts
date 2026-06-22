import type { Plugin, PluginInput } from "@opencode-ai/plugin";

// Imports for internal use within this module
import { detectNarration } from "./guard/narration";
import {
  getActiveTiers,
  assembleSystemPrompt,
} from "./router/protocol";
import { resolveEnforcementMode } from "./router/enforcement";
import {
  READ_ONLY_TOOLS,
} from "./router/sessions";
import type { Cap, SubagentState } from "./router/sessions";
import { guardBeforeCall, guardAfterCall, formatScorecard } from "./guard/enforce";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { scrubText } from "./guard/scrub";
import { accept } from "./verify/gate";
import {
  buildDelegationDoD,
  tierModel,
  buildForcingNote,
  buildAcceptedSuffix,
  buildGateDeps,
  verifyTaskAfterHook,
} from "./verify/dispatch";
import {
  newLadderState,
  recordAttempt,
  nextAction,
  advance,
  buildEscalatePolicy,
  dumpDelegateScorecard,
} from "./escalate/ladder";
import {
  registerRouterCommands,
  handleCommandBefore,
} from "./router/commands";
import { registerTierAgents } from "./router/agents";
import { createPluginContext } from "./plugin/context";
import type { PluginContext } from "./plugin/context";

// ---------------------------------------------------------------------------
// Re-exports — type-only re-exports for IDE/test consumers.
// NOTE: value re-exports are intentionally absent. opencode's plugin loader
// calls every function export as a factory (Ck iterates Object.values(mod));
// adding named function exports would cause spurious factory calls.
// Tests import from their specific source files instead of this entry point.
// ---------------------------------------------------------------------------

export type { RouterConfig, TierConfig, Preset, ModeConfig, FallbackConfig, EnforcementConfig } from "./router/config";
export type { Cap, SubagentState };
export type { TrajectoryState, TrajectoryToolEvent } from "./telemetry/trajectory";
export type { EnforcementMode } from "./router/enforcement";
export type { GuardPolicy, GuardState, GuardCall, GuardDecision } from "./guard/guards";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const ModelRouterPlugin: Plugin = async (plugin: PluginInput) => {
  // Single source of truth for per-plugin runtime state: stores, seams,
  // mutex, bypass flag, config cache, and grader-session tracking. Hooks
  // read/write ctx.* instead of closing over plugin-scoped locals.
  const ctx: PluginContext = createPluginContext(plugin);
  const {
    sessionStore,
    trajectoryStore,
    guardStore,
    changedFileStore,
    graderSessions,
  } = ctx;
  const activeTiers = ctx.activeTiersAtLoad;

  // Slice 3: `dispatchGrader`, `buildGateDeps`, and `dumpDelegateScorecard`
  // now live in src/verify/dispatch.ts and src/escalate/ladder.ts; the
  // delegate loop below calls them with the live PluginContext.

  // Bypass mode: when true, the router skips all system prompt injection,
  // subagent tracking, cap enforcement, and narration detection for the
  // current plugin lifetime (i.e., until OpenCode is restarted). The flag
  // lives on the context so hook adapters can read/write it through ctx.state.
  // (Initial value is set by createPluginContext.)

  const enableDelegateTool =
    ctx.initialConfig.experimental?.verifiedDelegateTool === true ||
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE === "1";

  return {
    tool: {
      ...(enableDelegateTool ? { delegate: tool({
        description:
          "Delegate a task to a tier subagent (fast | medium | heavy). The subagent's result is INDEPENDENTLY VERIFIED (deterministic checks, or an independent grader at >= the producer tier in a fresh session) before it is returned. Returns an accepted result on PASS, or an honest 'unmet' status on FAIL — never a self-reported completion. Optionally pass an [acceptance]...[/acceptance] block to define the Definition of Done.",
        args: {
          task: tool.schema
            .string()
            .describe("The task for the subagent to perform."),
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
        async execute(args: {
          task: string;
          tier?: string;
          acceptance?: string;
        }): Promise<string> {
          try {
            let activeCfg = ctx.getConfig();
            try {
              activeCfg = ctx.refreshConfig();
            } catch {
              activeCfg = ctx.getConfig();
            }
            const initialTier =
              typeof args.tier === "string" && args.tier.trim()
                ? args.tier.trim()
                : activeCfg.defaultTier || "medium";
            const dod = buildDelegationDoD({
              prompt: args.task,
              acceptance: args.acceptance,
            });

            const policy = buildEscalatePolicy(activeCfg);
            let state = newLadderState(initialTier, policy);
            const tiersForCost: any = getActiveTiers(activeCfg);

            // Independent safety net: even a policy bug cannot loop unbounded.
            const safetyMax =
              Math.max(
                policy.maxTotalAttempts,
                policy.ladder.length * (policy.maxAttemptsPerTier + 1),
              ) + 2;
            let safety = 0;

            let producerText = "";
            let forcing: string | null = null;

            while (true) {
              if (safety++ > safetyMax) {
                return (
                  `[router status: unmet] delegation stopped by the safety net after ` +
                  `${state.totalAttempts} attempt(s).\n\n${scrubText(producerText)}`
                );
              }
              const tier = state.currentTier;
              const taskText = forcing
                ? `${scrubText(forcing)}\n\n${args.task}`
                : args.task;

              const created: any = await ctx.plugin.client.session.create({});
              const producerSid: string | undefined = created?.data?.id;
              if (!producerSid) {
                return "[router] delegate failed: could not create a producer session.";
              }
              // Compose with Layer 1: guard the plugin-created producer session.
              try {
                sessionStore.registerProducerSession(producerSid, tier, activeCfg);
              } catch {
                // non-fatal
              }

              const model = tierModel(activeCfg, tier) ?? undefined;
              producerText = "";
              // Provider-failover vs quality-escalation precedence (Phase 3.3):
              // Provider-failover is advisory only — a text chain injected into the orchestrator
              // system prompt (buildFallbackInstructions). It is orthogonal to this runtime ladder.
              // A transport/API error here is caught, yields an empty artefact, and is treated as
              // exactly ONE failed attempt by the quality-escalation ladder (no provider swap, no
              // double-counted attempt). API error => (advisory) provider failover; verification
              // FAIL => (runtime) quality escalation.
              try {
                const res: any = await ctx.plugin.client.session.prompt({
                  path: { id: producerSid },
                  body: {
                    ...(model ? { model } : {}),
                    ...(tier ? { agent: tier } : {}),
                    parts: [{ type: "text", text: taskText }],
                  },
                });
                const parts: any[] = res?.data?.parts ?? [];
                producerText = parts
                  .filter((p) => p?.type === "text" && typeof p.text === "string")
                  .map((p) => p.text)
                  .join("\n");
              } catch {
                producerText = "";
              }

              const artefact = {
                changedFiles: changedFileStore.get(producerSid),
                finalReturnText: producerText,
                declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
                producerSessionID: producerSid,
                producerTier: tier,
              };

              let gateRes;
              try {
                gateRes = await accept(
                  { dod, trivial: false, mode: "modeA" },
                  artefact,
                  buildGateDeps(ctx),
                );
              } catch {
                gateRes = {
                  accepted: false,
                  verdict: {
                    pass: false,
                    method: "none" as const,
                    reasons: ["verification failed (fail-closed)"],
                  },
                  dodSource: dod.source,
                };
              }

              // Per-attempt cleanup (drop producer session tracking + state).
              changedFileStore.clear(producerSid);
              try {
                sessionStore.unregister(producerSid);
              } catch {
                // non-fatal
              }
              try {
                guardStore.clear(producerSid);
              } catch {
                // non-fatal
              }

              const costRatio =
                typeof tiersForCost?.[tier]?.costRatio === "number"
                  ? tiersForCost[tier].costRatio
                  : 1;
              state = recordAttempt(state, costRatio);

              const action = nextAction(
                state,
                { pass: gateRes.accepted, reasons: gateRes.verdict.reasons },
                policy,
              );

              if (action.action === "accept") {
                dumpDelegateScorecard(
                  producerSid,
                  state,
                  true,
                  gateRes.verdict.method,
                );
                return producerText + buildAcceptedSuffix(gateRes.verdict.method);
              }
              if (action.action === "give_up") {
                dumpDelegateScorecard(
                  producerSid,
                  state,
                  false,
                  gateRes.verdict.method,
                );
                const note = scrubText(buildForcingNote(gateRes.verdict.reasons));
                return (
                  `[router status: unmet] The delegated result was not accepted after ` +
                  `${state.totalAttempts} attempt(s) across ${state.escalations} escalation(s) ` +
                  `(final tier ${state.currentTier}; ${action.reason ?? "verification failed"}).\n\n` +
                  `${scrubText(producerText)}\n\n${note}`
                );
              }
              // retry or escalate
              forcing = action.forcingMessage ?? null;
              state = advance(state, action);
            }
          } catch {
            return "[router] delegate failed (fail-closed): the delegation or verification could not complete.";
          }
        },
      }) } : {}),
    },

    // -----------------------------------------------------------------------
    // Detect subagent calls via chat.message. When the agent name matches a
    // registered tier, record the sessionID so system.transform can skip
    // delegation-protocol injection.
    //
    // IMPORTANT: must be chat.message, NOT chat.params. The opencode hook
    // order is chat.message -> system.transform -> chat.params, so populating
    // the Set in chat.params is always one step too late — system.transform
    // already ran with an empty Set and leaked the "Delegate with Task(...)"
    // instructions into the subagent's system prompt. Sonnet subagents like
    // @explore silently ignore that noise, but literal-minded Haiku (@fast)
    // emits malformed XML tool calls for the nonexistent Task tool, which
    // surface in the UI as "<parameter>...</parameter>" leakage.
    //
    // chat.message fires inside SessionPrompt.createUserMessage() BEFORE the
    // loop -> LLM.stream path, so by the time system.transform runs the Set
    // is fully populated and await-safe (yield* on the plugin trigger).
    // -----------------------------------------------------------------------
    "chat.params": async (input: any, output: any) => {
      try {
        if (input?.sessionID && graderSessions.has(input.sessionID)) {
          output.temperature = ctx.getConfig().enforcement?.verify?.graderTemperature ?? 0;
        }
      } catch {
        // best-effort: never crash a real session
      }
    },

    "chat.message": async (input: any, output: any) => {
      if (ctx.state.bypassed) return;
      // Re-read cfg so /preset switches take effect without restart
      let cfg = ctx.getConfig();
      try {
        cfg = ctx.refreshConfig();
      } catch {
        // keep last known cfg if file read fails
      }
      const tierNames = Object.keys(getActiveTiers(cfg));
      sessionStore.registerFromChatMessage(input, output, cfg, tierNames);

      // Record-only: initialise a trajectory scorecard for tracked subagents.
      const sid = input?.sessionID;
      if (sid && sessionStore.isSubagent(sid)) {
        trajectoryStore.ensure(sid, input?.agent ?? null);
      }
    },

    // -----------------------------------------------------------------------
    // Hard-block enforcement (Layer 1). Fires before tool execution; only
    // engaged for subagent sessions when enforcement mode is advisory/enforced.
    // Throws to abort the tool call when a guard fires; never throws for
    // non-subagent sessions or when enforcement is off (GA-1 preserved).
    // -----------------------------------------------------------------------
    "tool.execute.before": async (input: any, output: any) => {
      if (ctx.state.bypassed) return;
      const sid = input?.sessionID;
      if (!sid || !sessionStore.isSubagent(sid) || typeof input?.tool !== "string") {
        return;
      }
      let res;
      try {
        res = guardBeforeCall({
          cfg: ctx.getConfig(),
          tier: sessionStore.getTier(sid),
          trivial: sessionStore.isTrivial(sid),
          sessionID: sid,
          tool: input.tool,
          toolArgs: output?.args,
          store: guardStore,
          env: process.env,
        });
      } catch {
        return; // never break a real session on a guard-internal error
      }
      if (res.block) {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
          blocked: true,
          selfScript: res.guard === "anti_self_script",
        });
        throw new Error(res.message);
      }
    },

    // -----------------------------------------------------------------------
    // Runtime cap + redundancy enforcement (subagents only).
    // Appends `[cap: N/MAX]` and `[⚠ REDUNDANT]` / `[⚠ CAP REACHED]` banners
    // to every read-only tool result the subagent sees. Because these land
    // inside `output.output` — the tool's own response text — the model
    // treats them as ground truth rather than advisory system noise.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input: any, output: any) => {
      if (ctx.state.bypassed) return;
      sessionStore.recordToolCall(input, output);

      // Record-only trajectory observation (mutates internal maps only; never
      // touches output, so emitted banners/observations stay byte-identical).
      const sid = input?.sessionID;

      // Attribute changed files to whichever session made the edit (any session).
      if (sid && typeof input?.tool === "string") {
        changedFileStore.record(sid, input.tool, input?.args);
      }

      if (sid && sessionStore.isSubagent(sid) && typeof input?.tool === "string") {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
        });
        try {
          guardAfterCall({
            cfg: ctx.getConfig(),
            tier: sessionStore.getTier(sid),
            sessionID: sid,
            tool: input.tool,
            toolArgs: input?.args,
            output,
            store: guardStore,
          });
        } catch {
          // best-effort: enforcement must never crash a real session
        }
      }

      // Option (i): verify-dispatch around the built-in `task` tool (advisory-grade —
      // we observe the finished task result and append a forcing note if it is not
      // accepted; we cannot retry a task call that already finished).
      await verifyTaskAfterHook(ctx, input, output);
    },

    // -----------------------------------------------------------------------
    // Narration detector — flags progress-commentary-without-production.
    //
    // Fires per completed text part. Scans for narration patterns; if any
    // match, logs a warning to the plugin console and appends a visible
    // banner to the text so the user sees the detection in the UI. This is
    // telemetry, not blocking — we cannot modify mid-stream generation, only
    // post-hoc signal.
    // -----------------------------------------------------------------------
    "experimental.text.complete": async (input: any, output: any) => {
      if (ctx.state.bypassed) return;
      const text = output?.text;
      if (typeof text !== "string" || text.length < 20) return;

      const found = detectNarration(text);
      if (found.length === 0) return;

      const quoted = found
        .map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`)
        .join(", ");
      output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
    },

    // -----------------------------------------------------------------------
    // Gated trajectory debug dump (Phase 0.3, T0.3.3) — RECORD-ONLY, OPT-IN.
    // No-op unless MODEL_ROUTER_TRAJECTORY_DEBUG=1. On session.idle, writes the
    // session's trajectory scorecard to a throwaway file under the OS temp dir
    // for manual inspection. Best-effort; never throws into the session.
    // Emits nothing model-visible, so GA-1 (no-regression) is preserved.
    // -----------------------------------------------------------------------
    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return;
      const sid = event?.properties?.sessionID;
      if (typeof sid !== "string") return;

      // Per-delegation scorecard: only when enforcement was active (guard state exists).
      try {
        const gstate = guardStore.get(sid);
        if (gstate) {
          const line = formatScorecard(gstate, sessionStore.getTier(sid));
          const dir = join(tmpdir(), "opencode-model-router-trajectory");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${sid}.scorecard.log`), line + "\n", { flag: "a" });
        }
      } catch {
        // best-effort: a scorecard must never crash a real session
      }

      // Opt-in full trajectory dump (unchanged gating).
      if (process.env.MODEL_ROUTER_TRAJECTORY_DEBUG !== "1") return;
      const dump = trajectoryStore.dump(sid);
      if (!dump) return;
      try {
        const dir = join(tmpdir(), "opencode-model-router-trajectory");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${sid}.log`), dump + "\n", { flag: "a" });
      } catch {
        // best-effort
      }
    },

    // -----------------------------------------------------------------------
    // Register tier agents + commands at load time
    // -----------------------------------------------------------------------
    config: async (opencodeConfig: any) => {
      // The config() hook runs once at plugin load time, so the load-time
      // snapshot is the right cfg here (matches the original behaviour where
      // `cfg` was initialised from loadConfig() once at factory start).
      registerTierAgents(opencodeConfig, activeTiers, ctx.initialConfig);
      registerRouterCommands(opencodeConfig);
    },

    // -----------------------------------------------------------------------
    // Inject delegation protocol — uses cached config (invalidated on /preset or /budget)
    // Only inject for the primary orchestrator, NOT for subagent calls.
    // Subagents get confused by delegation instructions when they should
    // just execute a task (especially smaller models like Haiku).
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      if (ctx.state.bypassed) return;
      // Returns cache unless invalidated
      let cfg = ctx.getConfig();
      try {
        cfg = ctx.refreshConfig();
      } catch {
        // Use last known config if file read fails
      }

      // Skip injection for child (subagent) sessions.
      // Child sessions are detected via session.created events with a parentID.
      const sessionID = _input?.sessionID;
      if (sessionID && sessionStore.isSubagent(sessionID)) return;

      // For Claude-backed orchestrators, prepend an adversarial opener that
      // revokes the cached "Claude Code explorer" priming for the routing
      // role. Detection is by orchestrator model, not preset.
      const providerID = _input?.model?.providerID ?? "";
      const modelID = _input?.model?.modelID ?? "";
      const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;

      let enfOn = false;
      try { enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off"; } catch {}
      output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
    },

    // -----------------------------------------------------------------------
    // Handle /tiers, /preset, and /budget commands
    // -----------------------------------------------------------------------
    "command.execute.before": (input: any, output: any) =>
      handleCommandBefore(ctx, input, output),
  };
};

export default ModelRouterPlugin;
