# Plan 002: Add tests for runtime.ts and agents.ts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat bd1cd89..HEAD -- src/plugin/runtime.ts src/router/agents.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (but benefits from landing after 001 so the delegate helper is stable)
- **Category**: tests
- **Planned at**: commit `bd1cd89`, 2026-06-29

## Why this matters

Two source files in the router/plugin core have **zero dedicated test coverage**:
`src/plugin/runtime.ts` (173 lines — the hook assembly factory that wires every
OpenCode hook to its handler) and `src/router/agents.ts` (90 lines — the tier
agent registration that populates `opencodeConfig.agent`). Both are on the
critical path: `runtime.ts` is the composition root that returns the `Hooks`
object OpenCode calls into, and `agents.ts` decides which model each subagent
tier runs as. A regression in either breaks the plugin silently — there is no
existing test that would catch a broken hook wiring or a missing Claude prefix.
Characterization tests here also de-risk the `delegate.ts` refactor that a
future plan will need.

## Current state

**Files under test:**

- `src/plugin/runtime.ts` — exports `assembleRuntimeHooks(ctx, activeTiersAtLoad, enableDelegateTool): Hooks`. Returns an object with hook keys: `tool` (conditional on `enableDelegateTool`), `chat.params`, `chat.message`, `tool.execute.before`, `tool.execute.after`, `experimental.text.complete`, `event`, `config`, `experimental.chat.system.transform`, `command.execute.before`, and `dispose`.

  Key behaviours to test (from `runtime.ts`):
  - Line 88-110: when `enableDelegateTool` is `false`, the returned `tool` object has NO `delegate` key. When `true`, it has a `delegate` tool with `description`, `args.task` (required string), `args.tier` (optional string), `args.acceptance` (optional string), and an `execute(args, context)` that calls `executeDelegate(ctx, args, context.sessionID, context.abort)`.
  - Line 154-171: `dispose()` is idempotent and calls `ctx.dispose()`, emitting lifecycle shutdown events.

- `src/router/agents.ts` — exports `registerTierAgents(opencodeConfig, activeTiers, cfg): void` and `buildAgentOptions(tier): Record<string, unknown>`.

  Key behaviours to test (from `agents.ts`):
  - Line 50-89: iterates `activeTiers` and writes one entry per tier to `opencodeConfig.agent[name]`.
  - Line 54: per-tier prompt resolution — `tier.prompt` overrides `cfg.tierPrompts[name]`.
  - Line 60-66: when `isClaudeModel(tier.model)` is true, the prompt is prefixed with `CLAUDE_TIER_PREFIX[name]` + `CLAUDE_ANTI_NARRATION`; otherwise the prompt is used as-is.
  - Line 68-75: the agent def always includes `model`, `mode: "subagent"`, `description`, `maxSteps`, `prompt`, `color`.
  - Line 78-85: `variant` is added only when present; `options` is added only when `buildAgentOptions` returns a non-empty object.
  - `buildAgentOptions` (lines 8-29): maps `tier.thinking.budgetTokens` → `budget_tokens`; `tier.reasoning.effort` → `reasoning_effort`; `tier.reasoning.summary` → `reasoning_summary`. Returns `{}` when none are set.

**Repo test conventions:**
- Test framework: Vitest. Test files live in `test/unit/` named `<module-name>.test.ts`.
- Pattern to model after: `test/unit/plugin-hooks.test.ts` (624 lines) — uses a `makeHarness()` builder that constructs a fake `PluginContext` with spy stores. Also `test/unit/plugin-context.test.ts` for the `createPluginContext` wiring pattern.
- Tests use `vi.fn()`, `vi.spyOn()`, `expect().toContain()`, `expect().toBe()`.
- Every test file sets up `tmpHome`/`tmpCwd` in `beforeEach` and restores env in `afterEach` (see `plugin-hooks.test.ts:72-99`). Match this exactly.
- `import type { PluginContext } from "../../src/plugin/context"` is the canonical import path for the context type.

**Types to import:**
- `import { assembleRuntimeHooks } from "../../src/plugin/runtime"`
- `import { registerTierAgents, buildAgentOptions } from "../../src/router/agents"`
- `import type { Hooks } from "@opencode-ai/plugin"` (for asserting the returned shape)
- `import type { Preset, RouterConfig } from "../../src/router/config"`

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                     | exit 0, no errors   |
| Tests     | `pnpm test -- plugin-runtime`        | all pass            |
| Tests     | `pnpm test -- router-agents`         | all pass            |
| Lint      | `pnpm lint`                          | exit 0              |

## Scope

**In scope** (the only files you should create/modify):
- `test/unit/plugin-runtime.test.ts` (create)
- `test/unit/router-agents.test.ts` (create)

**Out of scope** (do NOT touch):
- `src/plugin/runtime.ts`, `src/router/agents.ts` — source unchanged; this plan only adds tests.
- Any existing test file.
- `vitest.config.ts` — coverage thresholds are intentionally non-failing (Wave 0); do not change them.

## Git workflow

- Branch: `advisor/002-tests-runtime-agents`
- Commit per test file; message style (conventional commits): `test(runtime): add hook assembly characterization tests`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write `test/unit/router-agents.test.ts` (start with the simpler module)

Create the file. Use the `tmpHome`/`tmpCwd` setup boilerplate from `plugin-hooks.test.ts:72-99` (copy it verbatim — every test file in this repo does this).

Write these test cases:

**`describe("registerTierAgents")`**:
1. `"populates opencodeConfig.agent with one entry per active tier"` — pass a Preset with `fast` and `medium` tiers; assert `Object.keys(opencodeConfig.agent)` has length 2 and contains both names.
2. `"each agent def includes model, mode subagent, description, maxSteps, prompt, color"` — assert the six required fields are present and correctly typed.
3. `"per-tier prompt overrides cfg.tierPrompts[name]"` — set both `tier.prompt` and `cfg.tierPrompts[name]`; assert the def's `prompt` equals `tier.prompt`.
4. `"falls back to cfg.tierPrompts[name] when tier.prompt is absent"` — omit `tier.prompt`; assert the def's `prompt` equals `cfg.tierPrompts[name]`.
5. `"prepends Claude tier prefix for Claude-backed tier models"` — use model `"anthropic/claude-haiku-4-5"`; assert the prompt starts with the `CLAUDE_TIER_PREFIX` content (import it from `src/router/protocol`).
6. `"does NOT prepend Claude prefix for non-Claude models"` — use model `"openai/gpt-4o"`; assert the prompt equals the resolved prompt with no prefix.
7. `"adds variant only when tier.variant is present"` — one tier with `variant: "thinking"`, one without; assert the first has `agentDef.variant` and the second does not.
8. `"adds options only when buildAgentOptions returns non-empty"` — one tier with `thinking.budgetTokens`, one without; assert the first has `agentDef.options.budget_tokens` and the second has no `options` key.
9. `"does not throw when opencodeConfig.agent is undefined (initialises it)"` — pass `{}`; assert it does not throw.

**`describe("buildAgentOptions")`**:
1. `"maps thinking.budgetTokens to budget_tokens"` — assert `{ budget_tokens: 4096 }`.
2. `"maps reasoning.effort and reasoning.summary"` — assert both keys present.
3. `"returns empty object when tier has no thinking or reasoning config"` — assert `{}`.
4. `"returns empty object when thinking/reasoning are present but have no set fields"` — assert `{}`.

Use a helper to build a minimal `RouterConfig` (model after the `baseConfig` in `plugin-delegate.test.ts:114-148`).

**Verify**: `pnpm test -- router-agents` → all pass.

### Step 2: Write `test/unit/plugin-runtime.test.ts`

Create the file. Copy the `tmpHome`/`tmpCwd` setup boilerplate from `plugin-hooks.test.ts:72-99`. Build a minimal fake `PluginContext` (model after the `makeHarness()` builder in `plugin-hooks.test.ts:119-223`).

Write these test cases:

**`describe("assembleRuntimeHooks — hook shape")`**:
1. `"returns an object with all expected hook keys"` — call `assembleRuntimeHooks(ctx, preset, false)`; assert the result has keys: `tool`, `chat.params`, `chat.message`, `tool.execute.before`, `tool.execute.after`, `experimental.text.complete`, `event`, `config`, `experimental.chat.system.transform`, `command.execute.before`, `dispose`.
2. `"every hook value is a function (or object for tool)"` — assert each is callable.

**`describe("assembleRuntimeHooks — delegate tool gating")`**:
1. `"omits the delegate tool when enableDelegateTool is false"` — assert `"delegate" in result.tool` is false.
2. `"includes the delegate tool when enableDelegateTool is true"` — assert `"delegate" in result.tool` is true; assert `result.tool.delegate.description` is a string; assert `result.tool.delegate.args.task` exists.
3. `"delegate tool execute calls executeDelegate with ctx, args, sessionID, abort"` — this is a wire-up contract test. Spy on `executeDelegate` by mocking `../../src/plugin/delegate` (use the `vi.mock` pattern from `plugin-delegate.test.ts:27-31`). Invoke `result.tool.delegate.execute(args, context)` and assert `executeDelegate` was called with `(ctx, args, context.sessionID, context.abort)`.

**`describe("assembleRuntimeHooks — dispose")`**:
1. `"dispose calls ctx.dispose exactly once"` — spy on `ctx.dispose`; await `result.dispose()`; assert called once.
2. `"dispose is idempotent — second call does not throw"` — await `result.dispose()` twice; assert no throw.
3. `"dispose logs lifecycle shutdown event on success"` — (best-effort; if the logger is hard to spy, assert `ctx.dispose` was called and no error thrown).

**`describe("assembleRuntimeHooks — handler wiring")`**:
1. `"command.execute.before forwards input.command and input.arguments to handleCommandBefore"` — mock `../../src/router/commands` and spy on `handleCommandBefore`. Invoke the hook with `{ command: "tiers", arguments: "" }` and an output `{ parts: [] }`; assert the spy received `{ command: "tiers", arguments: "" }`.
2. `"chat.params forwards to handleChatParams with ctx"` — mock `../../src/plugin/hooks` and spy. Invoke; assert spy called with `(ctx, <input payload>, <output payload>)`.

**Verify**: `pnpm test -- plugin-runtime` → all pass.

## Test plan

- Two new test files: `test/unit/router-agents.test.ts` (~15 test cases) and `test/unit/plugin-runtime.test.ts` (~12 test cases).
- Pattern to model after: `test/unit/plugin-hooks.test.ts` for the harness builder and env setup; `test/unit/plugin-delegate.test.ts:27-31` for the `vi.mock` spy pattern.
- Verification: `pnpm test -- router-agents && pnpm test -- plugin-runtime` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- router-agents` exits 0; new file `test/unit/router-agents.test.ts` exists with ≥10 test cases
- [ ] `pnpm test -- plugin-runtime` exits 0; new file `test/unit/plugin-runtime.test.ts` exists with ≥8 test cases
- [ ] `pnpm lint` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The exports `assembleRuntimeHooks`, `registerTierAgents`, or `buildAgentOptions` don't exist at the paths in "Current state" (the codebase has drifted).
- The `Hooks` type from `@opencode-ai/plugin` doesn't include one of the expected hook keys — report which keys exist.
- A step's verification fails twice after a reasonable fix attempt.
- Mocking `executeDelegate` or `handleCommandBefore` via `vi.mock` does not work because of an ESM import constraint — report the constraint.

## Maintenance notes

- These are characterization tests — they lock the current wiring. When a hook is added or renamed in `runtime.ts`, the corresponding test must be updated.
- The delegate-tool gating tests (enable/disable) are the most valuable: they prevent accidentally shipping the experimental delegate tool enabled-by-default.
- A reviewer should check that the tests do NOT depend on real disk I/O beyond the `tmpHome`/`tmpCwd` setup (no reads of the real bundled `tiers.json`).
