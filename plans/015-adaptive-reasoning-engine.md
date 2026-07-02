# Plan 015: Ship an adaptive reasoning engine as a deterministic, config-driven selector

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat da921e5..HEAD -- src/reasoning/policy.ts src/reasoning/adaptive.ts src/router/config.types.ts src/router/config-state.ts src/router/config-loader.ts src/router/commands.ts src/plugin/hooks.ts src/plugin/types.ts config/tiers/base.json docs/REASONING.md test/unit/reasoning-policy.test.ts test/unit/plugin-hooks.test.ts test/unit/router-commands.test.ts test/unit/adaptive-selector.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 010 (infrastructure — DONE), Plan 014 (runtime mode switch — DONE)
- **Category**: direction
- **Planned at**: commit `da921e5`, 2026-07-01

## Why this matters

The reasoning infrastructure (Plan 010) shipped a capability model, translation
layer, policy resolver, override store, and `/model-router-reasoning` command —
but `adaptive` mode is still a stub that returns `null` (`policy.ts:57`). Every
runtime path rejects or no-ops it, and the command surface blocks it with "not
implemented yet" (`commands.ts:323-329`).

This plan ships a **deterministic, config-driven adaptive selector** — the
minimal engine that picks a reasoning level from real signals available at
dispatch time. It is deliberately NOT an LLM-driven or analytics-heavy engine:
those depend on conversation history, token usage, and cross-session learning
that the plugin does not expose today.

When this lands, operators can switch to `adaptive` mode and let the router
escalate reasoning for risky tasks automatically, while keeping `static` and
`manual` modes byte-identical.

## Current state

### The stub that must be replaced

`src/reasoning/policy.ts:48-64` — the single policy gate. The mode check at
line 57 is where adaptive falls through to `null`:

```ts
export const resolveReasoningOverride = (
  tier: TierConfig,
  policy: ReasoningPolicyConfig | undefined,
  sessionOverride?: ReasoningLevel,
): ResolvedReasoning => {
  const mode = policy?.mode ?? "static";
  // Primary regression guard: static mode is a hard no-op, regardless of any
  // session override.
  if (mode !== "manual") return null;   // ← adaptive falls through here

  const level = sessionOverride ?? policy?.defaultLevel;
  if (!level) return null;

  const cap = tier.capability ?? inferCapability(tier);
  return translateLevel(cap, level);
};
```

The file header at `policy.ts:19-22` documents the stub:
```
//   - `adaptive` → STUB. Returns null. A future plan will wire an adaptive
//                  engine that picks the level based on task class / risk
//                  signals.
```

### Config shape — no adaptive config exists

`src/router/config.types.ts:101-105`:

```ts
export interface ReasoningPolicyConfig {
  mode?: "static" | "manual" | "adaptive";
  defaultLevel?: import("../reasoning/capability.js").ReasoningLevel;
  surfaceLimits?: boolean;
}
```

No thresholds, keyword rules, or tier defaults for adaptive exist. There is no
`adaptive` config block.

### State overlay deliberately excludes adaptive

`src/router/config.types.ts:128-139`:

```ts
export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
  reasoningMode?: "static" | "manual";   // ← no adaptive
}
```

`src/router/config-state.ts:176-178`:

```ts
export const saveReasoningMode = async (mode: "static" | "manual"): Promise<void> => {
  await writeState({ reasoningMode: mode });
};
```

`src/router/config-loader.ts:229` narrows the overlay guard:

```ts
const REASONING_PERSISTED_MODES = ["static", "manual"] as const;
```

### Command surface rejects adaptive

`src/router/commands.ts:323-329`:

```ts
if (modeArg === "adaptive") {
  return [
    "**adaptive** is not implemented yet.",
    "",
    "Available modes: `static`, `manual`.",
    "When the adaptive engine ships, this command will accept `adaptive` as a value.",
  ].join("\n");
}
```

The usage hint at `commands.ts:304-308` also says "not implemented yet".

### Hook wiring — task prompt is available but not extracted

`src/plugin/hooks.ts:124-152` reads only `subagent_type` from the task args:

```ts
const subagentType = (output?.args as Record<string, unknown> | undefined)?.subagent_type as
  | string
  | undefined;
```

But `src/plugin/types.ts:111-125` already provides `asTaskToolArgs`, which
extracts `{ subagent_type, prompt, description }`:

```ts
export const asTaskToolArgs = (args: unknown): TaskToolArgs | null => {
  if (!args || typeof args !== "object") return null;
  const rec = args as Record<string, unknown>;
  const out: TaskToolArgs = {};
  if (typeof rec.subagent_type === "string") out.subagent_type = rec.subagent_type;
  if (typeof rec.prompt === "string") out.prompt = rec.prompt;
  if (typeof rec.description === "string") out.description = rec.description;
  return out;
};
```

The prompt and description fields are the primary text signals for adaptive
classification — they just need to be threaded into the hook.

### Test that locks the stub

`test/unit/reasoning-policy.test.ts:123-133`:

```ts
describe("resolveReasoningOverride — adaptive mode (stub)", () => {
  const tier = baseTier({ variant: "thinking" });

  it("returns null for every level under adaptive mode", () => {
    const policy: ReasoningPolicyConfig = { mode: "adaptive" };
    const levels: ReasoningLevel[] = ["minimal", "normal", "elevated", "max"];
    for (const level of levels) {
      expect(resolveReasoningOverride(tier, policy, level)).toBeNull();
    }
  });
});
```

This test must be replaced with real adaptive behavior assertions.

### What must NOT change

- `src/reasoning/translate.ts:49-82` — `translateLevel` is the provider
  translation layer. The adaptive engine picks a normalized `ReasoningLevel`;
  translation stays untouched.
- `src/reasoning/store.ts` — the override store and per-tier in-flight guard
  are mode-agnostic. They stay as-is.
- `static` mode behavior — always returns `null`. This is the regression guard.
- `manual` mode behavior — resolves `sessionOverride ?? defaultLevel`. Unchanged.

### Repo conventions

- Pure functions live in `src/reasoning/` (see `policy.ts`, `translate.ts`,
  `capability.ts`). The adaptive selector follows the same pattern: pure, no
  IO, no side effects, no module-level state.
- Config types live in `src/router/config.types.ts` with JSDoc on every field.
- Tests use Vitest (`describe`/`it`/`expect` from `vitest`). Test files mirror
  `src/` paths under `test/unit/`. Model after `test/unit/reasoning-policy.test.ts`.
- Verification commands: `pnpm typecheck`, `pnpm test`, `pnpm lint` (Biome).

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Install   | `pnpm install`                   | exit 0              |
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Targeted  | `pnpm test -- test/unit/adaptive-selector.test.ts test/unit/reasoning-policy.test.ts test/unit/plugin-hooks.test.ts test/unit/router-commands.test.ts` | all pass |
| Full      | `pnpm test`                      | all pass            |
| Lint      | `pnpm lint`                      | exit 0              |

## Scope

**In scope**
- `src/reasoning/adaptive.ts` (create — the selector)
- `src/reasoning/policy.ts` (wire adaptive branch)
- `src/router/config.types.ts` (add adaptive config shape, widen RouterState)
- `src/router/config-state.ts` (widen saveReasoningMode)
- `src/router/config-loader.ts` (widen persisted-mode guard)
- `src/router/commands.ts` (accept adaptive in command, update usage text)
- `src/plugin/hooks.ts` (extract task args, thread signals to resolver)
- `config/tiers/base.json` (ship adaptive defaults)
- `docs/REASONING.md` (replace "deferred" with real docs)
- `test/unit/adaptive-selector.test.ts` (create — selector unit tests)
- `test/unit/reasoning-policy.test.ts` (replace stub test with real assertions)
- `test/unit/plugin-hooks.test.ts` (add adaptive-path tests)
- `test/unit/router-commands.test.ts` (accept-adaptive test)
- `plans/README.md` (add plan row, mark Plan 010 DONE)

**Out of scope**
- LLM-based adaptive reasoning (prompt injection, orchestrator reassessment)
- Cross-session learning / persistent analytics / cost ledgers
- Token-usage-based scoring
- Conversation-history analysis
- Changes to `translateLevel`, `capability.ts`, or the override store
- Changes to `static` or `manual` mode behavior
- CI/workflow changes

## Steps

### Step 1: Define the adaptive config shape and selector types

Extend `ReasoningPolicyConfig` with an optional `adaptive` block, and define
the signal and result types the selector will use.

**Change details**

In `src/router/config.types.ts`, add after the existing
`ReasoningPolicyConfig` interface (`:101-105`):

```ts
export interface AdaptivePolicyConfig {
  /** Level for tasks the classifier marks trivial. `undefined` → no patch. */
  trivialLevel?: ReasoningLevel;
  /** Level for non-trivial tasks that match no keyword rule. */
  defaultLevel?: ReasoningLevel;
  /**
   * Keyword rules: each entry maps a set of case-insensitive substrings to a
   * level. First match wins (array order = priority). Example:
   *   [{ keywords: ["refactor", "architecture", "security"], level: "elevated" }]
   */
  keywordRules?: { keywords: string[]; level: ReasoningLevel }[];
  /** Per-tier default override. Keyed by tier name. Wins over `defaultLevel`. */
  tierDefaults?: Record<string, ReasoningLevel>;
  /** When true, emit debug logs for every adaptive decision (selected level + reason). */
  surfaceDecision?: boolean;
}
```

Extend `ReasoningPolicyConfig` to carry it:

```ts
export interface ReasoningPolicyConfig {
  mode?: "static" | "manual" | "adaptive";
  defaultLevel?: ReasoningLevel;
  surfaceLimits?: boolean;
  adaptive?: AdaptivePolicyConfig;
}
```

Add the selector signal type (place in `src/reasoning/adaptive.ts` — see Step 2):

```ts
export interface AdaptiveSignals {
  /** Lowercased task prompt text from the Task tool args. May be empty. */
  prompt: string;
  /** Lowercased task description from the Task tool args. May be empty. */
  description: string;
  /** The tier name being dispatched (e.g. "medium", "heavy"). */
  tierName: string;
  /** Whether the session was classified as trivial at dispatch time. */
  isTrivial: boolean;
}

export interface AdaptiveDecision {
  level: ReasoningLevel | null;
  reason: string;
}
```

Widen `RouterState.reasoningMode` to include `adaptive`:

```ts
reasoningMode?: "static" | "manual" | "adaptive";
```

Update the JSDoc above it to remove the "intentionally absent" note and state
that `adaptive` is now supported.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Build the pure selector module

Create `src/reasoning/adaptive.ts` — a deterministic, pure function that maps
signals + config to a `ReasoningLevel | null`.

**Change details**

The selector's decision order (first match wins):

1. If `policy.adaptive` is absent entirely → return `{ level: null, reason: "no adaptive config" }`.
2. If `signals.isTrivial` is true → return `policy.adaptive.trivialLevel` (or `null` if unset).
3. If `policy.adaptive.tierDefaults[signals.tierName]` exists → return that level.
4. Scan `policy.adaptive.keywordRules` in order: if any keyword is found in
   `prompt` or `description` (case-insensitive substring match) → return that rule's level.
5. Return `policy.adaptive.defaultLevel` (or `null` if unset).

Export a single function:

```ts
export const selectAdaptiveLevel = (
  signals: AdaptiveSignals,
  policy: ReasoningPolicyConfig | undefined,
): AdaptiveDecision => { ... };
```

**File header** — follow the same comment style as `policy.ts` and
`translate.ts`: module purpose, purity contract, decision order, and a note
that this is the ONLY place adaptive selection logic lives.

**Why this design**
- Every input is already available at dispatch time (no new infrastructure).
- The decision is deterministic and fully testable.
- Operators configure behavior declaratively; no hidden heuristics.
- `null` at any step means "no patch" — the agent def stays at baseline.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Wire adaptive into the policy resolver

Replace the stub branch in `resolveReasoningOverride`.

**Change details**

In `src/reasoning/policy.ts`, the current gate at `:57` is:

```ts
if (mode !== "manual") return null;
```

Change to a three-way dispatch:

```ts
const mode = policy?.mode ?? "static";

if (mode === "static") return null;

if (mode === "manual") {
  const level = sessionOverride ?? policy?.defaultLevel;
  if (!level) return null;
  const cap = tier.capability ?? inferCapability(tier);
  return translateLevel(cap, level);
}

// mode === "adaptive"
// Precedence: explicit session override wins, then adaptive selection,
// then policy.defaultLevel, then null.
if (sessionOverride) {
  const cap = tier.capability ?? inferCapability(tier);
  return translateLevel(cap, sessionOverride);
}

const decision = selectAdaptiveLevel(signals, policy);
const level = decision.level ?? policy?.defaultLevel;
if (!level) return null;

const cap = tier.capability ?? inferCapability(tier);
return translateLevel(cap, level);
```

This requires adding a new parameter to `resolveReasoningOverride`:

```ts
export const resolveReasoningOverride = (
  tier: TierConfig,
  policy: ReasoningPolicyConfig | undefined,
  sessionOverride: ReasoningLevel | undefined,
  signals: AdaptiveSignals,   // ← new
): ResolvedReasoning => { ... };
```

Update the file header comment (`:19-22`) to replace the STUB note with a
description of the adaptive engine and its precedence rules.

**Why the precedence**
- An explicit session override (set via `/model-router-reasoning elevated`)
  must always win — operators need certainty when they set it manually.
- Adaptive selection is the automatic path.
- `policy.defaultLevel` is the safety net.

**Verify**: `pnpm typecheck` → exit 0. (Tests will fail until Step 6 — that's expected.)

### Step 4: Thread task signals into the hook

Extract the task prompt and description so the selector has real text to work
with.

**Change details**

In `src/plugin/hooks.ts:127-130`, replace the manual `subagent_type` extraction
with `asTaskToolArgs`:

```ts
import { asTaskToolArgs } from "./types.js";

// inside handleToolExecuteBefore, after the ownership guard:
const taskArgs = asTaskToolArgs(output?.args);
const subagentType = taskArgs?.subagent_type;
const prompt = taskArgs?.prompt ?? "";
const description = taskArgs?.description ?? "";
```

Then at `:152`, update the `resolveReasoningOverride` call to pass the signals:

```ts
const isTrivial = ctx.sessionStore.isTrivial(sid);
const signals: AdaptiveSignals = {
  prompt: prompt.toLowerCase(),
  description: description.toLowerCase(),
  tierName: subagentType,
  isTrivial,
};

const resolved = resolveReasoningOverride(tier, cfg.reasoningPolicy, override, signals);
```

Import `AdaptiveSignals` type from `../reasoning/adaptive.js`.

**Observability** — if `cfg.reasoningPolicy?.adaptive?.surfaceDecision === true`,
emit a debug event when in adaptive mode:

```ts
if (cfg.reasoningPolicy?.mode === "adaptive" && cfg.reasoningPolicy?.adaptive?.surfaceDecision === true) {
  const decision = selectAdaptiveLevel(signals, cfg.reasoningPolicy);
  log.debug({
    event: "reasoning.adaptive_selected",
    session: sid,
    tier: subagentType,
    level: decision.level,
    reason: decision.reason,
  });
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 5: Enable the command surface and widen the persisted overlay

Make `/model-router-reasoning mode adaptive` accepted and persisted.

**Change details**

In `src/router/commands.ts`:
- At `:311`, extend the accepted-mode check: `if (modeArg === "static" || modeArg === "manual" || modeArg === "adaptive")`.
- At `:323-329`, remove the rejection block for `adaptive`.
- Update the usage text at `:304-308` to list all three modes.
- Add adaptive-specific guidance to the success output.

In `src/router/config-state.ts:176`, widen the type:

```ts
export const saveReasoningMode = async (mode: "static" | "manual" | "adaptive"): Promise<void> => {
  await writeState({ reasoningMode: mode });
};
```

In `src/router/config-loader.ts:229`, widen the persisted-mode guard:

```ts
const REASONING_PERSISTED_MODES = ["static", "manual", "adaptive"] as const;
```

Update the JSDoc above it (`:223-228`) to note adaptive is now supported.

**Verify**: `pnpm typecheck` → exit 0.

### Step 6: Ship adaptive defaults in config

Add a minimal, conservative adaptive block to the production config.

**Change details**

In `config/tiers/base.json`, extend the existing `reasoningPolicy` block
(`:10-13`):

```json
"reasoningPolicy": {
  "mode": "manual",
  "surfaceLimits": false,
  "adaptive": {
    "trivialLevel": null,
    "defaultLevel": "normal",
    "keywordRules": [
      { "keywords": ["refactor", "architecture", "security", "migration"], "level": "elevated" },
      { "keywords": ["debug", "diagnose", "investigate", "root cause"], "level": "elevated" },
      { "keywords": ["test", "fix", "patch"], "level": "normal" }
    ],
    "surfaceDecision": false
  }
}
```

The shipped default mode stays `"manual"` — adaptive is opt-in. Operators who
switch to `adaptive` get these defaults unless they override.

**Verify**: `pnpm typecheck && pnpm test` → pass.

### Step 7: Write selector unit tests

Create `test/unit/adaptive-selector.test.ts` covering every decision branch.

**Test cases** (model after `test/unit/reasoning-policy.test.ts`):

- No adaptive config → `{ level: null, reason: "no adaptive config" }`.
- `isTrivial: true` with `trivialLevel: "minimal"` → `minimal`.
- `isTrivial: true` with no `trivialLevel` → `null`.
- `tierDefaults` override for the dispatched tier → that level wins over `defaultLevel`.
- First keyword rule match wins (order priority).
- Keyword found in `description` but not `prompt` → still matches.
- No keyword match → falls through to `defaultLevel`.
- No keyword match and no `defaultLevel` → `null`.
- Empty prompt and description → no keyword match → `defaultLevel`.
- Case-insensitivity: keyword "Refactor" matches prompt "refactoring the auth module".

**Verify**: `pnpm test -- test/unit/adaptive-selector.test.ts` → all pass.

### Step 8: Replace the policy stub test with real adaptive assertions

In `test/unit/reasoning-policy.test.ts:119-133`, replace the stub describe
block.

**Test cases**:

- Adaptive mode with explicit session override → override wins, patch is
  translated through the tier's capability.
- Adaptive mode with no override and no adaptive config → returns `null` (same
  as pre-engine, but now by design, not by stub).
- Adaptive mode with keyword-matched signals → returns the keyword rule's level.
- Adaptive mode, trivial task, `trivialLevel: null` → returns `null`.
- Adaptive mode, non-trivial, no keyword match, `defaultLevel: "normal"` →
  returns `normal` patch.
- Static mode still returns `null` for every level (regression guard — keep
  existing test at `:26-46` unchanged).
- Manual mode still resolves `sessionOverride ?? defaultLevel` (keep existing
  tests unchanged).

**Verify**: `pnpm test -- test/unit/reasoning-policy.test.ts` → all pass.

### Step 9: Add hook and command tests for the adaptive path

In `test/unit/plugin-hooks.test.ts`:
- Adaptive mode dispatch with keyword-matched prompt → patch applied,
  `reasoning.adaptive_selected` event emitted (when `surfaceDecision: true`).
- Adaptive mode dispatch, trivial task → no patch.
- Manual override under adaptive mode → override wins.

In `test/unit/router-commands.test.ts`:
- `/model-router-reasoning mode adaptive` is accepted, persisted, and reports
  adaptive-specific guidance.
- `/model-router-reasoning mode` (no arg) lists all three modes.

**Verify**: `pnpm test -- test/unit/plugin-hooks.test.ts test/unit/router-commands.test.ts` → all pass.

### Step 10: Update docs and plan index

Replace every "deferred / not implemented" reference with real documentation.

**Change details**

In `docs/REASONING.md`:
- Replace the mode table entry for `adaptive` (currently `:111`) with a
  description of the deterministic selector, its signal inputs, and its
  decision order.
- Update the "production release ships manual-mode only" claim (currently
  `:287`) to state that adaptive is now available as an opt-in mode.
- Document the `adaptive` config block (`trivialLevel`, `defaultLevel`,
  `keywordRules`, `tierDefaults`, `surfaceDecision`).
- Document precedence: session override > adaptive > defaultLevel > null.
- Add a section on what adaptive does NOT consider yet (conversation history,
  token usage, cross-session learning) and how to force manual control.

In `plans/README.md`:
- Add the Plan 015 row.
- Mark Plan 010 as DONE (its infrastructure scope is fully shipped; the engine
  is this plan).

**Verify**: `pnpm typecheck && pnpm test` → pass.

## Test plan

- `test/unit/adaptive-selector.test.ts` — every selector branch: trivial,
  tierDefaults, keyword priority, case-insensitivity, fallback, empty inputs.
- `test/unit/reasoning-policy.test.ts` — adaptive precedence (override wins,
  adaptive selection, defaultLevel fallback), static regression guard, manual
  unchanged.
- `test/unit/plugin-hooks.test.ts` — adaptive dispatch applies patch, trivial
  task skips, override wins under adaptive, observability event emitted.
- `test/unit/router-commands.test.ts` — `mode adaptive` accepted and persisted,
  usage lists all three modes.

## Done criteria

- [ ] `adaptive` mode no longer returns `null` unconditionally — the selector runs
- [ ] `/model-router-reasoning mode adaptive` is accepted and persisted across restarts
- [ ] Static mode remains a hard no-op (existing test at `reasoning-policy.test.ts:26-46` passes)
- [ ] Manual mode behavior is unchanged (existing tests pass)
- [ ] Explicit session override wins over adaptive selection
- [ ] `translateLevel` is not modified
- [ ] Adaptive decisions are deterministic and logged when `surfaceDecision` is true
- [ ] `RouterState.reasoningMode` includes `adaptive`; `saveReasoningMode` accepts it
- [ ] `config/tiers/base.json` ships a conservative adaptive block (default mode stays `manual`)
- [ ] `docs/REASONING.md` no longer describes adaptive as deferred
- [ ] `plans/README.md` includes Plan 015 and marks Plan 010 DONE
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm lint` exits 0

## STOP conditions

Stop and report if:
- The code at the cited locations has drifted since `da921e5`.
- `resolveReasoningOverride` has changed signature since `da921e5` — the new
  `signals` parameter depends on the current 3-parameter shape.
- `asTaskToolArgs` does not exist at `src/plugin/types.ts:111` — the hook
  wiring in Step 4 depends on it.
- The team wants LLM-driven adaptive behavior instead of deterministic rules —
  that is a different plan with different infrastructure requirements.
- A step requires touching an out-of-scope file.

## Maintenance notes

- When conversation history or token-usage signals become available in the
  plugin SDK, extend `AdaptiveSignals` and add new decision rules — the
  selector's pure-function design makes this a localized change.
- When adding a new tier, consider whether `tierDefaults` should pin its
  adaptive level — otherwise it falls through to `defaultLevel`.
- The keyword rules are case-insensitive substring matches; if precision
  matters (whole-word, regex), extend `AdaptivePolicyConfig.keywordRules` with
  an optional `mode` field — do not change the selector's core loop.
- The shipped adaptive defaults in `base.json` are intentionally conservative.
  Operators should tune `keywordRules` for their domain.
- `static` mode is the permanent regression guard. Never remove the early
  return at the top of `resolveReasoningOverride`, even after adaptive matures.
