/**
 * scripts/build-tiers-config.ts
 *
 * Build-time assembler for the layered `tiers.json` config.
 *
 * `tiers.json` is the runtime configuration consumed by `loadConfig()`
 * (see `src/router/config.ts`). It is built from four concern-scoped
 * part files under `config/tiers/`:
 *
 *   - `base.json`           — top-level routing state
 *                             (activePreset, activeMode, tierCaps, defaultTier)
 *   - `presets.json`        — preset → tier model definitions
 *   - `prompts.json`        — per-tier system prompts (long text)
 *   - `task-patterns.json`  — taskPatterns, modes, fallback, rules
 *
 * The merged output MUST preserve the original `tiers.json` key order
 * (`activePreset`, `activeMode`, `tierCaps`, `tierPrompts`, `presets`,
 * `taskPatterns`, `modes`, `fallback`, `rules`, `defaultTier`) so
 * `loadConfig()` sees the same shape regardless of which side of the
 * split produced it. The merge is therefore NOT a flat part-by-part
 * concatenation — it follows an explicit MERGE_PLAN that interleaves
 * the parts to match the original key order.
 *
 * PR3 phase 6 invariant: the merged output is semantically identical
 * to the original single-file `tiers.json` (same key order, same
 * values). Formatting (whitespace, inline-vs-multiline objects) MAY
 * differ from the original — only the parsed JSON shape is pinned.
 *
 * Invoked by the `prebuild` script in package.json so every published
 * build regenerates `tiers.json` from the four parts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const TIERS_DIR = join(repoRoot, "config", "tiers");
const OUTPUT_PATH = join(repoRoot, "tiers.json");

// One logical source file.
type PartName = "base" | "presets" | "prompts" | "task-patterns";

const PART_PATHS: Record<PartName, string> = {
  base: join(TIERS_DIR, "base.json"),
  presets: join(TIERS_DIR, "presets.json"),
  prompts: join(TIERS_DIR, "prompts.json"),
  "task-patterns": join(TIERS_DIR, "task-patterns.json"),
};

// Explicit merge plan. Each entry pulls the listed keys (or ALL keys, if
// `keys` is omitted) from the named part, in the order listed. The
// resulting key order in `merged` is the concatenation of all entries —
// which must match the original `tiers.json` key order.
//
//   1. base            → activePreset, activeMode, tierCaps
//   2. prompts         → tierPrompts
//   3. presets         → presets
//   4. task-patterns   → taskPatterns, modes, fallback, rules
//   5. base            → defaultTier, reasoningPolicy (reasoningPolicy is
//                        appended after defaultTier so it sits at the end
//                        of the merged `tiers.json`, matching its place in
//                        `base.json`).
const MERGE_PLAN: Array<{ part: PartName; keys?: string[] }> = [
  { part: "base", keys: ["activePreset", "activeMode", "tierCaps"] },
  { part: "prompts" },
  { part: "presets" },
  { part: "task-patterns" },
  { part: "base", keys: ["defaultTier", "reasoningPolicy"] },
];

const partCache = new Map<PartName, Record<string, unknown>>();

const readPart = (part: PartName): Record<string, unknown> => {
  const cached = partCache.get(part);
  if (cached) return cached;

  const path = PART_PATHS[part];
  if (!existsSync(path)) {
    throw new Error(`build-tiers-config: missing part file "${part}" at ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `build-tiers-config: cannot read part "${part}" at ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `build-tiers-config: part "${part}" (${path}) contains malformed JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`build-tiers-config: part "${part}" must be a JSON object`);
  }
  partCache.set(part, parsed as Record<string, unknown>);
  return parsed as Record<string, unknown>;
};

const main = (): void => {
  const merged: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const step of MERGE_PLAN) {
    const data = readPart(step.part);
    const keysToPick = step.keys ?? Object.keys(data);
    for (const key of keysToPick) {
      if (!(key in data)) {
        throw new Error(
          `build-tiers-config: merge plan references missing key "${key}" in part "${step.part}"`,
        );
      }
      if (seen.has(key)) {
        throw new Error(
          `build-tiers-config: duplicate top-level key "${key}" in merge plan (from part "${step.part}")`,
        );
      }
      merged[key] = data[key];
      seen.add(key);
    }
  }

  // Sanity check: every key from every part must be consumed by the
  // merge plan. Otherwise a key in a part file is silently dropped
  // when the build runs — exactly the kind of "missing field" bug
  // the split is meant to prevent.
  for (const part of Object.keys(PART_PATHS) as PartName[]) {
    const data = readPart(part);
    for (const key of Object.keys(data)) {
      if (!seen.has(key)) {
        throw new Error(
          `build-tiers-config: part "${part}" has key "${key}" that is not referenced by the merge plan`,
        );
      }
    }
  }

  // Write the merged output with 2-space indentation (matches the
  // original `tiers.json` style). The trailing newline is intentional
  // — POSIX text files end with a newline.
  const output = JSON.stringify(merged, null, 2) + "\n";
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, output, "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    `build-tiers-config: wrote ${OUTPUT_PATH} (${Object.keys(merged).length} top-level keys, ${MERGE_PLAN.length} merge steps)`,
  );
};

main();
