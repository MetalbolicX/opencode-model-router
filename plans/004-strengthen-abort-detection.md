# Plan 004: Strengthen AbortError detection in delegate.ts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd1cd89..HEAD -- src/plugin/delegate.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `bd1cd89`, 2026-06-29

## Why this matters

The abort-detection path in `executeDelegate` relies on
`err instanceof DOMException && err.name === "AbortError"` to detect a
user-initiated cancellation during `session.create`. While Node.js ≥ 20 exposes
`DOMException` globally, the OpenCode SDK or an intermediary wrapper may
re-throw the abort as a plain `Error` with `name === "AbortError"` (or even a
`TypeError` from a race in the SDK internals). When that happens, the
`instanceof` check fails, the error propagates to the outer catch at line 458,
and the user sees a confusing `fail-closed` message instead of a silent
cancellation. Adding a duck-typed fallback (`err?.name === "AbortError"`)
catches both shapes without changing the existing behaviour for genuine
`DOMException` aborts.

## Current state

**File in scope:**
- `src/plugin/delegate.ts` — the abort check in the `session.create` catch.

**The check** — `delegate.ts:157-165`:
```typescript
} catch (err) {
  // AbortError during session.create: bail silently. We never
  // produced a producer sid, so no per-attempt cleanup is needed
  // — the outer while-loop will exit on the next top-of-loop check.
  if (err instanceof DOMException && err.name === "AbortError") {
    return "";
  }
  throw err;
}
```

**The downstream classifier** — `delegate.ts:283-286` (inside the `session.prompt` catch):
```typescript
const classified = classifyPromptError(err);
if (classified.kind === "abort") {
  return "";
}
```

Note: the `session.prompt` path already handles this correctly via
`classifyPromptError` (in `src/utils/error-classify.ts`), which uses duck-typed
checks. Only the `session.create` path has the fragile `instanceof`-only check.

**Repo conventions:**
- Duck-typed error detection is the established pattern: `classifyPromptError` in `src/utils/error-classify.ts` checks `err?.name === "AbortError"` as a fallback. Read that file to match the exact shape.
- The abort contract is documented in the `executeDelegate` header comment (`delegate.ts:54-74`): cancellation must return `""` silently.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Tests     | `pnpm test -- plugin-delegate`   | all pass            |
| Lint      | `pnpm lint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/plugin/delegate.ts`
- `test/unit/plugin-delegate.test.ts` (add one test case)

**Out of scope** (do NOT touch):
- `src/utils/error-classify.ts` — `classifyPromptError` already handles this correctly; do not duplicate it.
- The `session.prompt` catch path — it already uses the classifier.

## Git workflow

- Branch: `advisor/004-abort-detection`
- Commit message style (conventional commits): `fix(delegate): detect AbortError by name as well as instanceof`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the duck-typed fallback

In `src/plugin/delegate.ts`, replace the abort check in the `session.create` catch (line 161) with a check that accepts both shapes.

First, read `src/utils/error-classify.ts` to see the exact duck-typed pattern it uses for abort detection (so this fix matches it). Then apply the same shape.

Target:
```typescript
if (
  (err instanceof DOMException && err.name === "AbortError") ||
  (err !== null && typeof err === "object" && "name" in err && err.name === "AbortError")
) {
  return "";
}
```

Keep the comment above it and the `throw err` below it unchanged.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Add a regression test

In `test/unit/plugin-delegate.test.ts`, inside the existing `describe("executeDelegate — abort during session.create", ...)` block (or near the other abort tests around line 982), add:

```typescript
it("returns '' when session.create throws a non-DOMException error named AbortError", async () => {
  const ac = new AbortController();
  const { ctx } = makeCtx({
    createImpl: async () => {
      // Simulate an SDK wrapper that re-throws the abort as a plain Error.
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
  });
  const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
  expect(out).toBe("");
});
```

**Verify**: `pnpm test -- plugin-delegate` → all pass, including the new test.

## Test plan

- New test: `test/unit/plugin-delegate.test.ts` — "returns '' when session.create throws a non-DOMException error named AbortError".
- Pattern: model after `plugin-delegate.test.ts:983` ("returns '' when signal is already aborted before the first attempt").
- Verification: `pnpm test -- plugin-delegate` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- plugin-delegate` exits 0; the new AbortError-name test exists and passes
- [ ] `pnpm lint` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Line 161 in `delegate.ts` is not `if (err instanceof DOMException && err.name === "AbortError") {` (the codebase has drifted).
- `src/utils/error-classify.ts` already exports a reusable `isAbortError(err)` helper — if so, import and use that instead of inlining the check, and report that you did so.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If `error-classify.ts` later grows a general-purpose `isAbortError(err)` predicate, this check site should switch to calling it rather than maintaining its own inline check.
- A reviewer should confirm the new branch does not swallow genuine errors — the `throw err` below the check must remain so non-abort errors still propagate.
