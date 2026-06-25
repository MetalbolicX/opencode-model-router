// ---------------------------------------------------------------------------
// src/plugin/delegate.ts — Delegate-tool execution loop.
//
// Extracted verbatim from `src/index.ts` during Phase 1 of the
// core-refactor-plan. The body is a copy of the original `tool.delegate.execute`
// closure: same call order, same fail-soft semantics, same return strings.
// Only the shape changed: it now takes `ctx` and `args` as parameters
// instead of closing over them.
//
// Phase 3 later tightened the hot-path DTOs in this file without changing
// the control flow; the present file still preserves the pre-refactor
// behavior byte-for-byte.
// ---------------------------------------------------------------------------

import { scrubText } from "../guard/scrub";
import { accept } from "../verify/gate";
import {
  buildAcceptedSuffix,
  buildDelegationDoD,
  buildForcingNote,
  buildGateDeps,
  tierModel,
} from "../verify/dispatch";
import {
  advance,
  buildEscalatePolicy,
  dumpDelegateScorecard,
  newLadderState,
  nextAction,
  recordAttempt,
} from "../escalate/ladder";
import type { Preset } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { withTimeout } from "../utils/timeout";
import type { PluginContext } from "./context";
import type {
  DelegateArgs,
  SessionCreateResult,
  SessionPromptResult,
} from "./types";
import { extractPromptText, extractSessionId } from "./types";

/** Re-exported for IDE/test consumers — canonical shape lives in `./types`. */
export type { DelegateArgs } from "./types";

/**
 * Delegate a task to a tier subagent. The subagent's result is independently
 * verified (deterministic checks, or an independent grader at >= the producer
 * tier in a fresh session) before it is returned. Returns an accepted result
 * on PASS, or an honest "unmet" status on FAIL — never a self-reported
 * completion.
 */
export const executeDelegate = async (
  ctx: PluginContext,
  args: DelegateArgs,
  parentSessionID?: string,
): Promise<string> => {
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
    const tiersForCost: Preset = getActiveTiers(activeCfg);

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

      const created: SessionCreateResult = await withTimeout(
        ctx.plugin.client.session.create(
          parentSessionID ? { body: { parentID: parentSessionID } } : {},
        ),
        30_000,
        "session.create",
      );
      const producerSid = extractSessionId(created);
      if (!producerSid) {
        return "[router] delegate failed: could not create a producer session.";
      }
      // Compose with Layer 1: guard the plugin-created producer session.
      try {
        ctx.sessionStore.registerProducerSession(producerSid, tier, activeCfg);
      } catch {
        // non-fatal
      }

      try {
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
          const res: SessionPromptResult = await withTimeout(
            ctx.plugin.client.session.prompt({
              path: { id: producerSid },
              body: {
                ...(model ? { model } : {}),
                ...(tier ? { agent: tier } : {}),
                parts: [{ type: "text", text: taskText }],
              },
            }),
            600_000,
            "session.prompt (producer)",
          );
          producerText = extractPromptText(res);
        } catch (err) {
          // Provider-failover design (see header comment): a transport/API
          // error yields an empty artefact and counts as exactly ONE failed
          // attempt. `err` is bound so the failure is observable at debug
          // time and in code review — not silently discarded.
          void err;
          producerText = "";
        }

        const artefact = {
          changedFiles: ctx.changedFileStore.get(producerSid),
          finalReturnText: producerText,
          declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
          producerSessionID: producerSid,
          producerTier: tier,
        };

        let gateRes: Awaited<ReturnType<typeof accept>>;
        try {
          gateRes = await accept(
            { dod, trivial: false, mode: "modeA" },
            artefact,
            buildGateDeps(ctx, parentSessionID),
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          gateRes = {
            accepted: false,
            verdict: {
              pass: false,
              method: "none" as const,
              reasons: [`verification failed (fail-closed): ${reason}`],
            },
            dodSource: dod.source,
          };
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
      } finally {
        // Per-attempt cleanup (drop producer session tracking + state).
        // Always runs — even on timeout or throw from session.prompt / gate —
        // so a single stuck subagent cannot leak tracking entries forever.
        ctx.changedFileStore.clear(producerSid);
        try {
          ctx.sessionStore.unregister(producerSid);
        } catch {
          // non-fatal
        }
        try {
          ctx.guardStore.clear(producerSid);
        } catch {
          // non-fatal
        }
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `[router] delegate failed (fail-closed): the delegation or verification could not complete (${reason}).`;
  }
}
