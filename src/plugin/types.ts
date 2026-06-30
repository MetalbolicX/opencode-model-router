// ---------------------------------------------------------------------------
// src/plugin/types.ts — Narrow runtime DTOs and small type guards for the
// plugin runtime boundaries.
//
// Phase 3 of the core-refactor-plan replaces `any` at hot runtime seams
// (delegate args, session SDK results, hook IO, verify-dispatch input, shell
// exec callback) with narrow interfaces from this file plus minimal type
// guards. The strategy is intentionally conservative: types are READ-ONLY
// shapes, and the same logic that used to flow through `any` continues to
// flow — only the boundaries compile-check now.
//
// These shapes are deliberately SDK-partial: the opencode plugin SDK
// returns loosely-typed objects, so we extract the minimum fields each
// consumer needs and ignore the rest. Refinements go through type guards,
// not casts.
// ---------------------------------------------------------------------------

/**
 * Args shape for the plugin-owned `delegate` tool. Mirrors the schema in
 * `src/plugin/runtime.ts`: `task` is required, `tier` and `acceptance`
 * are optional.
 */
export interface DelegateArgs {
  task: string;
  tier?: string;
  acceptance?: string;
}

// ---------------------------------------------------------------------------
// Session SDK result shapes
// ---------------------------------------------------------------------------

/**
 * Partial shape of `client.session.create({})` — the SDK returns more
 * fields, but only `data.id` is consumed at runtime. Kept narrow on
 * purpose so missing/wrong shapes fail at compile time.
 */
export interface SessionCreateResult {
  data?: { id?: string };
}

/**
 * Partial shape of `client.session.prompt(...)`. Only `data.parts` is
 * consumed at runtime; each part is typed as `unknown` and refined via
 * the `isTextPart` guard.
 */
export interface SessionPromptResult {
  data?: { parts?: Array<{ type?: string; text?: unknown }> };
}

// ---------------------------------------------------------------------------
// Discriminated `Part` union + guard
// ---------------------------------------------------------------------------

/** A text-bearing message part. `text` is narrowed to `string`. */
export interface TextPart {
  type: "text";
  text: string;
}

/** Type guard: returns true when `p` is a well-formed `TextPart`. */
export const isTextPart = (p: unknown): p is TextPart => {
  if (!p || typeof p !== "object") return false;
  const rec = p as Record<string, unknown>;
  return rec["type"] === "text" && typeof rec["text"] === "string";
};

/**
 * Filter and concatenate the text content of a prompt result. Returns
 * the empty string when the result, its data, or its parts are absent.
 * Lines are joined with `\n` to preserve the original behavior of the
 * inline closures in `dispatchGrader` and `executeDelegate`.
 */
export const extractPromptText = (res: SessionPromptResult | null | undefined): string => {
  const parts = res?.data?.parts;
  if (!parts || parts.length === 0) return "";
  const chunks: string[] = [];
  for (const p of parts) {
    if (isTextPart(p)) chunks.push(p.text);
  }
  return chunks.join("\n");
};

/** Pull the session id out of a `session.create` result, or undefined. */
export const extractSessionId = (
  res: SessionCreateResult | null | undefined,
): string | undefined => {
  return res?.data?.id;
};

// ---------------------------------------------------------------------------
// Built-in `task` tool args (narrow shape for the verify-dispatch path)
// ---------------------------------------------------------------------------

/**
 * Args shape consumed by the Option-(i) verify-dispatch path when a
 * built-in `task` tool call lands in `tool.execute.after`. Only the
 * fields the gate reads are kept; everything else is ignored.
 */
export interface TaskToolArgs {
  subagent_type?: string;
  prompt?: string;
  description?: string;
}

/**
 * Narrow an `unknown` payload to `TaskToolArgs`. Returns `null` when the
 * payload is not an object. The fields stay optional — callers must
 * tolerate missing values (same as the original `any`-typed reads).
 */
export const asTaskToolArgs = (args: unknown): TaskToolArgs | null => {
  if (!args || typeof args !== "object") return null;
  const rec = args as Record<string, unknown>;
  const out: TaskToolArgs = {};
  if (typeof rec["subagent_type"] === "string") {
    out.subagent_type = rec["subagent_type"];
  }
  if (typeof rec["prompt"] === "string") {
    out.prompt = rec["prompt"];
  }
  if (typeof rec["description"] === "string") {
    out.description = rec["description"];
  }
  return out;
};

/**
 * Narrow shape consumed by `SessionStore.registerFromChatMessage`.
 */
export interface ChatMessageInput {
  sessionID: string;
  agent?: string;
}

/**
 * Narrow an unknown hook payload to the shape `registerFromChatMessage`
 * expects. Returns `null` when the payload is not an object or lacks a
 * string `sessionID`. `agent` stays optional.
 */
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
 * Narrow shape consumed by `SessionStore.recordToolCall`.
 */
export interface ToolCallInput {
  sessionID: string;
  tool: string;
  args: unknown;
}

/**
 * Narrow an unknown hook payload to the shape `recordToolCall` expects.
 * Returns `null` when the payload is not an object, lacks string
 * `sessionID` / `tool` fields, or has no `args` property. The store
 * signature requires `args: unknown` (not optional).
 */
export const asToolCallInput = (v: unknown): ToolCallInput | null => {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  if (typeof rec["sessionID"] !== "string") return null;
  if (typeof rec["tool"] !== "string") return null;
  if (!("args" in rec)) return null;
  return { sessionID: rec["sessionID"], tool: rec["tool"], args: rec["args"] };
};

// ---------------------------------------------------------------------------
// Hook IO shapes
// ---------------------------------------------------------------------------

/**
 * Narrow shape for hook `input` and `output` payloads. The opencode plugin
 * SDK publishes its full hook contract via `import("@opencode-ai/plugin").Hooks`;
 * that interface is what `src/plugin/runtime.ts` returns. `HookPayload` is
 * kept here as the looser shape the runtime accepts when consumers want to
 * write their own adapters without the SDK's discriminated unions.
 *
 * Handler bodies still read individual fields with optional chaining
 * (e.g. `input?.sessionID`) which compiles cleanly on `unknown` and
 * `Record<string, unknown>`.
 */
export type HookPayload = Record<string, unknown>;

/**
 * Shape of the `event` hook payload: `{ event: { type, properties } }`.
 * `properties` is intentionally `unknown` — the SDK does not publish
 * a stable shape for session.idle payloads.
 */
export interface HookEventPayload {
  event?: { type?: string; properties?: unknown };
}

/**
 * Narrow shape of the `command.execute.before` hook input. The runtime
 * wraps user commands into this shape; only `command` is required.
 */
export interface CommandExecuteInput {
  command: string;
  arguments?: string;
}

/**
 * Narrow shape of the `command.execute.before` hook output. The hook
 * pushes text parts onto `parts` for `/tiers`, `/preset`, `/budget`,
 * `/bypass`, and `/router`.
 */
export interface CommandExecuteOutput {
  parts: Array<{ type: "text"; text: string }>;
}
