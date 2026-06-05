# ADR 0000 — Enforcement-Primitives Spike Results (Phase 0.0)

> **Status:** Accepted
> **Date:** 2026-06-05
> **Phase:** WAVE 0 / Phase 0.0 (GATES the whole plan — Directive E)
> **Decision owner:** Marco Jardim (router owner)
> **Related:** `docs/plans/model-router-enforcement-and-verification-plan.md` §3, §3.2, §3.3, §13 (Open Q1), GA-8.

## Context

The enforcement plan is explicitly **conditional** on what the OpenCode plugin SDK can actually do
(Directive E). Before building any of the three layers we had to empirically answer three capability
questions and pin the artefact contract:

- **Capability A** — Can throwing inside `tool.execute.before` **abort** a tool call, and does the
  thrown text reach the model? (Linchpin of Layer 1 hard-block.)
- **Capability B** — Can a plugin register a **custom tool** the orchestrator can call and whose
  return it receives? (Required for Option (ii) `delegate` tool.)
- **Capability C** — Can a plugin **observe a subagent's tool calls and final return**? (Required for
  Layer 2 artefact assembly.)

## Method

1. **Typings recon** of the installed SDK (read-only).
2. **A throwaway probe plugin** (`test/smoke/probe/probe-plugin.js`, non-shipping) that registers two
   custom tools (`probe_echo`, `probe_block_me`), a `tool.execute.before` that throws on
   `probe_block_me`, a `tool.execute.after`, and an `event` logger. All events are appended as JSON to
   `tmp/probe/probe-events.log` (gitignored).
3. **One live run** against a real cheap model, non-interactively:
   ```
   opencode run "...call probe_echo then probe_block_me, report each result/error..." \
     --model anthropic/claude-haiku-4-5 --format json --dangerously-skip-permissions
   ```
   Loaded via a **temporary** repo-root `opencode.json` (deleted after; the user's global config was
   never modified). Exit code 0, ~19 s.

### SDK / runtime version landscape (record for R10 — version drift)

| Location | `@opencode-ai/plugin` | Notes |
|----------|----------------------|-------|
| repo `node_modules/` | **1.2.6** | what `tsc`/tests resolve against |
| repo `.opencode/package.json` | **1.4.1** | project-local plugin dep |
| `opencode` CLI | **1.15.13** | bundles the **runtime** that actually invokes the hooks |

The probe ran under the **CLI 1.15.13 runtime** — i.e. the production execution path. Hook *typings*
were read from 1.2.6. The before-hook abort semantics are a **runtime** property and were confirmed
against the runtime that ships to users. **Each Wave's real-OpenCode smoke (M1) must re-confirm** the
primitive it relies on, and Phase 1.2 pre-flight must re-spike if the CLI/SDK drifts (Directive E).

## Findings (evidence)

### Capability A — throw-to-abort: **CONFIRMED (empirical)**

- `probe_block_me`'s `execute` **never ran** — `block_execute_REACHED` is absent from the log; only
  `before` then `before_throw` were logged.
- The tool-call record in the JSON event stream was:
  ```json
  { "tool": "probe_block_me",
    "state": { "status": "error", "input": { "reason": "test" },
               "error": "PROBE_BLOCKED: before-hook aborted this call (capability A)." } }
  ```
- The model **received the thrown text verbatim** and reported it back.
- The session **continued and exited cleanly (code 0)** after the block — the throw aborts *the tool
  call*, it does not crash the session.

**Implication:** Layer 1 can hard-block by throwing in `tool.execute.before`, and the throw message is
the perfect carrier for the **forcing message**. This is exactly the reference
(`agent-test/opencode-plugin.mjs`) pattern, now re-confirmed on CLI 1.15.13.

### Capability B — custom tool: **CONFIRMED (empirical)**

- `probe_echo` was registered via the plugin `tool` map, **called by the model**, executed
  (`echo_execute` logged), returned `PROBE_ECHO_OK:hello` (`status:"completed"`), and the model quoted
  the return verbatim.
- Registration shape that works: `import { tool } from "@opencode-ai/plugin"`, build args with the
  zod re-export `const z = tool.schema`, then put the built tool under
  `return { tool: { <name>: <builtTool> } }`. **This is the construction the real `delegate` tool will
  reuse in Wave 2.**

### Capability C — subagent interception: **CONFIRMED (empirical, Run 2)**

**Run 1** (no subagent) confirmed the event stream is observable: the `event` hook fired for **12
distinct event types** including the ones the artefact contract needs — `message.updated` (assistant
`Message` → final text), `message.part.updated` / `message.part.delta` (carry `ToolPart` with
`state.output`), `session.created`/`idle`/`status`/`diff`. `event.properties.sessionID` is populated on
all session/message events (null only on global `tui.toast.show` / `server.instance.disposed`).

**Run 2** (orchestrator spawns a real `Task(subagent_type="fast")` child) closed the remaining gap:

- **Two distinct sessions** appeared: orchestrator `ses_…AOR` and child `ses_…NsEf`.
- **Child correlation works — but the field path matters:** `parentID` is at
  **`event.properties.info.parentID`** (present on the child's `session.created`), **NOT** at
  `event.properties.parentID` (which is always null). The child's `info.parentID` equalled the
  orchestrator's session id. *Run 1's null `parentID` was an extractor bug (wrong path), not an SDK
  limitation.* **Implementation note for Wave 2: read `properties.info.parentID` on `session.created`.**
- **The before-hook fires INSIDE the child session:** `{ev:"before", tool:"probe_echo",
  sessionID:"ses_…NsEf"}` — a different sessionID than the orchestrator, and the custom tool's
  `execute` ran in the child (`echo_execute value=child-ran`). So Layer 1's enforcement point applies to
  subagent sessions, keyed off `sessionID` (consistent with the existing `subagentSessionIDs` detection).
  The plugin factory ran **once** (`factory_called` logged once) and served both sessions.
- **The built-in `task` tool is itself interceptable (key Layer-2 finding):** the orchestrator's
  `Task()` dispatch surfaced as `{ev:"before", tool:"task", sessionID:<orchestrator>}`, and the `task`
  tool's **result record** (in `tool.execute.after`) contained the subagent's **final return**
  wrapped as `<task_result>DONE.</task_result>` plus
  `metadata: { parentSessionId:<orchestrator>, sessionId:<child> }`.

**Implication:** Layer 2 can capture a delegation's **finalReturnText directly from the `task` tool's
`tool.execute.after` output** (no event-stream reassembly required), and attribute **changedFiles** to
the child via that child sessionID's edit/write calls in `tool.execute.after`. This is a robust,
concurrency-safe artefact source and strengthens Option (ii).

## The artefact contract (§3.3) — what is achievable

`Artefact = { changedFiles, finalReturnText, declaredOutputs }`, assembled as:

- **changedFiles** — attributed to a delegation by observing that session's **edit/write tool calls in
  `tool.execute.after`** (keyed by `sessionID`), *not* a global `git diff` (concurrency-safe, §5.6).
  `event` `session.diff` / `file.edited` are a secondary signal.
- **finalReturnText** — the subagent's final assistant text via `message.updated` → `Message`, and/or,
  under Option (ii), the **string returned by the `delegate` tool's own `execute`** (cleanest).
- **declaredOutputs** — paths/commands named explicitly by the DoD; always verifiable regardless of A/B/C.

**Residual limit (record):** a *free-form, text-only* deliverable with no declared output and no changed
files can only be **checker-graded on the returned text**. Acceptable and documented (matches §3.3).

## Decision

1. **Architecture = Option (ii) (plugin-provided `delegate` tool) is the buildable robust end-state**,
   because **Capability B is confirmed**. Raw `Task()` keeps working via **Option (i)**
   (protocol-enforced verify-dispatch) for back-compat.
2. **All three layers are buildable as designed:**
   - Layer 1 (hard-block) — **buildable** (Cap A ✅). `[needs Spike cap. A]` → **RESOLVED: buildable.**
   - Layer 2 (acceptance gate) — **buildable** via Option (ii) (`delegate` tool returns only an
     accepted result) with deterministic + checker verifiers. `[needs Spike cap. B or C]` →
     **RESOLVED: buildable (B ✅).**
   - Layer 3 (escalation) — **buildable** (pure policy; composes on top of the gate).
3. **Open Q1 is NOT triggered.** Q1 only fires if **both** B and C are absent; B is confirmed, so we do
   **not** stop to escalate. We proceed building Option (ii).
4. **GA-8** is satisfied for **A, B, and C** now (A/B in Run 1, C in Run 2). Each later layer still runs
   its own real-OpenCode smoke (M1) to re-confirm against any version drift.

## Consequences / follow-ups (carried into later phases)

- **Layer-2 artefact capture (recommended mechanism, from Run 2):** intercept the built-in **`task`
  tool** — its `tool.execute.after` output carries the subagent's final return + `metadata.sessionId`/
  `parentSessionId`; attribute changed files via the child sessionID's edit/write calls. Use
  `session.created.properties.info.parentID` to map child→parent. This does **not** require a custom
  tool, so Option (i) and Option (ii) share the same capture path.
- **W2 open item (non-blocking):** confirm whether the plugin factory's injected **`client`** (OpenCode
  SDK client) can `session.create` + `prompt` + await a child result so a custom `delegate` tool can
  **produce → gate → return accepted-only** in a single tool call. If `client` cannot spawn/await,
  Option (ii) degrades to "the gate wraps the `task`-tool result" (still fully plugin-owned verify/accept,
  just not an in-tool spawn). Either way the gate is plugin-owned.
- **Throw-message contract (Layer 1):** the thrown `Error.message` IS the model-visible observation;
  keep it secret-free (§5.5) and end it with the forcing message.
- **Re-spike trigger (R10):** if `opencode --version` or the bundled plugin SDK changes before Wave 1
  wiring, re-run this probe (Phase 1.2 pre-flight).

## Probe artifact

Kept at `test/smoke/probe/probe-plugin.js`, **non-shipping** (`package.json` `files` is restricted to
`src/`, `tiers.json`, `LICENSE`, `README.md`; `tmp/` is gitignored). Reusable as the seed for the
Wave-1/Wave-2 real-OpenCode smokes.
