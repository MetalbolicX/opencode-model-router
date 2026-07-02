# Plan 014: Make reasoning control production-ready with runtime mode switching

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If any STOP condition occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat 0e1e19f..HEAD -- src/router/config.types.ts src/router/config-state.ts src/router/config-loader.ts src/router/config.ts src/router/commands.ts src/reasoning/store.ts src/plugin/hooks.ts docs/REASONING.md test/unit/router-commands.test.ts test/unit/plugin-hooks.test.ts test/integration/reasoning-runtime.test.ts test/unit/router-config.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug | tests | docs | dx
- **Planned at**: commit `0e1e19f`, 2026-07-01

## Why this matters

The reasoning feature is usable today, but not production-ready because the policy mode is config-only, the command surface is inconsistent with the rest of the router, dead note plumbing remains in the store, same-tier dispatch overlap is acknowledged but not guarded, and the docs/index are stale. This plan makes the feature operable as a manual-mode release with a runtime mode switch, while keeping `adaptive` explicitly deferred.

## Current state

- `src/router/commands.ts:420-424` registers `/reasoning`.
- `src/router/commands.ts:500-506` dispatches `input.command === "reasoning"` to `buildReasoningOutput`.
- `src/router/commands.ts:249-347` only supports level overrides (`minimal|normal|elevated|max|off`).
- `src/router/commands.ts:293-300` tells users to edit `tiers.json` when policy mode is `static`.
- `src/router/config.types.ts:128-132` has `RouterState` with `activePreset`, `activeMode`, and `enforcementMode` only.
- `src/router/config-state.ts:161-163` persists enforcement mode with `writeState({ enforcementMode })`.
- `src/router/config-loader.ts:232-245` applies the state overlay to config.
- `src/reasoning/store.ts:15-18` says same-tier concurrent patches are unsupported.
- `src/reasoning/store.ts:38,60-68` defines pending-note storage that the runtime never uses.
- `docs/REASONING.md:109-111` documents `adaptive` as a stub.
- `plans/README.md:23` still marks Plan 010 as IN PROGRESS.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Full tests | `pnpm test` | all pass |
| Targeted | `pnpm test -- test/unit/router-commands.test.ts test/unit/plugin-hooks.test.ts test/unit/reasoning-policy.test.ts test/integration/reasoning-runtime.test.ts test/unit/router-config.test.ts` | all pass |
| Lint | `pnpm lint` | exit 0 or accepted baseline |

## Scope

**In scope**
- `src/router/config.types.ts`
- `src/router/config-state.ts`
- `src/router/config-loader.ts`
- `src/router/config.ts`
- `src/router/commands.ts`
- `src/reasoning/store.ts`
- `src/plugin/hooks.ts`
- `docs/REASONING.md`
- `test/unit/router-commands.test.ts`
- `test/unit/plugin-hooks.test.ts`
- `test/integration/reasoning-runtime.test.ts`
- `test/unit/router-config.test.ts`
- `plans/README.md`

**Out of scope**
- Implementing an adaptive reasoning engine
- Changing provider capability translation rules
- CI/workflow changes
- Broad router refactors unrelated to reasoning mode switching

## Steps

### Step 1: Persist `reasoningMode` in the state overlay

Add a persisted reasoning-mode field so runtime mode switches survive restarts, matching the existing enforcement-mode flow.

**Change details**
- In `src/router/config.types.ts`, extend `RouterState` with `reasoningMode?: "static" | "manual"`.
- In `src/router/config-state.ts`, add `saveReasoningMode(mode: "static" | "manual")` beside `saveEnforcementMode`.
- In `src/router/config-loader.ts`, extend `applyStateOverlay()` so `state.reasoningMode` overrides `cfg.reasoningPolicy.mode`.
- In `src/router/config.ts`, re-export `saveReasoningMode` via the barrel.

**Expected shape**
```ts
export const saveReasoningMode = async (mode: "static" | "manual"): Promise<void> => {
  await writeState({ reasoningMode: mode });
};
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Rename the command and add a mode subcommand

Replace `/reasoning` with `/model-router-reasoning` and make it support both level overrides and policy-mode switching.

**Change details**
- In `src/router/commands.ts:420-424`, rename the command registration key to `model-router-reasoning`.
- In `src/router/commands.ts:500-506`, change the dispatch branch to `input.command === "model-router-reasoning"`.
- In `buildReasoningOutput()` (`src/router/commands.ts:249-347`), add a `mode` subcommand:
  - `/model-router-reasoning mode` → show current mode + usage.
  - `/model-router-reasoning mode static` → persist `static`.
  - `/model-router-reasoning mode manual` → persist `manual`.
  - `/model-router-reasoning mode adaptive` → reject with a clear message that adaptive is not implemented.
  - Keep the existing level override behavior for `minimal|normal|elevated|max|off`.
- Import `saveReasoningMode` from `./config`.

**Behavior rules**
- Mode switching is a persisted config overlay, not a per-session override.
- The next message/dispatch picks up the change through the existing config refresh path.
- `adaptive` stays explicitly unavailable until a real engine exists.

**Verify**: `pnpm test -- test/unit/router-commands.test.ts` → pass after test updates in Step 5.

### Step 3: Remove the dead pending-note plumbing

Delete the unused deferred-note path rather than pretending it is a live runtime feature.

**Change details**
- In `src/reasoning/store.ts`, remove the `pendingNotes` Map, `setPendingNote()`, `takePendingNote()`, and any cleanup tied only to pending notes.
- Update the file header comment so it describes only override storage and baselines.
- In `docs/REASONING.md`, remove the claim that a pending note is emitted; replace it with the actual runtime behavior (`log.debug` surfacing only).

**Why this path**
- Wiring the pending-note path would introduce new behavior.
- Removing it keeps the implementation smaller and the docs honest.

**Verify**: `pnpm typecheck && pnpm test -- test/unit/plugin-hooks.test.ts` → pass.

### Step 4: Add same-tier in-flight protection

Prevent two concurrent dispatches from silently patching and restoring the same tier out of order.

**Change details**
- Add per-tier in-flight ownership tracking to `src/reasoning/store.ts`.
- In `src/plugin/hooks.ts`, acquire ownership before applying a reasoning patch.
- If another session already owns the tier, skip the patch and emit a warning/debug event such as `reasoning.patch_skipped_concurrent`.
- Release ownership in the after-hook after restore.

**Expected behavior**
- A second same-tier dispatch does not overwrite an active patch.
- The after-hook only releases what the current session owns.

**Verify**: `pnpm test -- test/unit/plugin-hooks.test.ts test/integration/reasoning-runtime.test.ts` → pass after test updates in Step 5.

### Step 5: Update and add tests

Make the runtime contract explicit in tests so the rename, mode switch, and guard behavior cannot regress silently.

**Update existing tests**
- Replace `command: "reasoning"` with `command: "model-router-reasoning"` in `test/integration/reasoning-runtime.test.ts`.
- Update `test/unit/router-commands.test.ts` for the new command name and the `mode` subcommand.

**Add/extend tests**
- `test/unit/router-commands.test.ts`
  - `/model-router-reasoning mode static` persists and reports `static`.
  - `/model-router-reasoning mode manual` persists and reports `manual`.
  - `/model-router-reasoning mode adaptive` is rejected clearly.
  - `/model-router-reasoning mode` shows current mode and usage.
  - Existing level override cases still pass under the new command name.
- `test/unit/plugin-hooks.test.ts`
  - `surfaceLimits=true` emits the applied-patch debug event.
  - unsupported reasoning emits the unsupported debug event.
  - same-tier overlap is skipped, not double-patched.
  - ownership is released after restore.
- `test/unit/router-config.test.ts`
  - `applyStateOverlay()` applies `reasoningMode`.
- `test/integration/reasoning-runtime.test.ts`
  - end-to-end mode switch + dispatch still patches and restores as expected.

**Verify**: `pnpm test` → all pass.

### Step 6: Sync docs and plan index

Make the release story match the shipped behavior.

**Change details**
- In `docs/REASONING.md`, rename `/reasoning` to `/model-router-reasoning` everywhere.
- Document the new `mode` subcommand and the fact that it persists mode changes.
- State clearly that the production release is **manual-mode reasoning control** only; `adaptive` remains deferred.
- In `plans/README.md`, add the new plan row and keep status ordering consistent.

**Verify**: `pnpm typecheck && pnpm test` → pass.

## Test plan

- `test/unit/router-commands.test.ts` — command rename, mode switching, invalid mode handling, level overrides.
- `test/unit/plugin-hooks.test.ts` — patch/restore, surfaceLimits logs, same-tier overlap guard.
- `test/integration/reasoning-runtime.test.ts` — runtime flow after rename.
- `test/unit/router-config.test.ts` — state overlay for `reasoningMode`.

## Done criteria

- [ ] `/model-router-reasoning mode <static|manual>` persists and takes effect on the next dispatch
- [ ] `/model-router-reasoning mode adaptive` is rejected clearly
- [ ] All `/reasoning` references are renamed or intentionally removed
- [ ] `RouterState` carries `reasoningMode`; `applyStateOverlay()` applies it
- [ ] Dead pending-note plumbing is removed
- [ ] Same-tier in-flight protection prevents double patching
- [ ] Tests cover rename, mode switch, overlay, concurrency, and observability
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0
- [ ] `plans/README.md` includes this plan row

## STOP conditions

Stop and report if:
- The code at the cited locations has drifted since `0e1e19f`.
- The team decides `/reasoning` must remain as a backward-compatible alias.
- The team wants `adaptive` switchable now, which changes the command contract.
- Same-tier overlap needs full serialization instead of fail-soft skipping.
- A step requires touching an out-of-scope file.

## Maintenance notes

- When the adaptive engine ships, extend `reasoningMode` to include `adaptive` and remove the explicit rejection.
- The in-flight guard is per plugin instance; revisit if the runtime becomes multi-process.
- Any new tier added to a preset still needs an explicit capability declaration or a valid inference path.
