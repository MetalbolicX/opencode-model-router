# Plan 001: Fix resource leak and add error logging to delegate.ts

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

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `bd1cd89`, 2026-06-29

## Why this matters

`executeDelegate` in `src/plugin/delegate.ts` has two correctness gaps. First,
when `session.create` succeeds but `extractSessionId(created)` returns falsy,
the function returns early at line 189 — **before** the `try/finally` block at
line 198 that owns per-attempt cleanup. The created producer session is leaked:
it stays registered in `sessionStore` and `guardStore` forever. Over a long
session, repeated leaks accumulate orphaned tracking entries. Second, six
`catch {}` blocks across the file swallow errors with zero observability. If
`sessionStore.unregister` or `guardStore.clear` consistently fails (store
corruption, serialization error), operators have no signal — orphaned state
accumulates invisibly. Adding structured `logEvent` calls to these catches
makes failures visible without changing fail-soft semantics.

## Current state

**Files in scope:**
- `src/plugin/delegate.ts` — the delegate-tool execution loop (462 lines). Contains the leak and the silent catches.

**The leak** — `delegate.ts:187-190`:
```typescript
const producerSid = extractSessionId(created);
if (!producerSid) {
  return "[router] delegate failed: could not create a producer session.";
}
```
This early return exits before the `try { ... } finally { cleanup }` block at
lines 198–456. There is no cleanup for the session that `session.create` just
produced. (When `extractSessionId` returns falsy we don't know the SID, but
the abort-check at lines 169–185 shows the canonical cleanup pattern:
`changedFileStore.clear`, `sessionStore.unregister`, `guardStore.clear`.)

**The per-attempt cleanup** that the early return skips — `delegate.ts:440-456`:
```typescript
} finally {
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
```

**The silent catches** — six sites swallow errors with `// non-fatal` and no log:
- `delegate.ts:175-177` — `sessionStore.unregister` in the post-create abort path
- `delegate.ts:180-182` — `guardStore.clear` in the post-create abort path
- `delegate.ts:194-196` — `registerProducerSession` throw guard
- `delegate.ts:448-450` — `sessionStore.unregister` in `finally`
- `delegate.ts:453-455` — `guardStore.clear` in `finally`

**Repo conventions:**
- Error handling is fail-soft: hooks must never crash a real session. Every catch must remain non-throwing.
- Structured logging uses `logEvent` from `src/utils/observability.ts`. The events are namespaced dots: `logEvent.config.staleServe(...)`, `logEvent.routing.unmet(...)`, `logEvent.verification.fail(...)`.
- Pattern to match: `delegate.ts:91` already does `logEvent.config.staleServe({ reason: String(err) })` inside a catch — follow that shape.

**Imports already present in delegate.ts** (do not re-add):
```typescript
import { logEvent } from "../utils/observability";
```

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Tests     | `pnpm test -- plugin-delegate`   | all pass            |
| Lint      | `pnpm lint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/plugin/delegate.ts`

**Out of scope** (do NOT touch):
- `src/utils/observability.ts` — the logger surface; changing event shapes is a separate concern.
- `test/unit/plugin-delegate.test.ts` — a new test is added in step 4, but do not modify existing tests.
- Any other source file.

## Git workflow

- Branch: `advisor/001-delegate-leak-and-logging`
- Commit per step; message style (conventional commits, observed in `git log`):
  `fix(delegate): clean up producer session when extractSessionId fails`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract a `cleanupProducerSession` helper

Add a small local helper near the top of `executeDelegate` (after the `let producerText` declarations, before the `while (true)` loop) so the cleanup sequence is defined once and reused by both the early-return path and the `finally` block. The helper must take `producerSid: string` and call the same three clear/unregister calls with the same fail-soft try/catch wrapping.

Target shape (place it as a module-private function above `executeDelegate`, or as a closure inside it — either is fine; module-private is preferred so it is testable in isolation):

```typescript
const cleanupProducerSession = (
  ctx: PluginContext,
  producerSid: string,
): void => {
  ctx.changedFileStore.clear(producerSid);
  try {
    ctx.sessionStore.unregister(producerSid);
  } catch (err) {
    logEvent.warning({
      event: "delegate.cleanup_failed",
      store: "sessionStore.unregister",
      sid: producerSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    ctx.guardStore.clear(producerSid);
  } catch (err) {
    logEvent.warning({
      event: "delegate.cleanup_failed",
      store: "guardStore.clear",
      sid: producerSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
```

**IMPORTANT — verify `logEvent.warning` exists**: Before writing this, open `src/utils/observability.ts` and confirm the exact shape of `logEvent`. If `logEvent.warning` is not a function, use whichever debug/warn entry point exists (e.g. `log.warn({...})` which is imported at the top of `hooks.ts`). Match the shape already used elsewhere. If the observability module has no generic warning channel, fall back to `log.warn({ event: "delegate.cleanup_failed", ... })` — `log` is the structured logger already imported in other modules.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Use the helper in the leaky early-return path

Replace the bare early return at lines 187-190 so it cleans up before returning. The challenge: when `extractSessionId` returns falsy we don't have a SID to pass. The fix is to run the three cleanup calls defensively inside a try/catch using the `created` object's id field if present, and always return the same error string.

Target shape:
```typescript
const producerSid = extractSessionId(created);
if (!producerSid) {
  // session.create succeeded but returned no/empty id. We cannot track
  // what we cannot name, but try a best-effort cleanup of the response's
  // id field if it exists as a string. Fail-soft: never throw here.
  const maybeSid =
    created?.data?.id && typeof created.data.id === "string" ? created.data.id : "";
  if (maybeSid) {
    cleanupProducerSession(ctx, maybeSid);
  }
  logEvent.warning({
    event: "delegate.create_no_sid",
    error: "session.create returned no usable session id",
  });
  return "[router] delegate failed: could not create a producer session.";
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Use the helper in the `finally` block and the post-create abort path

Replace the duplicated cleanup code in two places with calls to `cleanupProducerSession(ctx, producerSid)`:

1. The post-create abort path (lines 169-185) — replace the inline `changedFileStore.clear` + two try/catch blocks with a single `cleanupProducerSession(ctx, producerSid)` call.

2. The `finally` block (lines 440-456) — replace the inline cleanup with `cleanupProducerSession(ctx, producerSid)`.

Keep the `registerProducerSession` try/catch at lines 192-196 as a standalone guard (it is a registration, not a cleanup) but add a `logEvent.warning` inside its catch:
```typescript
try {
  ctx.sessionStore.registerProducerSession(producerSid, tier, activeCfg);
} catch (err) {
  logEvent.warning({
    event: "delegate.register_failed",
    sid: producerSid,
    tier,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Add a regression test for the leak fix

Add one new test case to `test/unit/plugin-delegate.test.ts` inside the existing `describe("executeDelegate — failure paths", ...)` block (or a new describe block titled `describe("executeDelegate — resource leak regression", ...)`).

The test must prove that when `session.create` returns `{ data: undefined }` (or `{ data: { id: "" } }`), the cleanup spies still fire for any SID derivable from the response. Model after the existing "returns 'could not create a producer session'" test at line 368.

```typescript
it("cleans up derivable SID when session.create returns an empty id", async () => {
  const unregisterCalls: string[] = [];
  const clearCalls: string[] = [];
  const { ctx } = makeCtx({
    createImpl: async () => ({ data: { id: "sess_leaked" } }),
    // Override extractSessionId by returning a shape it treats as falsy
    // while still carrying an id the cleanup can use.
    // NOTE: if extractSessionId is strict, use { data: { id: "" } } and
    // assert unregisterCalls is empty (no derivable SID) but the warning
    // event fired. Adapt to the actual extractSessionId behaviour.
    sessionStoreOverrides: {
      unregister: (sid: unknown) => { unregisterCalls.push(String(sid)); },
    },
    guardStoreOverrides: {
      clear: (sid: unknown) => { clearCalls.push(String(sid)); },
    },
  });
  const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
  expect(out).toContain("could not create a producer session");
  // If a SID was derivable, it MUST have been cleaned up.
  for (const sid of unregisterCalls) {
    expect(clearCalls).toContain(sid);
  }
});
```

Adapt the test to the real behaviour of `extractSessionId` (in `src/plugin/types.ts:85-89`) — it returns `res?.data?.id`, so `{ data: { id: "" } }` yields falsy `""`. The cleanup helper should still be invoked with `""` (which is a no-op on the stores but proves the path runs), OR you assert the warning event fired. The key invariant: **no early return skips the cleanup call**.

**Verify**: `pnpm test -- plugin-delegate` → all pass, including the new test.

## Test plan

- New test: `test/unit/plugin-delegate.test.ts` — "cleans up derivable SID when session.create returns an empty id" (step 4).
- Existing tests that must still pass: the full `plugin-delegate.test.ts` suite (35+ tests covering happy path, failure paths, abort, timeout, non-retryable errors).
- Pattern to model after: `test/unit/plugin-delegate.test.ts:368` ("returns 'could not create a producer session' when session.create yields no id") and `test/unit/plugin-delegate.test.ts:859` ("cleans up producer session state after prompt timeout") — both use the `unregisterCalls`/`clearCalls` spy pattern.
- Verification: `pnpm test -- plugin-delegate` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- plugin-delegate` exits 0; the new leak-regression test exists and passes
- [ ] `pnpm lint` exits 0
- [ ] `grep -n "catch {" src/plugin/delegate.ts` returns zero matches (all silent catches replaced with logged catches)
- [ ] No files outside the in-scope list are modified (`git status`), except the one new test addition in `test/unit/plugin-delegate.test.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `delegate.ts:187-190` or `delegate.ts:440-456` doesn't match the excerpts above (the codebase has drifted).
- `logEvent.warning` does not exist on the `logEvent` import and there is no equivalent structured warning channel in `src/utils/observability.ts` — report what logging surface IS available.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- Future changes to the cleanup sequence (e.g. adding a fourth store) must update `cleanupProducerSession` only — the helper is the single source of truth.
- A reviewer should verify that fail-soft semantics are preserved: no catch in the helper is allowed to throw, and the early-return path still returns the same error string.
- The structured `delegate.cleanup_failed` events are new — operators grepping logs should be told these are non-fatal cleanup warnings, not hard failures.
