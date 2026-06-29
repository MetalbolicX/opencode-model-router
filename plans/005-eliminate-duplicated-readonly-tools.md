# Plan 005: Eliminate duplicated READ_ONLY_TOOLS set

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat bd1cd89..HEAD -- src/router/tools.ts src/router/sessions.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `bd1cd89`, 2026-06-29

## Why this matters

`READ_ONLY_TOOLS` is defined twice with identical contents:
`src/router/tools.ts:28` (the canonical source, a `ReadonlySet<string>`) and
`src/router/sessions.ts:113` (a re-declared `Set<string>`). The comment in
`tools.ts:21-24` explicitly says "The two definitions MUST stay byte-equal;
update them together" — but there is no CI guard enforcing this. This is a
classic drift trap: a future edit to one definition will silently desync the
cap-enforcement set from the guard-classification set, causing the cap banner
and the guard to disagree on which tools are read-only. Consolidating to a
single import eliminates the trap.

## Current state

**Files in scope:**
- `src/router/tools.ts` — the canonical definition (line 28). KEEP this one.
- `src/router/sessions.ts` — the duplicate (line 113). REMOVE this one and import instead.

**Canonical definition** — `tools.ts:27-28`:
```typescript
/** Tools that count against the read-only cap and never mutate the workspace. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["grep", "read", "glob", "ls"]);
```

**Duplicate** — `sessions.ts:112-113`:
```typescript
/** Tools that count against the read-only cap. Keep narrow — editing tools should never count. */
export const READ_ONLY_TOOLS = new Set(["grep", "read", "glob", "ls"]);
```

**Consumers of the duplicate in sessions.ts:**
- `sessions.ts:247` — `if (!READ_ONLY_TOOLS.has(input.tool)) return;` inside `recordToolCall`.

**External consumers of the canonical tools.ts export:**
- `src/guard/guards.ts` and `src/verify/dispatch.ts` (per the header comment in `tools.ts:4-8`).

**Repo conventions:**
- The canonical module `tools.ts` was created specifically to be the single source of truth (see its header comment lines 1-25).
- Imports use the relative path form: `import { READ_ONLY_TOOLS } from "./tools";`.

## Commands you will need

| Purpose   | Command                      | Expected on success |
|-----------|------------------------------|---------------------|
| Typecheck | `pnpm typecheck`             | exit 0, no errors   |
| Tests     | `pnpm test`                  | all pass            |
| Lint      | `pnpm lint`                  | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/router/sessions.ts` — remove the duplicate, add an import.
- `src/router/tools.ts` — update the header comment to remove the "MUST stay byte-equal" note (it is now the only definition).

**Out of scope** (do NOT touch):
- `src/guard/guards.ts`, `src/verify/dispatch.ts` — they already import from `tools.ts`.
- Any test file (existing tests cover this transitively).

## Git workflow

- Branch: `advisor/005-dedupe-readonly-tools`
- Commit message style (conventional commits): `refactor(router): import READ_ONLY_TOOLS from tools.ts in sessions.ts`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the duplicate in sessions.ts with an import

In `src/router/sessions.ts`:

1. Add `import { READ_ONLY_TOOLS } from "./tools";` to the import block at the top of the file (after the existing imports, around line 1-3).

2. Delete lines 112-113 (the duplicate `/** Tools that count against the read-only cap... */` comment and the `export const READ_ONLY_TOOLS = new Set(...)` declaration).

3. Check whether `READ_ONLY_TOOLS` is re-exported from `sessions.ts` anywhere. Run: `grep -rn "from.*sessions" src/ test/ | grep READ_ONLY`. If any file imports `READ_ONLY_TOOLS` from `sessions.ts`, update those imports to use `tools.ts` instead. (Per the header comment, the canonical source is `tools.ts`, so external consumers should already import from there — but verify.)

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Update the header comment in tools.ts

In `src/router/tools.ts`, find the comment block at lines 21-24:
```typescript
// `READ_ONLY_TOOLS` is also re-declared in `src/router/sessions.ts` for the
// session cap banner (intentionally preserved to avoid a churn diff in callers
// like `src/plugin/hooks.ts`). The two definitions MUST stay byte-equal;
// update them together.
```

Replace it with:
```typescript
// `READ_ONLY_TOOLS` is the single source of truth. `src/router/sessions.ts`
// imports it from here (previously a duplicate; consolidated to prevent drift).
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Run the full test suite

The change is a pure import consolidation — no behavioural change. The full
suite must pass unchanged.

**Verify**: `pnpm test` → all pass.

## Test plan

- No new tests needed — this is a refactor that preserves behaviour. The existing `sessions.test.ts`, `tools.test.ts`, and `plugin-hooks.test.ts` cover the consumers transitively.
- Verification: `pnpm test` → all pass (no new failures).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0 (no regressions)
- [ ] `pnpm lint` exits 0
- [ ] `grep -c "READ_ONLY_TOOLS = new Set" src/router/sessions.ts` returns `0` (duplicate removed)
- [ ] `grep -n "import.*READ_ONLY_TOOLS.*from.*tools" src/router/sessions.ts` returns a match (import added)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Lines 112-113 in `sessions.ts` are not the `READ_ONLY_TOOLS` duplicate (the codebase has drifted).
- A file outside the scope list imports `READ_ONLY_TOOLS` from `sessions.ts` (i.e. the duplicate is a re-export that other code depends on) — report the file and pause.
- `pnpm test` fails after the change — report which tests fail.

## Maintenance notes

- `tools.ts` is now the undisputed single source of truth for all four tool sets (`READ_ONLY_TOOLS`, `WRITE_TOOLS`, `MUTATION_TOOLS`, `FINISH_TOOLS`).
- A reviewer should confirm no `export` of `READ_ONLY_TOOLS` was removed from `sessions.ts` that other modules re-export. The `grep` in step 1 catches this.
