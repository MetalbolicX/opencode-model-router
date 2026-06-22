// ---------------------------------------------------------------------------
// src/utils/shell.ts — Live exec seam factory.
//
// The original inline closure in src/index.ts wrapped node:child_process.exec
// with: a default cwd derived from PluginInput.directory, a default timeout
// of 120000 ms, a 10 MiB stdout buffer, and a fail-closed return shape
// `{ code: 1, stdout: "", stderr: "exec failed", timedOut: false }` for any
// exception that escaped the underlying call.
//
// createExecSeam preserves those exact defaults and the same return shape
// (including the SIGTERM timeout detection) so existing live verification
// behaviour stays byte-identical.
// ---------------------------------------------------------------------------

import { exec as nodeExec } from "node:child_process";
import type { ExecSeam, ExecResult } from "../verify/types";

/** Per-call options accepted by the exec seam. */
export interface ExecSeamOptions {
  /** Override the seam's default cwd (which itself defaults to `ctx.directory`). */
  cwd?: string;
  /** Override the seam's default 120000 ms timeout. */
  timeoutMs?: number;
}

/** Minimum input the seam factory needs to derive a default cwd. */
export interface ExecSeamContext {
  /** Default cwd for commands that don't supply their own. */
  directory?: string;
}

/** Default timeout for exec calls that don't supply their own. */
const DEFAULT_TIMEOUT_MS = 120000;

/** 10 MiB maxBuffer — preserves the original inline closure's value. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Placeholder stderr returned when the underlying call throws synchronously. */
const FAIL_CLOSED_STDERR = "exec failed";

/** Build a fail-closed ExecResult for thrown exceptions. */
function failClosed(): ExecResult {
  return { code: 1, stdout: "", stderr: FAIL_CLOSED_STDERR, timedOut: false };
}

/**
 * Create a live exec seam bound to the given directory. The returned function
 * resolves (never rejects) for any underlying error, mirroring the original
 * inline closure: shell errors and timeouts resolve to an ExecResult with
 * `code` set, stdout/stderr captured, and `timedOut` flagged when the child
 * was killed by SIGTERM. Synchronous throws resolve to the fail-closed shape.
 */
export function createExecSeam(ctx: ExecSeamContext): ExecSeam {
  return (command, opts) =>
    new Promise<ExecResult>((resolve) => {
      try {
        nodeExec(
          command,
          {
            cwd: opts?.cwd ?? ctx.directory,
            timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER_BYTES,
            windowsHide: true,
          },
          (err: any, stdout: any, stderr: any) => {
            const timedOut = !!(err && err.killed && err.signal === "SIGTERM");
            const code =
              err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            resolve({
              code,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              timedOut,
            });
          },
        );
      } catch {
        resolve(failClosed());
      }
    });
}
