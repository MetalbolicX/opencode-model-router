# Plan 006: Replace cast-heavy type narrowing with runtime guards in hooks.ts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd1cd89..HEAD -- src/plugin/hooks.ts src/plugin/types.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `bd1cd89`, 2026-06-29

## Why this matters

`src/plugin/hooks.ts` narrows loosely-typed hook payloads with `as` casts
instead of runtime guards. For example, `handleChatMessage` casts
`input as { agent?: string; sessionID: string }` (line 71) — if the SDK ever
delivers a payload where `sessionID` is missing or named differently, the cast
passes the compiler but the code reads `undefined` at runtime and silently
no-ops. Replacing the casts with small type-guard helpers (co-located in
`src/plugin/types.ts`, which already hosts `isTextPart` and `asTaskToolArgs`)
makes the narrowing explicit and runtime-safe, matching the established
pattern in the same file.

## Current state

**Files in scope:**
- `src/plugin/types.ts` — add two narrow type-guard helpers (the file already has `isTextPart`, `asTaskToolArgs` as patterns).
- `src/plugin/hooks.ts` — replace the `as` casts with the new guards.

**The casts to replace:**

1. `hooks.ts:71-76` — `handleChatMessage`:
```typescript
ctx.sessionStore.registerFromChatMessage(
  input as { agent?: string; sessionID: string },
  output,
  cfg,
  tierNames,
);
```

2. `hooks.ts:79` — `handleChatMessage` reads the SID:
```typescript
const sid = input?.sessionID as string | undefined;
```

3. `hooks.ts:137-139` — `handleToolExecuteAfter`:
```typescript
ctx.sessionStore.recordToolCall(
  input as { sessionID: string; tool: string; args: unknown },
  output,
);
```

**The established guard pattern** — `types.ts:111-125` (`asTaskToolArgs`):
```typescript
export const asTaskToolArgs = (args: unknown): TaskToolArgs | null => {
  if (!args || typeof args !== "object") return null;
  const rec = args as Record<string, unknown>;
  const out: TaskToolArgs = {};
  if (typeof rec["subagent_type"] === "string") {
    out.subagent_type = rec["subagent_type"];
  }
  // ...
  return out;
};
```

This pattern: take `unknown`, validate the object shape, return a typed object
or `null`. The consumer checks for `null` and skips.

**Repo conventions:**
- Guards live in `src/plugin/types.ts` next to the DTOs they narrow.
- Guards return the narrowed type or `null` (not throw).
- Consumers tolerate `null` by returning early (fail-soft).

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Tests     | `pnpm test -- plugin-hooks`      | all pass            |
| Lint      | `pnpm lint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/plugin/types.ts` — add two guard helpers.
- `src/plugin/hooks.ts` — replace casts with guard calls.

**Out of scope** (do NOT touch):
- `src/plugin/runtime.ts` — the `toHookPayload`/`toEventPayload` wrappers there are a different, intentional boundary cast (documented in the file header); leave them.
- `src/router/sessions.ts` — `registerFromChatMessage` and `recordToolCall` signatures are unchanged; only the call sites narrow.
- Any test file (existing tests cover the fail-soft paths).

## Git workflow

- Branch: `advisor/006-hooks-runtime-guards`
- Commit message style (conventional commits): `refactor(plugin): replace as-casts with runtime guards in hooks.ts`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add guard helpers to types.ts

In `src/plugin/types.ts`, add two helpers modelled after `asTaskToolArgs`. Place them after the existing `asTaskToolArgs` (around line 125).

```typescript
/**
 * Narrow an unknown hook payload to the shape `registerFromChatMessage`
 * expects. Returns `null` when the payload is not an object or lacks a
 * string `sessionID`. `agent` stays optional.
 */
export interface ChatMessageInput {
  sessionID: string;
  agent?: string;
}

export const asChatMessageInput = (v: unknown): ChatMessageInput | null => {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  if (typeof rec["sessionID"] !== "string") return null;
  const out: ChatMessageInput = { sessionID: rec["sessionID"] };
  if (typeof rec["agent"] === "string") {
    out.agent = rec["agent"];
  }
  return out;
};

/**
 * Narrow an unknown hook payload to the shape `recordToolCall` expects.
 * Returns `null` when the payload is not an object or lacks string
 * `sessionID` / `tool` fields. `args` stays `unknown` (the store tolerates it).
 */
export interface ToolCallInput {
  sessionID: string;
  tool: string;
  args?: unknown;
}

export const asToolCallInput = (v: unknown): ToolCallInput | null => {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  if (typeof rec["sessionID"] !== "string") return null;
  if (typeof rec["tool"] !== "string") return null;
  const out: ToolCallInput = { sessionID: rec["sessionID"], tool: rec["tool"] };
  if ("args" in rec) {
    out.args = rec["args"];
  }
  return out;
};
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Use the guards in hooks.ts

In `src/plugin/hooks.ts`:

1. Add to the imports from `./types`:
```typescript
import type { HookEventPayload, HookPayload } from "./types";
import { asChatMessageInput, asToolCallInput } from "./types";
```
(Merge into the existing import line — do not duplicate the `import` statement.)

2. In `handleChatMessage` (around line 71), replace the cast:
```typescript
// BEFORE:
ctx.sessionStore.registerFromChatMessage(
  input as { agent?: string; sessionID: string },
  output,
  cfg,
  tierNames,
);
const sid = input?.sessionID as string | undefined;

// AFTER:
const chatInput = asChatMessageInput(input);
if (!chatInput) return; // fail-soft: malformed payload
ctx.sessionStore.registerFromChatMessage(chatInput, output, cfg, tierNames);
const sid = chatInput.sessionID;
```

3. In `handleToolExecuteAfter` (around line 137), replace the cast:
```typescript
// BEFORE:
ctx.sessionStore.recordToolCall(
  input as { sessionID: string; tool: string; args: unknown },
  output,
);

// AFTER:
const toolInput = asToolCallInput(input);
if (toolInput) {
  ctx.sessionStore.recordToolCall(toolInput, output);
}
```
Note: `recordToolCall` is a no-op when the session is not tracked, so guarding with `if (toolInput)` preserves the fail-soft behaviour. The subsequent `sid`/`tool` reads in the same function (lines 144-145) already use optional chaining and remain unchanged.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Verify fail-soft behaviour is preserved

The existing `plugin-hooks.test.ts` already has a "fail-soft on bad input" suite (lines 229-331) that passes `undefined`, `null`, and partial objects to every handler. These tests must still pass unchanged — the guards return `null` on bad input, the handlers return early, and the tests assert `.resolves.toBeUndefined()`.

**Verify**: `pnpm test -- plugin-hooks` → all pass.

## Test plan

- No new tests strictly required — the existing fail-soft suite (`plugin-hooks.test.ts:229-331`) covers the `null`-return paths.
- Optional (recommended): add one test case to `plugin-hooks.test.ts` asserting `handleChatMessage` does not call `registerFromChatMessage` when `input.sessionID` is missing (returns `null` from the guard).
- Verification: `pnpm test -- plugin-hooks` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- plugin-hooks` exits 0 (fail-soft suite still green)
- [ ] `pnpm lint` exits 0
- [ ] `grep -n "input as {" src/plugin/hooks.ts` returns no matches (casts removed)
- [ ] `grep -n "asChatMessageInput\|asToolCallInput" src/plugin/hooks.ts` returns matches (guards in use)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `as` casts at `hooks.ts:71` or `hooks.ts:137` are no longer present (the codebase has drifted — the casts may already be gone).
- `registerFromChatMessage` or `recordToolCall` in `src/router/sessions.ts` have a different signature than `{ sessionID: string; ... }` — the guards must match the real signature; report any mismatch.
- The fail-soft test suite in `plugin-hooks.test.ts` fails after the change — the guards must preserve the exact `.resolves.toBeUndefined()` contract.

## Maintenance notes

- The two new guards (`asChatMessageInput`, `asToolCallInput`) join the existing guard family in `types.ts`. Future hook handlers that narrow `HookPayload` should add a guard here rather than casting inline.
- A reviewer should confirm that the `if (!chatInput) return;` early return in `handleChatMessage` does not skip a side-effect that the cast previously let through. As written, the original code would have passed `undefined` fields into `registerFromChatMessage`, which would have no-op'd anyway — so the guard makes the skip explicit.
