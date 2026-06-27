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

import {
  advance,
  buildEscalatePolicy,
  dumpDelegateScorecard,
  logDelegation,
  logEscalation,
  newLadderState,
  nextAction,
  recordAttempt,
} from "../escalate/ladder";
import { scrubText } from "../guard/scrub";
import type { Preset } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { logEvent } from "../utils/observability";
import { withTimeout } from "../utils/timeout";
import {
  buildAcceptedSuffix,
  buildDelegationDoD,
  buildForcingNote,
  buildGateDeps,
  tierModel,
} from "../verify/dispatch";
import { accept } from "../verify/gate";
import type { PluginContext } from "./context";
import type { DelegateArgs, SessionCreateResult, SessionPromptResult } from "./types";
import { extractPromptText, extractSessionId } from "./types";

/** Re-exported for IDE/test consumers — canonical shape lives in `./types`. */
export type { DelegateArgs } from "./types";

/**
 * Delegate a task to a tier subagent. The subagent's result is independently
 * verified (deterministic checks, or an independent grader at >= the producer
 * tier in a fresh session) before it is returned. Returns an accepted result
 * on PASS, or an honest "unmet" status on FAIL — never a self-reported
 * completion.
 *
 * Cancellation (PR 2 of fix-delegate-cancellation): if `signal` is supplied
 * and fires while the loop is mid-flight, `executeDelegate` returns the empty
 * string `""` silently — no `[router status: unmet]`, no fail-closed sentinel.
 * The caller treats `""` as "the user cancelled; don't surface a fake error".
 *
 * Abort check points (each → silent `""`):
 *   1. Top of the while-loop (covers the case where the abort fires between
 *      attempts or before the loop starts).
 *   2. After `session.create` resolves — we still own a producer session,
 *      so the per-attempt `finally` cleanup must run before we return.
 *   3. Inside the `session.prompt` catch — `withTimeout` rejects with a
 *      `DOMException('aborted', 'AbortError')`; we early-return `""` so
 *      we don't run the gate against an empty artefact.
 *   4. After the gate, when `nextAction` returns `{give_up, "aborted"}` —
 *      the ladder's abort guard fires and we short-circuit to `""` instead
 *      of the normal `[router status: unmet]` formatting.
 *
 * The `session.create`/`session.prompt` SDK options also receive `signal`
 * so the network request itself honours cancellation when the SDK supports
 * it. The `withTimeout` wrapper is the timing-independent safety net.
 */
export const executeDelegate = async (
  ctx: PluginContext,
  args: DelegateArgs,
  parentSessionID?: string,
  signal?: AbortSignal,
): Promise<string> => {
  try {
    let activeCfg = await ctx.getConfig();
    try {
      activeCfg = await ctx.refreshConfig();
    } catch {
      activeCfg = await ctx.getConfig();
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
      Math.max(policy.maxTotalAttempts, policy.ladder.length * (policy.maxAttemptsPerTier + 1)) + 2;
    let safety = 0;

    let producerText = "";
    let forcing: string | null = null;
    let attemptCounter = 0;

    while (true) {
      // Abort check (1): top of loop. If we were cancelled while idle
      // (between attempts, before the loop, or after the last cleanup),
      // exit silently with no producer session to clean up.
      if (signal?.aborted) {
        logEvent.routing.aborted({
          phase: "loop-top",
          attempts: state.totalAttempts,
        });
        return "";
      }

      if (safety++ > safetyMax) {
        logEvent.routing.unmet({
          reason: "safety-net",
          attempts: state.totalAttempts,
        });
        return (
          `[router status: unmet] delegation stopped by the safety net after ` +
          `${state.totalAttempts} attempt(s).\n\n${scrubText(producerText)}`
        );
      }
      const tier = state.currentTier;
      const taskText = forcing ? `${scrubText(forcing)}\n\n${args.task}` : args.task;
      // PR5: structured routing.delegated event — operators can now see
      // the tier + attempt index for every delegation step without
      // scraping the trajectory file.
      attemptCounter += 1;
      logDelegation("", tier, attemptCounter, forcing != null);

      let created: SessionCreateResult;
      try {
        created = await withTimeout(
          ctx.plugin.client.session.create({
            ...(parentSessionID ? { body: { parentID: parentSessionID } } : {}),
            ...(signal ? { signal } : {}),
          }),
          30_000,
          "session.create",
          signal,
        );
      } catch (err) {
        // AbortError during session.create: bail silently. We never
        // produced a producer sid, so no per-attempt cleanup is needed
        // — the outer while-loop will exit on the next top-of-loop check.
        if (err instanceof DOMException && err.name === "AbortError") {
          return "";
        }
        throw err;
      }

      // Abort check (2): after create. We own a producer session at this
      // point — let the per-attempt `finally` block clean it up.
      if (signal?.aborted) {
        const producerSid = extractSessionId(created);
        if (producerSid) {
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
        return "";
      }

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
              ...(signal ? { signal } : {}),
              body: {
                ...(model ? { model } : {}),
                ...(tier ? { agent: tier } : {}),
                parts: [{ type: "text", text: taskText }],
              },
            }),
            600_000,
            "session.prompt (producer)",
            signal,
          );
          producerText = extractPromptText(res);
        } catch (err) {
          // AbortError (3): user cancelled while the prompt was in flight
          // (or while the 600s timeout wrapper was racing). Bail out
          // silently — the per-attempt `finally` will clean up.
          if (err instanceof DOMException && err.name === "AbortError") {
            return "";
          }
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
            await buildGateDeps(ctx, parentSessionID),
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
        // PR5: structured verification outcome observability. Mirrors the
        // dispatch.ts wiring so the two wirings emit the same event shape.
        const eventPayload = {
          sid: producerSid,
          producerTier: tier,
          method: gateRes.verdict.method,
          dodSource: gateRes.dodSource,
          skipped: gateRes.verdict.skipped === true,
          reasonCount: gateRes.verdict.reasons.length,
        };
        if (gateRes.accepted) {
          logEvent.verification.pass(eventPayload);
        } else if (gateRes.verdict.skipped) {
          logEvent.verification.skipped({ ...eventPayload, reasons: gateRes.verdict.reasons });
        } else {
          logEvent.verification.fail({ ...eventPayload, reasons: gateRes.verdict.reasons });
        }

        const costRatio =
          typeof tiersForCost?.[tier]?.costRatio === "number" ? tiersForCost[tier].costRatio : 1;
        state = recordAttempt(state, costRatio);

        const action = nextAction(
          state,
          { pass: gateRes.accepted, reasons: gateRes.verdict.reasons },
          policy,
          signal,
        );

        if (action.action === "accept") {
          // Accept still wins on the very last attempt even if the user
          // cancelled mid-prompt — the producer's verified text is real.
          dumpDelegateScorecard(producerSid, state, true, gateRes.verdict.method);
          return producerText + buildAcceptedSuffix(gateRes.verdict.method);
        }
        if (action.action === "give_up") {
          // Abort guard (4): ladder returned give_up because signal fired.
          // Return silently — no unmet message, no scorecard dump, no
          // forcing note surfaced to the caller.
          if (action.reason === "aborted") {
            logEvent.routing.aborted({
              phase: "ladder-give-up",
              attempts: state.totalAttempts,
            });
            return "";
          }
          dumpDelegateScorecard(producerSid, state, false, gateRes.verdict.method);
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
        const prevTier = state.currentTier;
        state = advance(state, action);
        // PR5: structured routing.escalated event — fires on the
        // from→to transition only (retry stays in the same tier, so no
        // event). `attempt` is the escalation index from the ladder.
        if (action.action === "escalate" && action.tier && action.tier !== prevTier) {
          logEscalation(
            producerSid,
            prevTier,
            action.tier,
            "verification-fail",
            state.totalAttempts,
          );
        }
      } finally {
        // Per-attempt cleanup (drop producer session tracking + state).
        // Always runs — even on timeout, abort, or throw from
        // session.prompt / gate — so a single stuck or cancelled subagent
        // cannot leak tracking entries forever.
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
};
