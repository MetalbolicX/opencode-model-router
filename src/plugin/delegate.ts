// ---------------------------------------------------------------------------
// src/plugin/delegate.ts — Delegate-tool execution loop.
//
// Extracted verbatim from `src/index.ts` during Phase 1 of the
// core-refactor-plan. The body is a copy of the original `tool.delegate.execute`
// closure: same call order, same fail-soft semantics, same return strings.
// Only the shape changed: it now takes `ctx` and `args` as parameters
// instead of closing over them.
//
// PR2 (Phase 3) will replace the `any` payloads with narrow runtime DTOs
// from `src/plugin/types.ts`; the present file deliberately preserves the
// pre-refactor control flow byte-for-byte.
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
import { getActiveTiers } from "../router/protocol";
import type { PluginContext } from "./context";

/** Shape of the args object passed to the delegate tool's `execute`. */
export interface DelegateArgs {
  task: string;
  tier?: string;
  acceptance?: string;
}

/**
 * Delegate a task to a tier subagent. The subagent's result is independently
 * verified (deterministic checks, or an independent grader at >= the producer
 * tier in a fresh session) before it is returned. Returns an accepted result
 * on PASS, or an honest "unmet" status on FAIL — never a self-reported
 * completion.
 */
export async function executeDelegate(
  ctx: PluginContext,
  args: DelegateArgs,
): Promise<string> {
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
        ctx.sessionStore.registerProducerSession(producerSid, tier, activeCfg);
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
        changedFiles: ctx.changedFileStore.get(producerSid),
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
}
