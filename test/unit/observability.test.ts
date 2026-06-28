import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLoggerForTest,
  type Logger,
  type LogLevel,
  log,
  logEvent,
} from "../../src/utils/observability";

// ---------------------------------------------------------------------------
// Structured logger (src/utils/observability.ts).
//
// Tests cover:
//   - Envelope shape (ts / level / event + caller payload).
//   - Level filtering via MODEL_ROUTER_LOG_LEVEL.
//   - Sink routing (debug/info → stdout, warn/error → stderr).
//   - Reserved-key protection (caller cannot overwrite ts/level/event).
//   - child() bindings merge + propagate.
//   - Convenience helpers (`logEvent.*`) emit the documented event names.
//   - Production default is "info" — debug events are silenced unless
//     explicitly opted in.
// ---------------------------------------------------------------------------

let origLevel: string | undefined;
let origLog: string | undefined;

beforeEach(() => {
  origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
  origLog = process.env["MODEL_ROUTER_LOG"];
});

afterEach(() => {
  if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
  else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
  if (origLog === undefined) delete process.env["MODEL_ROUTER_LOG"];
  else process.env["MODEL_ROUTER_LOG"] = origLog;
  __resetLoggerForTest();
  vi.restoreAllMocks();
});

/** Extract a single JSON envelope from a `console.log` spy call. */
const extractEnvelope = (line: string): Record<string, unknown> => {
  const start = line.indexOf("{");
  if (start < 0) throw new Error(`No JSON object in log line: ${line}`);
  return JSON.parse(line.slice(start));
};

/** Filter captured console calls down to the ones our logger emitted. */
const filterLoggerLines = (calls: unknown[][]): string[] => {
  return calls.map((c) => String(c[0] ?? "")).filter((l) => l.startsWith("[model-router] "));
};

describe("observability — envelope shape", () => {
  it("emits a JSON envelope with ts, level, event, and caller payload", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info({ event: "test.event", foo: "bar", n: 42 });
    const lines = filterLoggerLines(spy.mock.calls);
    expect(lines).toHaveLength(1);
    const env = extractEnvelope(lines[0]!);
    expect(env["level"]).toBe("info");
    expect(env["event"]).toBe("test.event");
    expect(env["foo"]).toBe("bar");
    expect(env["n"]).toBe(42);
    expect(typeof env["ts"]).toBe("string");
    // ISO 8601-ish: 2026-06-26T...
    expect(env["ts"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("prefixes every line with [model-router] for grep-ability", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.debug({ event: "x" });
    const lines = filterLoggerLines(spy.mock.calls);
    expect(lines[0]).toMatch(/^\[model-router\] \{/);
  });

  it("the envelope is a single line (no embedded newlines)", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info({ event: "x", payload: { a: 1, b: "two\nlines" } });
    const lines = filterLoggerLines(spy.mock.calls);
    expect(lines[0]).not.toContain("\n");
  });
});

describe("observability — level filtering", () => {
  const cases: Array<{ env: LogLevel; emits: Array<"debug" | "info" | "warn" | "error"> }> = [
    { env: "debug", emits: ["debug", "info", "warn", "error"] },
    { env: "info", emits: ["info", "warn", "error"] },
    { env: "warn", emits: ["warn", "error"] },
    { env: "error", emits: ["error"] },
  ];
  for (const { env, emits } of cases) {
    it(`at level=${env}, emits exactly: ${emits.join(", ")}`, () => {
      process.env["MODEL_ROUTER_LOG_LEVEL"] = env;
      __resetLoggerForTest();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      log.debug({ event: "x" });
      log.info({ event: "x" });
      log.warn({ event: "x" });
      log.error({ event: "x" });

      const collected = (spy: ReturnType<typeof vi.spyOn>): LogLevel[] => {
        return filterLoggerLines(spy.mock.calls).map((line) => {
          const env = extractEnvelope(line);
          return env["level"] as LogLevel;
        });
      };
      const allEmitted: LogLevel[] = [
        ...collected(logSpy),
        ...collected(warnSpy),
        ...collected(errSpy),
      ];
      allEmitted.sort();
      expect(allEmitted).toEqual([...emits].sort());
    });
  }

  it("defaults to info when MODEL_ROUTER_LOG_LEVEL is unset", () => {
    delete process.env["MODEL_ROUTER_LOG_LEVEL"];
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.debug({ event: "x" });
    log.info({ event: "x" });
    log.warn({ event: "x" });
    expect(filterLoggerLines(logSpy.mock.calls)).toHaveLength(1);
    expect(filterLoggerLines(warnSpy.mock.calls)).toHaveLength(1);
  });

  it("falls back to info when MODEL_ROUTER_LOG_LEVEL is an unknown value", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "verbose";
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.debug({ event: "x" });
    log.info({ event: "x" });
    expect(filterLoggerLines(logSpy.mock.calls)).toHaveLength(1);
  });
});

describe("observability — sink routing", () => {
  it("debug and info land on stdout (console.log)", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.debug({ event: "x" });
    log.info({ event: "x" });
    expect(filterLoggerLines(logSpy.mock.calls)).toHaveLength(2);
    expect(filterLoggerLines(warnSpy.mock.calls)).toHaveLength(0);
    expect(filterLoggerLines(errSpy.mock.calls)).toHaveLength(0);
  });

  it("warn lands on stderr (console.warn)", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "info";
    __resetLoggerForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.warn({ event: "x" });
    expect(filterLoggerLines(warnSpy.mock.calls)).toHaveLength(1);
  });

  it("error lands on stderr (console.error)", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "info";
    __resetLoggerForTest();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error({ event: "x" });
    expect(filterLoggerLines(errSpy.mock.calls)).toHaveLength(1);
  });
});

describe("observability — reserved key protection", () => {
  it("cannot be tricked into overwriting ts/level/event via the payload", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Cast through `unknown as LogPayload` so we can sneak reserved keys
    // past the type checker. The runtime contract (stripReserved) is
    // what we're actually testing here.
    const sneaky = {
      event: "real.event",
      ts: "FAKE-TIMESTAMP",
      level: "error",
      safe: "ok",
    } as unknown as { event: string; [k: string]: unknown };
    log.info(sneaky as never);
    const env = extractEnvelope(filterLoggerLines(spy.mock.calls)[0]!);
    expect(env["event"]).toBe("real.event");
    expect(env["level"]).toBe("info");
    expect(env["ts"]).not.toBe("FAKE-TIMESTAMP");
    expect(typeof env["ts"]).toBe("string");
    expect(env["safe"]).toBe("ok");
  });

  it("child bindings also strip reserved keys", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sneaky = {
      session: "sess-1",
      event: "child.event",
      ts: "X",
      level: "error",
    } as unknown as Record<string, unknown>;
    const child = log.child(sneaky);
    child.info({ event: "real.event", extra: 1 });
    const env = extractEnvelope(filterLoggerLines(spy.mock.calls)[0]!);
    expect(env["session"]).toBe("sess-1");
    expect(env["event"]).toBe("real.event");
    expect(env["level"]).toBe("info");
    expect(env["ts"]).not.toBe("X");
  });
});

describe("observability — child loggers", () => {
  it("child bindings are merged into every event", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const child = log.child({ session: "sess-42", tier: "fast" });
    child.info({ event: "x" });
    child.debug({ event: "y", extra: "value" });
    const lines = filterLoggerLines(spy.mock.calls);
    expect(lines).toHaveLength(2);
    const a = extractEnvelope(lines[0]!);
    const b = extractEnvelope(lines[1]!);
    expect(a["session"]).toBe("sess-42");
    expect(a["tier"]).toBe("fast");
    expect(a["event"]).toBe("x");
    expect(b["extra"]).toBe("value");
    expect(b["session"]).toBe("sess-42");
  });

  it("per-event payload overrides child bindings (later wins)", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const child = log.child({ session: "sess-A" });
    child.info({ event: "x", session: "sess-B" });
    const env = extractEnvelope(filterLoggerLines(spy.mock.calls)[0]!);
    expect(env["session"]).toBe("sess-B");
  });

  it("nested children accumulate bindings (grandchild gets parent's keys)", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const grand = log.child({ a: 1 }).child({ b: 2 });
    grand.info({ event: "x" });
    const env = extractEnvelope(filterLoggerLines(spy.mock.calls)[0]!);
    expect(env["a"]).toBe(1);
    expect(env["b"]).toBe(2);
  });
});

describe("observability — convenience helpers (logEvent)", () => {
  it("emits the documented event names", () => {
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logEvent.config.refresh({ loadedAt: 1, ttlMs: 1000, activePreset: "x" });
    logEvent.routing.delegated({ sid: "s", tier: "fast", attempt: 1, isRetry: false });
    logEvent.routing.escalated({ sid: "s", from: "fast", to: "medium", reason: "x", attempts: 1 });
    logEvent.routing.accepted({ sid: "s", finalTier: "medium", totalAttempts: 1, escalations: 1 });
    logEvent.routing.aborted({ phase: "loop-top", attempts: 1 });
    logEvent.verification.pass({
      sid: "s",
      producerTier: "fast",
      method: "deterministic",
      dodSource: "explicit",
      skipped: false,
      reasonCount: 0,
    });
    logEvent.lifecycle.startup({ phase: "loaded" });
    logEvent.lifecycle.shutdown({ phase: "complete" });

    logEvent.config.staleServe({ loadedAt: 1, ttlMs: 1000, activePreset: "x", error: "boom" });
    logEvent.routing.unmet({ reason: "safety-net", attempts: 5 });
    logEvent.verification.fail({
      sid: "s",
      producerTier: "fast",
      method: "checker",
      dodSource: "explicit",
      skipped: false,
      reasonCount: 1,
      reasons: ["x"],
    });

    const infoLines = filterLoggerLines(logSpy.mock.calls).map((l) => extractEnvelope(l).event);
    const warnLines = filterLoggerLines(warnSpy.mock.calls).map((l) => extractEnvelope(l).event);

    expect(infoLines).toContain("config.refresh");
    expect(infoLines).toContain("routing.delegated");
    expect(infoLines).toContain("routing.escalated");
    expect(infoLines).toContain("routing.accepted");
    expect(infoLines).toContain("verification.pass");
    expect(infoLines).toContain("lifecycle.startup");
    expect(infoLines).toContain("lifecycle.shutdown");

    expect(warnLines).toContain("config.stale_serve");
    expect(warnLines).toContain("routing.unmet");
    expect(warnLines).toContain("routing.aborted");
    expect(warnLines).toContain("verification.fail");
  });

  it("routing.nonretryable emits at warn level with the documented payload fields", () => {
    // routing.nonretryable is the CAUSE event for non-retryable prompt
    // failures and the pre-prompt tierModel guard failure. Fires at warn
    // level so operators can grep for policy stops at the default info
    // log level without opt-in.
    delete process.env["MODEL_ROUTER_LOG_LEVEL"];
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logEvent.routing.nonretryable({
      reason: "model not found",
      tier: "fast",
      attempt: 1,
    });
    // Default level is "info" — warn events fire, log (info+debug) does NOT.
    expect(filterLoggerLines(logSpy.mock.calls)).toHaveLength(0);
    const warnLines = filterLoggerLines(warnSpy.mock.calls);
    expect(warnLines).toHaveLength(1);
    const env = extractEnvelope(warnLines[0]!);
    expect(env["event"]).toBe("routing.nonretryable");
    expect(env["level"]).toBe("warn");
    expect(env["reason"]).toBe("model not found");
    expect(env["tier"]).toBe("fast");
    expect(env["attempt"]).toBe(1);
  });

  it("routing.retryable emits at debug level (silenced at default info level)", () => {
    // routing.retryable is the CAUSE event for retryable prompt failures
    // (HTTP 429, transient transport). Fires at debug level because it is
    // noisy under default info level — opt-in via MODEL_ROUTER_LOG_LEVEL=debug.
    delete process.env["MODEL_ROUTER_LOG_LEVEL"];
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent.routing.retryable({
      reason: "rate limited",
      tier: "fast",
      attempt: 1,
    });
    // Default level is "info" — debug events must NOT fire.
    expect(filterLoggerLines(logSpy.mock.calls)).toHaveLength(0);

    // Opt-in to debug — now it should fire.
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    logEvent.routing.retryable({
      reason: "rate limited",
      tier: "fast",
      attempt: 1,
    });
    const lines = filterLoggerLines(logSpy.mock.calls);
    expect(lines).toHaveLength(1);
    const env = extractEnvelope(lines[0]!);
    expect(env["event"]).toBe("routing.retryable");
    expect(env["level"]).toBe("debug");
    expect(env["reason"]).toBe("rate limited");
    expect(env["tier"]).toBe("fast");
    expect(env["attempt"]).toBe(1);
  });

  it("routing.nonretryable + routing.retryable appear in the documented event vocabulary", () => {
    // Pin the event names + level routing as part of the public contract:
    // adding these to the `emits the documented event names` assertion
    // catches any future rename silently that would break operator dashboards.
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logEvent.routing.nonretryable({ reason: "x", tier: "fast", attempt: 1 });
    logEvent.routing.retryable({ reason: "y", tier: "fast", attempt: 1 });

    const warnEvents = filterLoggerLines(warnSpy.mock.calls).map((l) => extractEnvelope(l).event);
    const logEvents = filterLoggerLines(logSpy.mock.calls).map((l) => extractEnvelope(l).event);
    expect(warnEvents).toContain("routing.nonretryable");
    expect(logEvents).toContain("routing.retryable");
  });

  it("verification.skipped is debug-level (silenced at default info level)", () => {
    delete process.env["MODEL_ROUTER_LOG_LEVEL"];
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent.verification.skipped({
      sid: "s",
      producerTier: "fast",
      method: "none",
      dodSource: "inferred",
      skipped: true,
      reasonCount: 1,
    });
    // Default level is "info"; debug events must NOT fire.
    expect(filterLoggerLines(logSpy.mock.calls)).toHaveLength(0);

    // Opt-in to debug — now it should fire.
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();
    logEvent.verification.skipped({
      sid: "s",
      producerTier: "fast",
      method: "none",
      dodSource: "inferred",
      skipped: true,
      reasonCount: 1,
    });
    const lines = filterLoggerLines(logSpy.mock.calls);
    expect(lines).toHaveLength(1);
    expect(extractEnvelope(lines[0]!).event).toBe("verification.skipped");
  });
});

describe("Logger interface — type contract", () => {
  it("exposes debug/info/warn/error and child as functions", () => {
    const l: Logger = log;
    expect(typeof l.debug).toBe("function");
    expect(typeof l.info).toBe("function");
    expect(typeof l.warn).toBe("function");
    expect(typeof l.error).toBe("function");
    expect(typeof l.child).toBe("function");
    expect(typeof l.child({}).info).toBe("function");
  });
});
