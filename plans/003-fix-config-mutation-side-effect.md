# Plan 003: Fix config mutation side effect in commands.ts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd1cd89..HEAD -- src/router/commands.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `bd1cd89`, 2026-06-29

## Why this matters

In `buildPresetOutput`, after persisting the user's preset choice via
`saveActivePreset`, the code mutates the `cfg` object in place:
`cfg.activePreset = resolvedPreset` (line 151). This `cfg` is the cached
reference returned by `ctx.getFreshConfig()` — mutating it means any other
caller holding the same reference (e.g. a concurrent hook reading the cached
config) sees the new `activePreset` **before** the next disk refresh. This is
a dirty-read side effect: the cache and the persisted state diverge silently,
and the mutation bypasses the `ConfigStore`'s contract that cache replacement
only happens via `refresh()`. The fix is to remove the mutation entirely —
`saveActivePreset` already persists to the state file, and the next
`getFreshConfig()` call will re-read disk and pick up the new value through
the proper channel.

## Current state

**File in scope:**
- `src/router/commands.ts` — the `/preset` command handler.

**The mutation** — `commands.ts:148-165`:
```typescript
const resolvedPreset = resolvePresetName(cfg, requestedPreset);
if (resolvedPreset) {
  await saveActivePreset(resolvedPreset);
  cfg.activePreset = resolvedPreset;   // <-- LINE 151: the mutation
  const tiers = cfg.presets[resolvedPreset]!;
  const models = Object.entries(tiers)
    .map(([tier, t]) => `  @${tier} -> ${t.model}`)
    .join("\n");
  return [
    `Preset switched to **${resolvedPreset}**.`,
    "",
    models,
    "",
    "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
    "Restart OpenCode for subagent model registration to take effect.",
    "System prompt delegation rules update immediately.",
  ].join("\n");
}
```

The subsequent reads of `cfg.presets[resolvedPreset]` (line 152) work correctly
without the mutation because `resolvedPreset` is a local variable — the
mutation at line 151 is dead code as far as the rest of this function is
concerned. It only affects external callers sharing the reference.

**How `cfg` arrives here** — `commands.ts:273-279`:
```typescript
if (input.command === "preset") {
  const cfg = await ctx.getFreshConfig();
  output.parts.push({
    type: "text" as const,
    text: await buildPresetOutput(cfg, input.arguments ?? ""),
  });
}
```

`ctx.getFreshConfig()` (per `src/plugin/context.ts:162-168`) calls
`this.refreshConfig()` which calls `configStore.refresh()` — this returns the
cached value object. Mutating it corrupts the cache.

**Repo conventions:**
- The `ConfigStore` in `src/router/config-store.ts` owns cache replacement. Callers must treat the returned `RouterConfig` as read-only. The store's `refresh()` is the only sanctioned way to replace the cache.
- No other command handler mutates the cfg: `buildBudgetOutput` and `buildRouterOutput` both read `cfg` without mutating it.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Tests     | `pnpm test -- router-commands`   | all pass            |
| Lint      | `pnpm lint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/router/commands.ts`
- `test/unit/router-commands.test.ts` (add one regression test)

**Out of scope** (do NOT touch):
- `src/router/config-store.ts` — the cache; not the problem here.
- `src/router/config-state.ts` — `saveActivePreset`; it already persists correctly.
- Any other command handler.

## Git workflow

- Branch: `advisor/003-config-mutation-fix`
- Commit message style (conventional commits): `fix(commands): stop mutating cached config in /preset handler`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Remove the mutation

In `src/router/commands.ts`, delete line 151 (`cfg.activePreset = resolvedPreset;`). The surrounding code is unchanged. The `const tiers = cfg.presets[resolvedPreset]!` read on the next line continues to work because `resolvedPreset` is a local variable validated by `resolvePresetName`.

After the edit, the block should read:
```typescript
const resolvedPreset = resolvePresetName(cfg, requestedPreset);
if (resolvedPreset) {
  await saveActivePreset(resolvedPreset);
  const tiers = cfg.presets[resolvedPreset]!;
  const models = Object.entries(tiers)
    .map(([tier, t]) => `  @${tier} -> ${t.model}`)
    .join("\n");
  return [
    `Preset switched to **${resolvedPreset}**.`,
    // ... rest unchanged
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Add a regression test

In `test/unit/router-commands.test.ts`, add a test that proves the cfg object is not mutated after `buildPresetOutput` runs. Model after the existing preset tests in that file.

```typescript
it("does not mutate the cfg argument after switching preset", async () => {
  const cfg: RouterConfig = {
    activePreset: "default",
    defaultTier: "fast",
    presets: {
      default: { fast: { model: "a/fast", description: "f", whenToUse: [] } },
      openai: { fast: { model: "o/fast", description: "f", whenToUse: [] } },
    },
    rules: [],
  };
  const before = cfg.activePreset;
  // saveActivePreset writes to disk; mock or stub it if the test env
  // cannot write. Match the existing test's approach to saveActivePreset.
  await buildPresetOutput(cfg, "openai");
  expect(cfg.activePreset).toBe(before); // unchanged — "default"
});
```

Adapt the `saveActivePreset` stubbing to whatever pattern the existing tests in `router-commands.test.ts` already use (they must handle it since they call `buildPresetOutput`).

**Verify**: `pnpm test -- router-commands` → all pass, including the new test.

## Test plan

- New test: `test/unit/router-commands.test.ts` — "does not mutate the cfg argument after switching preset".
- Pattern: model after the existing preset-switch tests in the same file.
- Verification: `pnpm test -- router-commands` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- router-commands` exits 0; the new non-mutation test exists and passes
- [ ] `pnpm lint` exits 0
- [ ] `grep -n "cfg.activePreset =" src/router/commands.ts` returns no matches (no mutation)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Line 151 in `commands.ts` is not `cfg.activePreset = resolvedPreset;` (the codebase has drifted).
- Removing the line causes a typecheck error (it should not — `resolvedPreset` is used on the next line, not `cfg.activePreset`).
- The existing `router-commands.test.ts` tests fail after the removal — report which ones and why.

## Maintenance notes

- The `/preset` command's persisted state is read fresh by the next `getFreshConfig()` call. The user-facing message already says "Restart OpenCode for subagent model registration to take effect" and "System prompt delegation rules update immediately" — both remain accurate.
- A reviewer should verify that no other command handler (`/budget`, `/router`) has a similar mutation. As of this plan, they do not — but check during review.
