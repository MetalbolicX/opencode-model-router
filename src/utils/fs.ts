// ---------------------------------------------------------------------------
// src/utils/fs.ts — Live fs seam factory.
//
// The original inline closure in src/index.ts provided fileExists/readFile
// helpers that resolved relative paths against PluginInput.directory while
// leaving absolute paths untouched, then delegated to node:fs/promises
// access/readFile. fileExists swallowed access errors and returned false;
// readFile propagated errors to the caller.
//
// createFsSeam preserves that exact `isAbsolute`-aware path joining and the
// same swallow-on-access-fail behaviour, so live verification paths that
// probe the workspace stay byte-identical.
// ---------------------------------------------------------------------------

import { access, readFile as fsReadFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { FsSeam } from "../verify/types";

/** Minimum input the seam factory needs to resolve relative paths. */
export interface FsSeamContext {
  /** Base directory used to resolve relative paths. */
  directory?: string;
}

/** Resolve a path: absolute paths pass through; relative paths join with `ctx.directory`. */
function resolvePath(ctx: FsSeamContext, p: string): string {
  return isAbsolute(p) ? p : join(ctx.directory ?? "", p);
}

/**
 * Create a live fs seam bound to the given directory. fileExists resolves
 * `true` when the file is accessible, `false` on any access error
 * (NOT_FOUND, EACCES, etc.) — matching the original closure's swallow-all
 * behaviour. readFile propagates errors to the caller, also matching the
 * original.
 */
export function createFsSeam(ctx: FsSeamContext): FsSeam {
  return {
    async fileExists(p: string): Promise<boolean> {
      try {
        await access(resolvePath(ctx, p));
        return true;
      } catch {
        return false;
      }
    },
    async readFile(p: string): Promise<string> {
      return await fsReadFile(resolvePath(ctx, p), "utf-8");
    },
  };
}
