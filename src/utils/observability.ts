// ---------------------------------------------------------------------------
// src/utils/observability.ts — Structured JSON logger for runtime events.
//
// This module is the single home for runtime observability in the
// opencode-model-router plugin. It exists for three reasons:
//
// 1. Tests want deterministic, captured output. A wrapper that funnels
//    every event through `console.{log,warn,error}` (with level filtering
//    and JSON encoding) keeps the call sites clean and the test spies
//    uniform.
//
// 2. Operators want a single log surface they can grep. Every event
//    carries the same envelope — `{ ts, level, event, ...payload }` —
//    so `grep '"event":"delegation.escalated"'` works without per-call
//    format gymnastics.
//
// 3. We want no external dependencies. The whole module is ~120 lines
//    of stdlib-only code (no pino, no winston, no chalk).
//
// Log levels are filtered by `MODEL_ROUTER_LOG_LEVEL`:
//   - "debug" — every event, including verbose cache + dispatch traces
//   - "info"  — the default; operator-visible lifecycle events
//   - "warn"  — recoverable failures (stale-serve, abort, etc.)
//   - "error" — fail-loud conditions (verify fail-closed, etc.)
//
// The module also exports a `child(bindings)` factory so call sites can
// pre-bind common context (e.g., `{ session: sid }`) without repeating it
// on every event. Children inherit the parent's level + sink.
//
// Sink selection:
//   - debug / info  → stdout (`console.log`)
//   - warn / error  → stderr (`console.warn` / `console.error`)
// This matches the convention used by every other `console.warn` call in
// the codebase, so a developer's existing terminal setup keeps working.
//
// The verbose MODEL_ROUTER_LOG env gate from PR5's earlier config-store
// logger is preserved as a backstop: when set to "1", debug-level events
// become visible regardless of the level setting (useful for one-shot
// diagnosis without changing the configured level).
// ---------------------------------------------------------------------------

/** Canonical log levels in increasing severity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Top-level reserved keys managed by the logger. Callers MUST NOT set
 *  these on `bindings` or per-call payload; the logger is the sole source
 *  for `ts` and `level`. The `event` key is NOT stripped from payloads —
 *  the caller's `event` is the contract for what the event is — but it
 *  IS stripped from BINDINGS so a child logger cannot spoof a different
 *  event name. */
const STRICT_RESERVED = new Set(["ts", "level"]);
const BINDING_RESERVED = new Set(["ts", "level", "event"]);

/** Resolve the effective log level. Precedence:
 *   1. `MODEL_ROUTER_LOG_LEVEL` env var (debug | info | warn | error).
 *   2. The default ("info") — every operator-visible event fires, debug
 *      events are silenced unless explicitly opted in. */
const resolveLevel = (): LogLevel => {
  const raw = process.env["MODEL_ROUTER_LOG_LEVEL"];
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
};

/** Decide whether `eventLevel` should be emitted under the current config. */
const shouldEmit = (eventLevel: LogLevel, configured: LogLevel): boolean => {
  return LEVEL_RANK[eventLevel] >= LEVEL_RANK[configured];
};

/** Pick the right console.* sink for a level. Centralized so tests and
 *  the production code agree on where each level lands. */
const sink = (level: LogLevel): ((line: string) => void) => {
  if (level === "error") {
    return (line) => {
      // eslint-disable-next-line no-console
      console.error(line);
    };
  }
  if (level === "warn") {
    return (line) => {
      // eslint-disable-next-line no-console
      console.warn(line);
    };
  }
  // debug + info → stdout.
  return (line) => {
    // eslint-disable-next-line no-console
    console.log(line);
  };
};

/** The canonical event envelope. Every emitted line is one JSON object
 *  with at minimum the four reserved keys plus the caller's bindings. */
export interface LogPayload {
  /** Event name in dot.notation (e.g., "delegation.escalated"). Required. */
  event: string;
  /** Free-form structured fields. Reserved keys are stripped if present. */
  [field: string]: unknown;
}

/** A logger pre-bound to a set of context fields. Use the top-level
 *  `log()` / `logDebug()` helpers for one-shot calls; create a child
 *  via `child({ session, ... })` when a module emits many events that
 *  share context. */
export interface Logger {
  debug(payload: LogPayload): void;
  info(payload: LogPayload): void;
  warn(payload: LogPayload): void;
  error(payload: LogPayload): void;
  /** Spawn a child logger with the given bindings merged in. Children
   *  inherit the parent's effective level — there is no per-child override. */
  child(bindings: Record<string, unknown>): Logger;
}

/** Strip reserved keys from caller-supplied bindings/payloads so a
 *  caller cannot accidentally overwrite `ts` / `level` (or, for bindings,
 *  spoof a different `event` name). */
const stripStrict = (obj: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!STRICT_RESERVED.has(k)) out[k] = v;
  }
  return out;
};
const stripBindings = (obj: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!BINDING_RESERVED.has(k)) out[k] = v;
  }
  return out;
};

/** Internal: build a logger closure bound to `parentBindings`. The
 *  closure re-reads the configured level on every call so a process
 *  can change `MODEL_ROUTER_LOG_LEVEL` mid-run without a restart. */
const makeLogger = (parentBindings: Record<string, unknown>): Logger => {
  const emit = (level: LogLevel, payload: LogPayload): void => {
    const configured = resolveLevel();
    if (!shouldEmit(level, configured)) return;
    // Bindings contribute fields but the per-call payload always wins on
    // overlap. Reserved keys (ts / level) are stripped from both so the
    // logger is the sole source for them. The `event` name is preserved
    // from the caller's payload — it's the contract for what the event
    // is — but the bindings cannot spoof it either.
    const envelope = {
      ts: new Date().toISOString(),
      level,
      ...stripBindings(parentBindings),
      ...stripStrict(payload),
    };
    const line = `[model-router] ${JSON.stringify(envelope)}`;
    sink(level)(line);
  };

  return {
    debug: (p) => emit("debug", p),
    info: (p) => emit("info", p),
    warn: (p) => emit("warn", p),
    error: (p) => emit("error", p),
    child: (bindings) => makeLogger({ ...parentBindings, ...stripBindings(bindings) }),
  };
};

/** The root logger. Every module that wants to emit a structured event
 *  imports `log` and calls `log.info({ event: "...", ... })`.
 *
 *  The exported `log` is a thin proxy over an internal mutable holder so
 *  tests can call `__resetLoggerForTest()` after mutating
 *  `MODEL_ROUTER_LOG_LEVEL` without re-importing the module. The proxy
 *  forwards every method call to the current root logger, so swap-out is
 *  transparent to call sites. */
const rootLogger: { current: Logger } = { current: makeLogger({}) };

export const log: Logger = {
  debug: (p) => rootLogger.current.debug(p),
  info: (p) => rootLogger.current.info(p),
  warn: (p) => rootLogger.current.warn(p),
  error: (p) => rootLogger.current.error(p),
  child: (b) => rootLogger.current.child(b),
};

/** Reset for tests only — re-creates the root logger with the current env.
 *  No production code should call this; tests call it after mutating
 *  `MODEL_ROUTER_LOG_LEVEL` so the change takes effect without a reload. */
export const __resetLoggerForTest = (): void => {
  rootLogger.current = makeLogger({});
};

// ---------------------------------------------------------------------------
// Convenience helpers — short-form for the common event names.
//
// These exist purely so call sites can write `logEvent.delegation.escalated(...)`
// instead of `log.info({ event: "delegation.escalated", ... })`. The names
// here are the canonical event vocabulary; treat additions as a contract
// change and update any matching tests / dashboards.
// ---------------------------------------------------------------------------

export const logEvent = {
  // config layer
  config: {
    refresh(payload: Omit<LogPayload, "event">): void {
      log.info({ event: "config.refresh", ...payload });
    },
    staleServe(payload: Omit<LogPayload, "event">): void {
      log.warn({ event: "config.stale_serve", ...payload });
    },
  },
  // routing layer
  routing: {
    delegated(payload: Omit<LogPayload, "event">): void {
      log.info({ event: "routing.delegated", ...payload });
    },
    escalated(payload: Omit<LogPayload, "event">): void {
      log.info({ event: "routing.escalated", ...payload });
    },
    accepted(payload: Omit<LogPayload, "event">): void {
      log.info({ event: "routing.accepted", ...payload });
    },
    unmet(payload: Omit<LogPayload, "event">): void {
      log.warn({ event: "routing.unmet", ...payload });
    },
    aborted(payload: Omit<LogPayload, "event">): void {
      log.warn({ event: "routing.aborted", ...payload });
    },
    // Non-retryable prompt failure (e.g. billing / model-not-found / auth).
    // `nonretryable` is the CAUSE event (what stopped us from retrying);
    // `unmet` is the TERMINAL outcome event (the delegation has stopped).
    // Fires at warn level so operators can grep for policy stops without
    // the noise of every retryable transport blip.
    nonretryable(payload: Omit<LogPayload, "event">): void {
      log.warn({ event: "routing.nonretryable", ...payload });
    },
    // Retryable prompt failure (e.g. HTTP 429 rate limit, transient
    // transport error). Fires at debug level because retryable events
    // are noisy under default info level — opt in via
    // MODEL_ROUTER_LOG_LEVEL=debug when diagnosing ladder behaviour.
    retryable(payload: Omit<LogPayload, "event">): void {
      log.debug({ event: "routing.retryable", ...payload });
    },
  },
  // verification layer
  verification: {
    pass(payload: Omit<LogPayload, "event">): void {
      log.info({ event: "verification.pass", ...payload });
    },
    fail(payload: Omit<LogPayload, "event">): void {
      log.warn({ event: "verification.fail", ...payload });
    },
    skipped(payload: Omit<LogPayload, "event">): void {
      log.debug({ event: "verification.skipped", ...payload });
    },
  },
  // lifecycle
  lifecycle: {
    shutdown(payload: Omit<LogPayload, "event">): void {
      log.debug({ event: "lifecycle.shutdown", ...payload });
    },
    startup(payload: Omit<LogPayload, "event">): void {
      log.debug({ event: "lifecycle.startup", ...payload });
    },
  },
} as const;
