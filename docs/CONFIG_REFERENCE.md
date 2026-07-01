# Configuration Reference

Top-level `tiers.json` fields. All blocks are optional and additive; omitting a block (or setting the equivalent no-op value) preserves the pre-Plan-010 behaviour byte-for-byte.

**Cross-references:** [ENFORCEMENT.md](./ENFORCEMENT.md) · [REASONING.md](./REASONING.md) · [VERIFICATION.md](./VERIFICATION.md) · [ESCALATION.md](./ESCALATION.md) · [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md)

---

## Top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"off" \| "advisory" \| "enforced"` | `"off"` | Global enforcement mode. `off` = no-op. `advisory` = log violations, never block. `enforced` = block/escalate on violations. |
| `envGate` | `string` | `"MODEL_ROUTER_ENFORCE"` | Name of the env var that overrides mode at runtime. See env-gate truth table below. |
| `perTier` | `Record<string, "off" \| "advisory" \| "enforced">` | `{}` | Per-tier mode overrides. Keyed by tier name. Overrides base `mode` when the env gate is unset/empty. |
| `guard` | object | see below | Request-level hard guards (caps, script controls, budget). |
| `verify` | object | see below | Verification / grading policy. |
| `escalate` | object | see below | Escalation ladder and cost ceiling. |
| `proportional` | object | see below | Trivial-task bypass logic. |

---

## `guard`

| Field | Type | Default | Notes |
|---|---|---|---|
| `readDraftCap` | `number` | `3` | Max read-only tool calls before an edit must begin. |
| `sameOpRetryCap` | `number` | `1` | Max retries of the identical operation before escalation. |
| `blockSelfScript` | `boolean` | `true` | Block agent-written scripts that target the router's own config files. |
| `deliverableFirst` | `boolean` | `true` | Require a concrete deliverable token before prose commentary. |
| `budget` | `number` | `25` | Soft cost-unit ceiling per attempt. Must be ≥ 1. |
| `blockScriptWrites` | `boolean` | `false` | Block all script-write operations regardless of target. Must be a boolean. |

---

## `verify`

| Field | Type | Default | Notes |
|---|---|---|---|
| `require` | `"never" \| "whenDoDPresent" \| "always"` | `"whenDoDPresent"` | When to run a verification pass after production. |
| `requireExplicitDoD` | `boolean` | `false` | When `true`, a task with no explicit Definition of Done is treated as failing verification. |
| `preferDeterministic` | `boolean` | _(auto)_ | Defaults to `true` whenever the DoD contains runnable checks; omit to let the router decide. |
| `graderPolicy` | `"atLeastProducerTier"` | `"atLeastProducerTier"` | **Only valid value.** Grader tier = `max(producerTier, minGraderTier)` along the ladder; never below the producer. A deterministic check uses no grader. |
| `graderTemperature` | `number` | `0` | Applied via the `chat.params` hook to grader sessions only. |
| `minGraderTier` | `string` | _(none)_ | Optional floor for the grader tier, independent of producer. |

> **Note:** `graderPolicy: "atLeastProducerTier"` ensures a cheap producer is never graded by an even cheaper model. A deterministic DoD check (shell command, test run, lint) skips the grader entirely.

---

## `escalate`

| Field | Type | Default | Notes |
|---|---|---|---|
| `floorTier` | `string \| null` | `null` | Pin the minimum starting tier; skips cheaper rungs. Must be string or `null`. |
| `ladder` | `string[]` | `["fast","medium","heavy"]` | Ordered list of tier names to escalate through. Must be an array of strings. |
| `maxAttemptsPerTier` | `number` | `1` | Max attempts at each rung before advancing. Must be integer ≥ 0. |
| `maxTotalAttempts` | `number` | `4` | Hard ceiling across all tiers and retries. Must be integer ≥ 1. |
| `costCeiling.base` | `string` | `"firstAttemptCostUnits"` | Reference point for cost ceiling. `"firstAttemptCostUnits"` = cost of the first producing attempt. |
| `costCeiling.multiple` | `number` | `4` | Ceiling = `base × multiple`. Must be > 0. Escalation halts when cumulative cost would exceed this. |

> **`floorTier`** is useful when a task is known non-trivial: set `floorTier: "medium"` to skip `fast` entirely.  
> **`costCeiling`** is evaluated before each escalation step; the attempt is not started if it would breach the ceiling.

---

## `proportional`

| Field | Type | Default | Notes |
|---|---|---|---|
| `trivialBypass` | `boolean` | `true` | When `true`, tasks classified as trivial skip enforcement and route to `fast` directly. |
| `trivialClassifier` | `string` | `"dispatchIntent"` | Classifier strategy used to detect trivial tasks. |

> **Note:** `trivialBypass` defaults `true` but trivial classification is tier-gated to `fast` and biased toward non-trivial. Real work is never silently downgraded.

---

## `reasoningPolicy`

Optional top-level block in `tiers.json`. Fully additive — omitting the block resolves to `mode: "static"`, which is a hard no-op (the policy resolver returns `null` regardless of any session override, and the agent def is left exactly as `registerTierAgents` produced it). The bundled default since Plan 010 PR 3 is `mode: "manual"`, which lets the `/reasoning` command apply session-scoped overrides.

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"static" \| "manual" \| "adaptive"` | `"static"` when the block is absent, `"manual"` in the bundled `base.json` | See [Policy modes](#policy-modes) below. |
| `defaultLevel` | `"minimal" \| "normal" \| "elevated" \| "max"` | _(none)_ | Optional fallback applied under `manual` mode when the session has no override. |
| `surfaceLimits` | `boolean` | `false` | When `true`, `/reasoning` output and the runtime log layer flag tiers that cannot satisfy the requested level. See [REASONING.md → surfaceLimits](./REASONING.md#surfacelimits). |

### Policy modes

| Mode | Behaviour |
|---|---|
| `static` | The policy resolver ALWAYS returns `null`. Even when a session override exists, the agent def is left exactly as `registerTierAgents` produced it. Use this to restore pre-Plan-010 byte-identical behaviour. |
| `manual` | Translates `sessionOverride ?? defaultLevel` through the tier's `capability` (or `inferCapability(tier)` when no capability is declared). When both are undefined, returns `null`. |
| `adaptive` | Stub. Returns `null`. A follow-up plan will wire an adaptive engine that picks a level from task-class / risk signals. |

### Per-tier `capability`

Optional field on every tier (`presets[<name>].<tier>.capability`). Authoritative when present; otherwise `inferCapability(tier)` walks `reasoning.effort`, `thinking.budgetTokens`, then `variant` (positional vs named split) and returns the inferred shape.

| `kind` | `field` | Shape | When to use |
|---|---|---|---|
| `none` | _(omitted)_ | `{ kind: "none" }` | The tier exposes no reasoning control. Router never mutates it. |
| `binary` | `"variant"` | `{ kind: "binary"; field: "variant"; baseline?: string; elevated: string }` | Two-state toggle (e.g. default ↔ `thinking`, default ↔ `max`). `minimal`/`normal` resolve to `baseline` (or `null` if omitted); `elevated`/`max` resolve to `elevated`. |
| `discrete` | `"variant"` _or_ `"reasoning.effort"` | `{ kind: "discrete"; field: ...; levels: string[] }` | N-state ladder (e.g. `[low, medium, high]` or `[low, medium, high, xhigh]`). The `field` discriminator picks the output channel. |
| `budgeted` | `"thinking.budgetTokens"` | `{ kind: "budgeted"; field: "thinking.budgetTokens"; recommended: Record<level, number> }` | Token-budget ladder. `recommended` MUST cover all four levels. |

### Minimal example

```jsonc
{
  "reasoningPolicy": {
    "mode": "manual",
    "surfaceLimits": false
  },
  "presets": {
    "multi-provider": {
      "fast": {
        "model": "opencode-go/mimo-v2.5",
        "variant": "medium",
        "capability": { "kind": "discrete", "field": "variant", "levels": ["low", "medium", "high"] }
      },
      "medium": {
        "model": "minimax/MiniMax-M3",
        "variant": "thinking",
        "capability": { "kind": "binary", "field": "variant", "elevated": "thinking" }
      },
      "heavy": {
        "model": "openai/gpt-5.4",
        "reasoning": { "effort": "high", "summary": "detailed" },
        "capability": { "kind": "discrete", "field": "reasoning.effort", "levels": ["low", "medium", "high"] }
      }
    }
  }
}
```

All fields are optional. A config with no `reasoningPolicy` block and no per-tier `capability` declarations is byte-identical to pre-Plan-010 behaviour. See [REASONING.md](./REASONING.md) for the full capability model, normalized level vocabulary, translation rules, and the documented 3-level-ladder collapse quirk.

---

## Env-gate truth table

Env var name: value of `enforcement.envGate` (default `MODEL_ROUTER_ENFORCE`).  
Evaluated by `resolveEnforcementMode` on every dispatch.

| Env var value | Resolved mode | Notes |
|---|---|---|
| `"1"` | `"enforced"` | Hard override. Ignores `mode` **and** `perTier`. |
| `"0"` | `"off"` | Hard override. Ignores `mode`. |
| unset or `""` | config `mode`, with `perTier[tier]` taking precedence when present | Normal path. |
| any other value | config `mode` (fallback) | Emits one-time warning: `<gate>="<value>" is not "1" or "0"; ignoring env gate and using config.` |

---

## Validation rules

`validateConfig` throws on `tiers.json` load if any of these are violated:

| Rule |
|---|
| `mode` must be one of `off \| advisory \| enforced`. |
| `verify.graderPolicy` (when `verify` is an object) must be exactly `"atLeastProducerTier"`. |
| `escalate.costCeiling.multiple` must be a number > 0. |
| `escalate.ladder` must be an array of strings. |
| `escalate.maxAttemptsPerTier` must be an integer ≥ 0. |
| `escalate.maxTotalAttempts` must be an integer ≥ 1. |
| `escalate.floorTier` must be string or `null`. |
| `perTier` values must each be `off \| advisory \| enforced`. |
| `guard.budget` must be a number ≥ 1. |
| `guard.blockScriptWrites` must be a boolean. |

---

## How to enable

Three independent mechanisms; env gate always wins:

1. **Config** — set `enforcement.mode` in `tiers.json` (persisted, version-controlled).
2. **Env var** — `MODEL_ROUTER_ENFORCE=1` (forces `enforced`) or `=0` (forces `off`). Overrides config and `/router` state.
3. **Runtime command** — `/router enforce <off|advisory|enforced>` (written to the router state file; env gate still overrides).

---

## Minimal example

```jsonc
// tiers.json (enforcement block only; all other tier config omitted)
{
  "enforcement": {
    "mode": "advisory",
    "envGate": "MODEL_ROUTER_ENFORCE",
    "perTier": {
      "fast": "off"
    },
    "guard": {
      "readDraftCap": 5,
      "budget": 50,
      "blockScriptWrites": false
    },
    "verify": {
      "require": "whenDoDPresent",
      "graderPolicy": "atLeastProducerTier",
      "graderTemperature": 0
    },
    "escalate": {
      "floorTier": null,
      "ladder": ["fast", "medium", "heavy"],
      "maxAttemptsPerTier": 1,
      "maxTotalAttempts": 4,
      "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 4 }
    },
    "proportional": {
      "trivialBypass": true,
      "trivialClassifier": "dispatchIntent"
    }
  }
}
```

All fields are optional. An empty `{}` or omitted block is a no-op.
