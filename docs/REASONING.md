# Reasoning Control

The router exposes a provider-agnostic way to control how much each subagent reasons before answering. It works through three layers:

1. A **capability model** that describes what each tier can do (none / binary / discrete / budgeted).
2. A **normalized level vocabulary** (`minimal` / `normal` / `elevated` / `max`) that is the same for every tier.
3. A **session-scoped override** set with the `/reasoning` command and applied at `task` dispatch time via `tool.execute.before`.

Pre-Plan-010 tier configs continue to work: capability is **inferred** from existing fields (`variant`, `reasoning.effort`, `thinking.budgetTokens`) when no explicit declaration is present. The bundled presets now declare capability explicitly — see [Capability declarations](#capability-declarations) — so inference is a safety net, not the primary path.

**Cross-references:** [CONFIG_REFERENCE.md → `reasoningPolicy`](./CONFIG_REFERENCE.md#reasoningpolicy) · [Capability declarations](#capability-declarations) · [`/reasoning` command](#reasoning-command) · [Backward compatibility](#backward-compatibility) · [`surfaceLimits`](#surfacelimits)

---

## Normalized levels

The router speaks four levels. They are provider-agnostic; each tier's `capability` decides where the level lands.

| Level | Meaning | Rank |
|---|---|---|
| `minimal` | Skip extra reasoning work. | 0 |
| `normal` | Tier's baseline reasoning effort. | 1 |
| `elevated` | Reason harder than baseline. | 2 |
| `max` | Top available reasoning effort. | 3 |

These are the only valid arguments to `/reasoning`. Anything else returns `Unknown level: "<arg>". Use one of: minimal, normal, elevated, max (or "off" to clear).`

---

## Capability model

Every tier carries a `capability` field. The shape determines how `translateLevel` emits the provider-specific `variant` / `options` patch.

| `kind` | `field` | Behaviour | Example tier |
|---|---|---|---|
| `none` | _(none)_ | No reasoning control. The router never mutates the tier — `/reasoning` is a no-op for this tier. | `anthropic.fast` (Haiku), `google.*` (Gemini) |
| `binary` | `variant` | Two-state toggle: a baseline + an elevated variant. `minimal`/`normal` map to the baseline (or `null` when no baseline is declared); `elevated`/`max` map to the elevated variant. | `multi-provider.medium` (MiniMax `thinking`), `anthropic.medium` (Sonnet `max`), `anthropic.heavy` (Opus `max`) |
| `discrete` | `variant` | N-state ladder routed through `agentDef.variant`. Picked by nearest-rank mapping: `Math.round(rank/3 * (len-1))`. | `multi-provider.fast` (mimo `[low, medium, high]`), `openai.medium` (`[low, medium, high]`), `openai.heavy` (`[low, medium, high, xhigh]`) |
| `discrete` | `reasoning.effort` | Same ladder, routed through `agentDef.options.reasoning_effort`. | `multi-provider.heavy` (gpt-5.4 `[low, medium, high]`) |
| `budgeted` | `thinking.budgetTokens` | Token budget ladder routed through `agentDef.options.budget_tokens`. Not used in the bundled presets today; reserved for future Anthropic-style budget tiers. | _(none in `multi-provider`)_ |

The `field` discriminator is **mandatory** on every variant that carries an output channel. `translateLevel` uses it as the single source of truth for routing — it never has to look back at the tier to decide where the patch lands.

### Translation rules

Given a `(capability, level)` pair, the translator emits a `ResolvedReasoning`:

| Capability × level | Emitted patch |
|---|---|
| `none` × _anything_ | `null` (never mutated) |
| `binary` × `minimal`/`normal` | `{ variant: cap.baseline }` _or_ `null` when no baseline is declared |
| `binary` × `elevated`/`max` | `{ variant: cap.elevated }` |
| `discrete` × _level_ | `{ variant: <picked> }` when `field === "variant"`, else `{ options: { reasoning_effort: <picked> } }` |
| `budgeted` × _level_ | `{ options: { budget_tokens: cap.recommended[level] ?? cap.recommended.normal } }` |

`null` is the canonical "no-op" sentinel. The router and the `/reasoning` command both honor it: a `null` patch is silently skipped (unless [`surfaceLimits`](#surfacelimits) is enabled, in which case a debug log + advisory note is emitted).

---

## Capability declarations

The bundled presets declare capability explicitly on every tier. This table is the authoritative reference for what `/reasoning` can do on each tier.

| Preset | Tier | Model | Capability |
|---|---|---|---|
| `multi-provider` | `fast` | `opencode-go/mimo-v2.5` | `discrete` · `variant` · `[low, medium, high]` |
| `multi-provider` | `medium` | `minimax/MiniMax-M3` | `binary` · `variant` · elevated `thinking` |
| `multi-provider` | `heavy` | `openai/gpt-5.4` | `discrete` · `reasoning.effort` · `[low, medium, high]` |
| `openai` | `fast` | `openai/gpt-5.4-mini-fast` | `none` |
| `openai` | `medium` | `openai/gpt-5.5-fast` | `discrete` · `variant` · `[low, medium, high]` |
| `openai` | `heavy` | `openai/gpt-5.5-fast` | `discrete` · `variant` · `[low, medium, high, xhigh]` |
| `anthropic` | `fast` | `anthropic/claude-haiku-4-5` | `none` |
| `anthropic` | `medium` | `anthropic/claude-sonnet-4-6` | `binary` · `variant` · elevated `max` |
| `anthropic` | `heavy` | `anthropic/claude-opus-4-8` | `binary` · `variant` · elevated `max` |
| `github-copilot` | `fast` | `github-copilot/claude-haiku-4-5` | `none` |
| `github-copilot` | `medium` | `github-copilot/claude-sonnet-4-6` | `none` |
| `github-copilot` | `heavy` | `github-copilot/claude-opus-4-6` | `binary` · `variant` · elevated `thinking` |
| `google` | `fast` / `medium` / `heavy` | gemini-* | `none` (all three) |
| `hybrid` | `fast` | `anthropic/claude-haiku-4-5` | `none` |
| `hybrid` | `medium` | `openai/gpt-5.5-fast` | `discrete` · `variant` · `[low, medium, high]` |
| `hybrid` | `heavy` | `anthropic/claude-opus-4-8` | `binary` · `variant` · elevated `max` |

### Capability schema

Per tier (`TierConfig.capability`):

```ts
type ReasoningCapability =
  | { kind: "none" }
  | { kind: "binary"; field: "variant"; baseline?: string; elevated: string }
  | { kind: "discrete"; field: "variant" | "reasoning.effort"; levels: string[] }
  | {
      kind: "budgeted";
      field: "thinking.budgetTokens";
      recommended: Record<"minimal" | "normal" | "elevated" | "max", number>;
    };
```

`field` is mandatory on every variant carrying output. `baseline` is optional on `binary` (omit it when there is no low-state variant — `minimal`/`normal` then resolve to `null`, i.e. the tier is left at whatever variant was statically declared).

---

## Policy modes (`reasoningPolicy`)

`reasoningPolicy.mode` controls when an override is applied:

| Mode | Behaviour | Use it for |
|---|---|---|
| `static` _(default when `reasoningPolicy` is absent)_ | Always returns `null` from the policy resolver. `static` is a hard no-op: even if a session override exists, the agent def is left exactly as `registerTierAgents` produced it. | Pre-Plan-010 configs. Anyone who wants byte-identical behaviour to today. |
| `manual` | Translates `sessionOverride ?? policy.defaultLevel` through the tier's capability. When the override is `undefined` and no `defaultLevel` is configured, returns `null` (silent no-op). | `/reasoning` driven overrides. This is the **bundled default** as of Plan 010 PR 3. |
| `adaptive` | Stub. Returns `null`. A follow-up plan will wire an adaptive engine that picks the level based on task class / risk signals. | Not yet functional — declare it to opt in once the engine ships. |

`surfaceLimits` defaults to `false`. See [below](#surfacelimits).

### Defaults shipped in `base.json`

```jsonc
{
  "reasoningPolicy": {
    "mode": "manual",
    "surfaceLimits": false
  }
}
```

Because `surfaceLimits` is `false`, the default behaviour is silent: a `/reasoning minimal` call on a `none`-capability tier produces a confirmation in the chat but does not mutate the agent def or emit any plugin log. Only an explicit `surfaceLimits: true` changes this.

To restore the pre-Plan-010 byte-identical behaviour, set `reasoningPolicy.mode` to `"static"`.

---

## `/reasoning` command

The `/reasoning` command is the user-facing entry point. It validates against the four normalized levels plus `off`, sets/clears the session override on `ctx.reasoningStore`, and prints a per-tier acknowledgement describing what each active tier will do.

### Usage

| Form | Effect |
|---|---|
| `/reasoning` _(no args)_ | Print policy mode + per-tier capability descriptions. |
| `/reasoning minimal` | Set session override to `minimal`. |
| `/reasoning normal` | Set session override to `normal`. |
| `/reasoning elevated` | Set session override to `elevated`. |
| `/reasoning max` | Set session override to `max`. |
| `/reasoning off` | Clear the session override. |
| `/reasoning foo` | Reject: `Unknown level: "foo". Use one of: minimal, normal, elevated, max (or "off" to clear).` |

The override applies to the **next `task` dispatch in this session only**. The runtime hooks restore the baseline tier config in `tool.execute.after`, so a session override does not leak to subsequent dispatches or to other sessions.

### Example output (`/reasoning elevated`)

```
Reasoning override set to **elevated** for this session.

Per-tier behaviour:
- @fast: variant = 'high'.
- @medium: variant = 'thinking'.
- @heavy: options = {"reasoning_effort":"high"}.

Takes effect on the next `task` dispatch in this session.
```

With `surfaceLimits: true`, the output also flags collapses:

```
- @fast: variant = 'medium'.
  Note: 'elevated' collapses to 'medium' (same as 'normal') on this tier's ladder
  — surface the limit by enabling reasoningPolicy.surfaceLimits.
```

### How the override is applied

```
/reasoning elevated
  -> command.execute.before (sessionID threaded through runtime)
  -> reasoningStore.set(sessionID, "elevated")

Task(subagent_type="medium")
  -> tool.execute.before
  -> resolveReasoningOverride(tier, cfg.reasoningPolicy, store.get(sessionID))
  -> applyReasoningPatch(liveAgent, resolved)
  -> task spawns child with patched agent config
  -> tool.execute.after restores baseline tier config
  -> optional pending note emitted when surfaceLimits=true
```

`tool.execute.after` always restores from the `structuredClone` baseline captured at `handleConfig` time, so concurrent unrelated dispatches on different tiers never see each other's state.

---

## Backward compatibility

Plan 010 is fully backward-compatible with every config shipped before it.

| Pre-Plan-010 config | Post-Plan-010 behaviour |
|---|---|
| No `reasoningPolicy` block | Resolves to `static` mode. `resolveReasoningOverride` returns `null` regardless of any session override. Agent output is **byte-identical** to pre-Plan-010. |
| No `capability` on a tier | `inferCapability(tier)` walks `reasoning.effort`, `thinking.budgetTokens`, then `variant` (positional vs named split) and returns the inferred shape. Existing tier fields are the source of truth. |
| Explicit `capability` on a tier | Authoritative. Inference is skipped. The translator uses the declared `field` and `levels`/`baseline`/`elevated`/`recommended`. |

The default in the **bundled** `base.json` is now `manual` mode (so `/reasoning` works out of the box). User-supplied `global` / `local` tiers.json layers can override it back to `static` to keep pre-Plan-010 behaviour verbatim.

### Inference rules

`inferCapability` walks the legacy fields in this order (first match wins):

1. `tier.reasoning.effort` is set → `discrete` · `reasoning.effort` · `[low, medium, high]`.
2. `tier.thinking.budgetTokens` is set → `budgeted` · `thinking.budgetTokens` · default ladder `{ minimal: 1024, normal: 4096, elevated: 8192, max: 16000 }`.
3. `tier.variant` is positional (`low` / `medium` / `high` / `xhigh`) → `discrete` · `variant` · ladder sized to include the seen position (`xhigh` ⇒ 4 rungs, otherwise 3).
4. `tier.variant` is named (`thinking` / `max`) → `binary` · `variant` · elevated = the seen variant.
5. otherwise → `none`.

Inference is intentionally narrow: it cannot silently invent behaviour. Tiers that need a richer capability (custom ladders, explicit baselines, custom budget maps) **must** declare `capability` directly.

---

## `surfaceLimits`

`surfaceLimits` is an opt-in presentation flag. It does NOT change which patches are emitted — surfacing is purely a presentation concern owned by the `/reasoning` command and the runtime log layer.

| Value | Effect |
|---|---|
| `false` _(bundled default)_ | Silent no-op when a tier cannot satisfy the requested level. The `/reasoning` command still prints the success line, but per-tier skip/collapse notes are omitted. |
| `true` | When a tier's capability cannot satisfy the requested level, the `/reasoning` output flags it (`- @<tier>: unsupported (no reasoning control).`) and collapse-on-coarse-ladder notes are expanded. The runtime also emits a debug log via the `tool.execute.after` hook. |

Set `surfaceLimits: true` while you are triaging a new tier or a new override; leave it `false` for production.

---

## Known quirks

### 3-level discrete ladder collapse

`translateLevel` maps normalized ranks onto discrete ladders via `Math.round((rank / 3) * (len - 1))`. On a **3-level** ladder (`[low, medium, high]`), this collapses `normal` and `elevated` onto the same rung:

| Requested level | Rank | Index for 3-level ladder | Picked |
|---|---|---|---|
| `minimal` | 0 | `round(0/3 * 2)` = 0 | `low` |
| `normal` | 1 | `round(1/3 * 2)` = `round(0.667)` = 1 | `medium` |
| `elevated` | 2 | `round(2/3 * 2)` = `round(1.333)` = 1 | `medium` ← collapse |
| `max` | 3 | `round(3/3 * 2)` = 2 | `high` |

`/reasoning elevated` and `/reasoning normal` produce the **same patch** on `multi-provider.fast` (mimo's 3-level ladder). 4-level ladders (`[low, medium, high, xhigh]`) do not collapse.

The collapse is intentional: it matches the discrete-ladder spec. The `/reasoning` command surfaces it (under `surfaceLimits`) so users are not surprised by the same `variant` for two different requested levels. 2-level ladders behave correctly because `Math.min(rawIdx, len-1)` clamps; 4+ level ladders have one rung per normalized level.

### Other limitations

- `budgeted` capability is supported by the translator but **not declared** on any bundled tier today. Declaring it on a tier requires both `field: "thinking.budgetTokens"` and a `recommended` map covering all four normalized levels.
- The bundled default mode is `manual`, which means `/reasoning` works out of the box. Set `reasoningPolicy.mode` to `static` to restore the pre-Plan-010 byte-identical behaviour.
- The `adaptive` mode is a stub. Returning `null` from the policy resolver is the documented behaviour; the follow-up plan will wire an adaptive engine.

---

## Verification

Per [plans/010-adaptive-reasoning.md](../../plans/010-adaptive-reasoning.md):

| Layer | Tests |
|---|---|
| Unit — inference | `test/unit/reasoning-capability.test.ts` — all 4 shapes incl. positional-vs-named variant split. |
| Unit — translation | `test/unit/reasoning-translate.test.ts` — every capability × level; `none` always `null`; 2-level discrete clamping; field routing. |
| Unit — policy | `test/unit/reasoning-policy.test.ts` — `static` ALWAYS null; `manual`+override applies; `surfaceLimits` does NOT alter resolved patch. |
| Unit — agent wiring | `test/unit/router-agents.test.ts` — `applyReasoningPatch` + `restoreAgentBaseline` round-trip; `none`-capability NEVER mutated. |
| Unit — command | `test/unit/router-commands.test.ts` — `/reasoning` validates level, sets/clears store, names capability. |
| Unit — hooks | `test/unit/plugin-hooks.test.ts` — `handleConfig` captures baseline; `tool.execute.before/after` patch/restore. |

Run:

```bash
pnpm test -- reasoning router-agents router-commands plugin-hooks
```