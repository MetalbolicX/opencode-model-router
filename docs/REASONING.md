# Reasoning Control

The router exposes a provider-agnostic way to control how much each subagent reasons before answering. It works through three layers:

1. A **capability model** that describes what each tier can do (none / binary / discrete / budgeted).
2. A **normalized level vocabulary** (`minimal` / `normal` / `elevated` / `max`) that is the same for every tier.
3. A **session-scoped override** set with the `/model-router-reasoning` command and applied at `task` dispatch time via `tool.execute.before`.

Pre-Plan-010 tier configs continue to work: capability is **inferred** from existing fields (`variant`, `reasoning.effort`, `thinking.budgetTokens`) when no explicit declaration is present. The bundled presets now declare capability explicitly — see [Capability declarations](#capability-declarations) — so inference is a safety net, not the primary path.

**Cross-references:** [CONFIG_REFERENCE.md → `reasoningPolicy`](./CONFIG_REFERENCE.md#reasoningpolicy) · [Capability declarations](#capability-declarations) · [Policy modes](#policy-modes-reasoningpolicy) · [Adaptive mode](#adaptive-mode) · [`/model-router-reasoning` command](#model-router-reasoning-command) · [Backward compatibility](#backward-compatibility) · [`surfaceLimits`](#surfacelimits)

---

## Normalized levels

The router speaks four levels. They are provider-agnostic; each tier's `capability` decides where the level lands.

| Level | Meaning | Rank |
|---|---|---|
| `minimal` | Skip extra reasoning work. | 0 |
| `normal` | Tier's baseline reasoning effort. | 1 |
| `elevated` | Reason harder than baseline. | 2 |
| `max` | Top available reasoning effort. | 3 |

These are the only valid arguments to `/model-router-reasoning`. Anything else returns `Unknown level: "<arg>". Use one of: minimal, normal, elevated, max (or "off" to clear).`

---

## Capability model

Every tier carries a `capability` field. The shape determines how `translateLevel` emits the provider-specific `variant` / `options` patch.

| `kind` | `field` | Behaviour | Example tier |
|---|---|---|---|
| `none` | _(none)_ | No reasoning control. The router never mutates the tier — `/model-router-reasoning` is a no-op for this tier. | `anthropic.fast` (Haiku), `google.*` (Gemini) |
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

`null` is the canonical "no-op" sentinel. The router and the `/model-router-reasoning` command both honor it: a `null` patch is silently skipped (unless [`surfaceLimits`](#surfacelimits) is enabled, in which case the runtime emits a debug event — see [`surfaceLimits`](#surfacelimits)).

---

## Capability declarations

The bundled presets declare capability explicitly on every tier. This table is the authoritative reference for what `/model-router-reasoning` can do on each tier.

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
| `manual` | Translates `sessionOverride ?? policy.defaultLevel` through the tier's capability. When the override is `undefined` and no `defaultLevel` is configured, returns `null` (silent no-op). | `/model-router-reasoning` driven overrides. The **bundled default** as of Plan 010 PR 3, and the mode this release ships with runtime mode switching (`static` and `adaptive` also persist via `mode`). |
| `adaptive` | Picks a level from real task signals via `selectAdaptiveLevel()`. Decision order: `trivialLevel` → `tierDefaults[tierName]` → first-matching `keywordRules` rule → `defaultLevel` → `null` (no patch). An explicit session override always wins over the selector. See [Adaptive mode](#adaptive-mode) for the full contract and what the selector does **not** consider (no history, no token usage, no cross-session learning). | Per-session overrides are still honoured (`/model-router-reasoning elevated`) and beat the selector. Opt in with `/model-router-reasoning mode adaptive`. |

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

Because `surfaceLimits` is `false`, the default behaviour is silent: a `/model-router-reasoning minimal` call on a `none`-capability tier produces a confirmation in the chat but does not mutate the agent def or emit any plugin log. Only an explicit `surfaceLimits: true` changes this.

To restore the pre-Plan-010 byte-identical behaviour, set `reasoningPolicy.mode` to `"static"`.

### Persisted policy-mode switching

The bundled default of `manual` mode is fine for most users, but operators who need to flip the runtime between override-driven and static behaviour without restarting OpenCode can persist a new mode through the router state overlay:

```bash
/model-router-reasoning mode manual   # enables per-session override flow (default)
/model-router-reasoning mode static   # disables it; tiers render at their declared baseline
/model-router-reasoning mode adaptive # opts in to the selector — see [Adaptive mode](#adaptive-mode)
```

The `mode` subcommand writes `reasoningMode` into the router state overlay via `saveReasoningMode()`, which is the same persistence path used by `/router enforce`. The next config refresh — the one the `command.execute.before` hook calls through `getFreshConfig()` — picks the new mode up and honors it on the next `task` dispatch. There is no per-session override for the policy mode; the value is global to the workspace.

### Adaptive mode

`adaptive` is a **deterministic, config-driven selector** (`src/reasoning/adaptive.ts`) — not an LLM inference and not a learned model. Given the same signals and policy, it returns the same decision every time. The selector is pure: no IO, no module state, no side effects, fully covered by `test/unit/adaptive-selector.test.ts`. Every decision is reproducible and operator-configurable.

#### Signal inputs (every dispatch)

The runtime extracts these from the Task-tool args at `tool.execute.before` (see `src/plugin/hooks.ts:154-163`) and threads them into `selectAdaptiveLevel()` as `AdaptiveSignals`:

| Signal | Source | Note |
|---|---|---|
| `prompt` | `args.prompt` from the built-in `task` tool | Lowercased by the caller. Keyword matching is case-insensitive substring on already-normalised text. May be empty. |
| `description` | `args.description` from the built-in `task` tool | Lowercased by the caller. May be empty. |
| `tierName` | `args.subagent_type` (e.g. `"medium"`, `"heavy"`) | Looked up against `reasoningPolicy.adaptive.tierDefaults`. |
| `isTrivial` | `ctx.sessionStore.isTrivial(sessionID)` | The dispatch-time trivial classification result. |

#### Decision order (first match wins)

The selector runs the steps below in order and stops at the first match. `null` at any step means "no patch" — the agent def is left at baseline.

1. `reasoningPolicy.adaptive` is absent → `null` (no adaptive config). This is the same effective behaviour as `static` mode for an unprepared config.
2. `signals.isTrivial === true` → `adaptive.trivialLevel` (or `null` if unset → no patch for trivial sessions).
3. `adaptive.tierDefaults[signals.tierName]` is set → that level.
4. `adaptive.keywordRules` scanned in array order — first rule whose keywords (case-insensitive substring) match in `prompt` OR `description` wins.
5. `adaptive.defaultLevel` (or `null` if unset → no patch).
6. Fall-through to `null` (no patch).

Every resolved level is then passed through `translateLevel(cap, level)` in `policy.ts`, so capability gating still applies — adaptive only picks the **normalized level**, not the provider-specific patch. A `none`-capability tier, a `binary` capability without a baseline for a low-rank level, etc., all still resolve to `null` through the same translator the other modes use.

#### Precedence under adaptive mode

When `mode === "adaptive"` the resolver consults inputs in this order (highest first):

1. **Explicit session override** (`/model-router-reasoning minimal|normal|elevated|max` → `ctx.reasoningStore.get(sessionID)`) — **always wins**, regardless of selector output. Operators need certainty when they set an override manually.
2. `selectAdaptiveLevel(signals, policy)` result.
3. `policy.defaultLevel` as a safety net.
4. `null` (no patch).

This precedence is mirrored in the file header of `src/reasoning/policy.ts` and exercised by `test/unit/reasoning-policy.test.ts` (the `adaptive-mode delegates to selectAdaptiveLevel` describe block).

#### Config block

```jsonc
"reasoningPolicy": {
  "mode": "adaptive",
  "defaultLevel": "normal",
  "adaptive": {
    "trivialLevel": null,                                    // null → skip trivial sessions entirely
    "defaultLevel": "normal",                                 // catch-all for non-trivial tasks with no keyword match
    "keywordRules": [
      { "keywords": ["refactor", "architecture", "security", "migration"], "level": "elevated" },
      { "keywords": ["debug", "diagnose", "investigate", "root cause"], "level": "elevated" },
      { "keywords": ["test", "fix", "patch"], "level": "normal" }
    ],
    "tierDefaults": { "fast": "minimal" },                    // optional: pin a level per tier, wins over defaultLevel
    "surfaceDecision": false                                  // debug-log every adaptive decision when true
  }
}
```

All fields are optional — a partial block is a valid config. `null` on `trivialLevel` / `defaultLevel` is a valid value (means "no patch"). Order matters in `keywordRules`: the **first** rule whose keywords match wins, so high-precision rules MUST come before catch-alls. The shipped `config/tiers/base.json` carries the conservative defaults above with `mode: "manual"` so existing installs behave unchanged until operators opt in.

#### What adaptive does NOT consider (yet)

The shipped selector is deliberately minimal. It does not consult any of:

- **Conversation history** — only the current task's `prompt` + `description`. Past turns, the user's prior preferences, and the conversation thread are not in scope.
- **Token usage** — no budget tracking, no cost ledger, no "you've used a lot so far" feedback. The `tierCaps` map in `base.json` is enforced separately by the `tool.execute.after` banner; it is not an adaptive signal.
- **Cross-session learning** — every dispatch is decided independently. There is no stored history of past decisions, no per-tier model, no analytics.
- **Tool-call counts in the same session** — the trivial classifier used at dispatch time is the only session-state signal read. The router does not remember what the previous dispatch decided.
- **The level chosen by previous dispatches in the same session** — adaptive is dispatch-by-dispatch, not cumulative. There is no escalation ladder that builds on prior calls.

A future plan can extend `AdaptiveSignals` and add new decision branches without touching the runtime call site (the selector is pure). Today, if you need any of the above signals, switch to `manual` mode and use `/model-router-reasoning <level>` directly per dispatch.

#### Forcing manual control (workarounds)

There are three ways to override the selector — for a single dispatch, for one tier, or for the whole workspace:

- **Per-session, single dispatch.** Set an override before dispatching: `/model-router-reasoning elevated`. The override wins for the next `task` call in this session; clear with `/model-router-reasoning off`. The override applies to all tiers in that session, not just one.
- **Per-tier pinning.** Add the tier name to `reasoningPolicy.adaptive.tierDefaults` — that tier's level is decided by the table, not by keywords or the trivial classifier. Useful for pinning `@fast` to `minimal` (no selector overhead on cheap lookups) or `@heavy` to `elevated` (always reason harder on heavy dispatch).
- **Disable adaptive globally.** `/model-router-reasoning mode static` — restores pre-Plan-015 byte-identical behaviour (no patches ever). Or `/model-router-reasoning mode manual` — keeps the per-session override surface but disables automatic selection. Both persist through `saveReasoningMode()`.

#### Opt-in observability

Set `reasoningPolicy.adaptive.surfaceDecision` to `true` to emit `log.debug({ event: "reasoning.adaptive_selected", session, tier, level, reason })` on every dispatch under `adaptive` mode. `reason` is a short machine-friendly string (`"trivial"`, `"tier default: heavy"`, `"keyword match: refactor"`, `"default level"`, `"no adaptive config"`) so operators can correlate what each dispatch decided without re-running the selector. Off by default — leave it `false` for production to avoid log noise. Independent from `reasoningPolicy.surfaceLimits`, which controls the `reasoning.patch_applied` / `reasoning.patch_unsupported` events emitted at `src/plugin/hooks.ts:170-188`.

---

## `/model-router-reasoning` command

The `/model-router-reasoning` command is the user-facing entry point. It has two distinct surfaces, separated by the `mode` subcommand:

- **Level overrides** (`minimal` / `normal` / `elevated` / `max` / `off`) set a **session-scoped** override on `ctx.reasoningStore`. The override applies to the next `task` dispatch in this session only and is cleared by `off`.
- **Mode switching** (`mode static` / `mode manual` / `mode adaptive`) **persists** a new policy-mode value through the router state overlay (`saveReasoningMode`). The change is global to the workspace and survives restarts — it is NOT session-scoped. `mode adaptive` opts in to the selector described under [Adaptive mode](#adaptive-mode); `mode static` and `mode manual` preserve their pre-Plan-015 semantics.

### Usage

| Form | Effect |
|---|---|
| `/model-router-reasoning` _(no args)_ | Print policy mode + per-tier capability descriptions. |
| `/model-router-reasoning minimal` | Set session override to `minimal`. |
| `/model-router-reasoning normal` | Set session override to `normal`. |
| `/model-router-reasoning elevated` | Set session override to `elevated`. |
| `/model-router-reasoning max` | Set session override to `max`. |
| `/model-router-reasoning off` | Clear the session override. |
| `/model-router-reasoning mode` | Print the current persisted policy mode + usage. |
| `/model-router-reasoning mode static` | **Persist** `mode: "static"` to the state overlay; takes effect on the next config refresh. |
| `/model-router-reasoning mode manual` | **Persist** `mode: "manual"` to the state overlay; takes effect on the next config refresh. |
| `/model-router-reasoning mode adaptive` | **Persist** `mode: "adaptive"` to the state overlay; the selector described under [Adaptive mode](#adaptive-mode) takes effect on the next config refresh. Per-session overrides still win over the selector. |
| `/model-router-reasoning foo` | Reject: `Unknown level: "foo". Use one of: minimal, normal, elevated, max (or "off" to clear). Run '/model-router-reasoning mode' to switch the policy.` |

The level override applies to the **next `task` dispatch in this session only**. The runtime hooks restore the baseline tier config in `tool.execute.after`, so a session override does not leak to subsequent dispatches or to other sessions. The persisted mode, by contrast, applies to every dispatch that loads the config from that point on — until another `mode` call (or a manual edit to the state file) changes it again.

### Example output (`/model-router-reasoning elevated`)

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

### Example output (`/model-router-reasoning mode manual`)

```
Reasoning policy mode set to **manual** and persisted.

Per-session overrides are enabled — `/model-router-reasoning minimal|normal|elevated|max` will take effect on the next task dispatch.

Takes effect on the next config refresh.
```

### How the override is applied

```
/model-router-reasoning elevated
  -> command.execute.before (sessionID threaded through runtime)
  -> reasoningStore.set(sessionID, "elevated")

Task(subagent_type="medium")
  -> tool.execute.before
  -> resolveReasoningOverride(tier, cfg.reasoningPolicy, store.get(sessionID))
  -> applyReasoningPatch(liveAgent, resolved)
  -> task spawns child with patched agent config
  -> tool.execute.after restores baseline tier config
  -> same-tier overlap is skipped, not double-patched (see Same-tier in-flight guard below)
  -> runtime emits a log.debug event when surfaceLimits=true (see surfaceLimits)
```

`tool.execute.after` always restores from the `structuredClone` baseline captured at `handleConfig` time, so concurrent unrelated dispatches on different tiers never see each other's state.

### Same-tier in-flight guard

The reasoning store tracks one owner per tier (the sessionID currently holding the patch lock for that tier). A second same-tier dispatch observes `acquireTierOwner` returning `false` and **skips the patch** rather than overwriting an in-flight one. The skipped dispatch emits the debug event `reasoning.patch_skipped_concurrent` with the current owner, so the reason the patch was suppressed is observable without leaking into the chat. The after-hook releases ownership only when the current session is still the owner, so a foreign after-hook cannot drop another session's lock.

---

## Backward compatibility

Plan 010 is fully backward-compatible with every config shipped before it.

| Pre-Plan-010 config | Post-Plan-010 behaviour |
|---|---|
| No `reasoningPolicy` block | Resolves to `static` mode. `resolveReasoningOverride` returns `null` regardless of any session override. Agent output is **byte-identical** to pre-Plan-010. |
| No `capability` on a tier | `inferCapability(tier)` walks `reasoning.effort`, `thinking.budgetTokens`, then `variant` (positional vs named split) and returns the inferred shape. Existing tier fields are the source of truth. |
| Explicit `capability` on a tier | Authoritative. Inference is skipped. The translator uses the declared `field` and `levels`/`baseline`/`elevated`/`recommended`. |

The default in the **bundled** `base.json` is now `manual` mode (so `/model-router-reasoning` works out of the box). User-supplied `global` / `local` tiers.json layers can override it back to `static` to keep pre-Plan-010 behaviour verbatim.

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

`surfaceLimits` is an opt-in presentation flag. It does NOT change which patches are emitted — surfacing is purely a presentation concern owned by the `/model-router-reasoning` command and the runtime log layer.

| Value | Effect |
|---|---|
| `false` _(bundled default)_ | Silent no-op when a tier cannot satisfy the requested level. The `/model-router-reasoning` command still prints the success line, but per-tier skip/collapse notes are omitted and the runtime does not emit any reasoning-related debug events. |
| `true` | When a tier's capability cannot satisfy the requested level, the `/model-router-reasoning` output flags it (`- @<tier>: unsupported (no reasoning control).`) and collapse-on-coarse-ladder notes are expanded. The runtime emits `log.debug` events keyed by `event` so operators can correlate what each dispatch did: `reasoning.patch_applied` (a patch landed), `reasoning.patch_unsupported` (an override resolved to `null`), and `reasoning.patch_skipped_concurrent` (a same-tier overlap was skipped — see [Same-tier in-flight guard](#same-tier-in-flight-guard)). |

Surfacing is observability, not a user-facing message: the debug events never appear in the chat, they only show up in the plugin log. There is no advisory "pending note" path — that plumbing was removed in Plan 014 because nothing consumed it.

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

`/model-router-reasoning elevated` and `/model-router-reasoning normal` produce the **same patch** on `multi-provider.fast` (mimo's 3-level ladder). 4-level ladders (`[low, medium, high, xhigh]`) do not collapse.

The collapse is intentional: it matches the discrete-ladder spec. The `/model-router-reasoning` command surfaces it (under `surfaceLimits`) so users are not surprised by the same `variant` for two different requested levels. 2-level ladders behave correctly because `Math.min(rawIdx, len-1)` clamps; 4+ level ladders have one rung per normalized level.

### Other limitations

- `budgeted` capability is supported by the translator but **not declared** on any bundled tier today. Declaring it on a tier requires both `field: "thinking.budgetTokens"` and a `recommended` map covering all four normalized levels.
- The bundled default mode is `manual`, which means `/model-router-reasoning` works out of the box. Set `reasoningPolicy.mode` to `static` to restore the pre-Plan-010 byte-identical behaviour.
- The `adaptive` mode is **available as an opt-in** as of Plan 015. The bundled `config/tiers/base.json` ships a conservative adaptive block (`defaultLevel: "normal"`, three keyword groups, no per-tier pin) but keeps `mode: "manual"` as the default so existing installs behave unchanged until operators run `/model-router-reasoning mode adaptive`. The shipped selector is intentionally minimal — no history, no token usage, no cross-session learning; see [Adaptive mode](#adaptive-mode) for the full contract and the workaround list.

---

## Verification

Per [plans/010-adaptive-reasoning.md](../../plans/010-adaptive-reasoning.md) (infrastructure) and [plans/015-adaptive-reasoning-engine.md](../../plans/015-adaptive-reasoning-engine.md) (selector engine):

| Layer | Tests |
|---|---|
| Unit — inference | `test/unit/reasoning-capability.test.ts` — all 4 shapes incl. positional-vs-named variant split. |
| Unit — translation | `test/unit/reasoning-translate.test.ts` — every capability × level; `none` always `null`; 2-level discrete clamping; field routing. |
| Unit — adaptive selector | `test/unit/adaptive-selector.test.ts` — every `selectAdaptiveLevel` branch: no-config → `null`; trivial; tierDefaults; keyword priority (first match wins); case-insensitivity; description-only match; default fallback; empty inputs; deterministic. |
| Unit — policy | `test/unit/reasoning-policy.test.ts` — `static` ALWAYS null; `manual`+override applies; `adaptive` precedence (session override wins → selector → `defaultLevel` → null); `surfaceLimits` does NOT alter resolved patch. |
| Unit — agent wiring | `test/unit/router-agents.test.ts` — `applyReasoningPatch` + `restoreAgentBaseline` round-trip; `none`-capability NEVER mutated; `resolveReasoningOverride` accepts the new 4-param `signals` argument. |
| Unit — command | `test/unit/router-commands.test.ts` — `/model-router-reasoning` validates level, persists `mode static|manual|adaptive`, sets/clears store, names capability. |
| Unit — hooks | `test/unit/plugin-hooks.test.ts` — `handleConfig` captures baseline; `tool.execute.before/after` patch/restore; under `mode: "adaptive"`, threads `AdaptiveSignals` into the resolver and emits `reasoning.adaptive_selected` when `surfaceDecision: true`. |

Run:

```bash
pnpm test -- adaptive-selector reasoning router-agents router-commands plugin-hooks
```