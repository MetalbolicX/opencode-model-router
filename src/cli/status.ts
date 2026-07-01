// ---------------------------------------------------------------------------
// src/cli/status.ts — `omr status` and `omr doctor` commands.
//
// `status` reports whether the plugin is installed (and at what version)
// in the global OpenCode config — it's a read-only, idempotent probe
// suitable for scripting.
//
// `doctor` runs a small battery of health checks: Node version, config
// file readability, plugin-array shape, and config-directory writability.
// Issues are reported grouped by severity; the caller (main.ts) decides
// whether the exit code reflects health.
//
// `doctor`'s writability probe touches the real filesystem directly via
// `node:fs` because `CliFs` deliberately does not expose access checks —
// the probe is best-effort and an injected in-memory fs should not pretend
// to model POSIX permissions.
// ---------------------------------------------------------------------------

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { dirname } from "node:path";
import { type CliFs, loadGlobalConfig, matchesOmr, normalizePlugin, PLUGIN_NAME } from "./config";
import { createRealFs } from "./real-fs";

export interface StatusResult {
  /** Whether an `opencode-model-router` entry is present in `plugin`. */
  installed: boolean;
  /** Resolved config path the loader used. */
  path: string;
  /** Detected on-disk format. */
  format: "json" | "jsonc";
  /** The active omr specifier, or `null` when not installed. */
  specifier: string | null;
  /** Other plugin entries preserved alongside the omr one. */
  extras: string[];
}

export interface DoctorResult {
  /** True when there are zero blocking issues. */
  ok: boolean;
  /** Blocking problems — the install flow will not work until they are fixed. */
  issues: string[];
  /** Non-blocking advisories — install may still work. */
  warnings: string[];
  /** Informational notes about what was checked. */
  info: string[];
}

const formatFromPath = (path: string): "json" | "jsonc" =>
  path.endsWith(".jsonc") ? "jsonc" : "json";

/**
 * Read-only status probe. Prints a human-readable report to stdout and
 * returns the same data as a structured result so callers (including
 * `main.ts` and tests) can consume it without parsing the message.
 */
export const runStatus = (fs: CliFs = createRealFs()): StatusResult => {
  const loaded = loadGlobalConfig(fs);
  const plugins = normalizePlugin(loaded.config.plugin);
  const omrEntries = plugins.filter(matchesOmr);
  const extras = plugins.filter((entry) => !matchesOmr(entry));
  const format = formatFromPath(loaded.path);

  console.log(`Config path:    ${loaded.path}`);
  console.log(`Format:         ${format}`);
  console.log(`Exists on disk: ${loaded.existed ? "yes" : "no (will be created on install)"}`);

  if (omrEntries.length === 0) {
    console.log(`Installed:      no`);
    return {
      installed: false,
      path: loaded.path,
      format,
      specifier: null,
      extras,
    };
  }

  // In practice `install` dedupes so at most one omr entry survives;
  // reporting the first keeps the output stable for scripting.
  const specifier = omrEntries[0] ?? null;
  console.log(`Installed:      yes`);
  console.log(`Specifier:      ${specifier}`);
  if (extras.length > 0) {
    console.log(`Other plugins:  ${extras.join(", ")}`);
  }

  return {
    installed: true,
    path: loaded.path,
    format,
    specifier,
    extras,
  };
};

/**
 * Health checks. The function does not exit on its own — it returns a
 * `DoctorResult` and `main.ts` maps `ok === false` to exit code 1.
 */
export const runDoctor = (
  fs: CliFs = createRealFs(),
  env: NodeJS.ProcessEnv = process.env,
): DoctorResult => {
  const issues: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // 1. Node major version — `package.json#engines.node` requires >= 20.
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    issues.push(`Node ${process.versions.node} detected — ${PLUGIN_NAME} requires Node >= 20`);
  } else {
    info.push(`Node ${process.versions.node} OK`);
  }

  // 2. Config file readability + format detection.
  const loaded = loadGlobalConfig(fs, env);
  const format = formatFromPath(loaded.path);
  info.push(`Config path: ${loaded.path}`);
  info.push(`Config format: ${format}`);
  if (!loaded.existed) {
    warnings.push(`Config file does not exist yet — install will create it`);
  }

  // 3. `plugin` shape — must be array, object (legacy), or absent.
  const rawPlugin = loaded.config.plugin;
  if (rawPlugin === undefined || rawPlugin === null) {
    info.push(`Plugin entries: 0`);
  } else {
    const validShape = Array.isArray(rawPlugin) || typeof rawPlugin === "object";
    if (!validShape) {
      issues.push(`config.plugin is neither array nor object — install will reset it`);
    } else {
      const plugins = normalizePlugin(rawPlugin);
      info.push(`Plugin entries: ${plugins.length}`);
      const omrCount = plugins.filter(matchesOmr).length;
      if (omrCount > 1) {
        warnings.push(`${omrCount} opencode-model-router entries present — install will dedupe`);
      }
    }
  }

  // 4. Parent dir existence + writability. We probe the real filesystem
  // because POSIX permissions are not something the in-memory `CliFs` can
  // meaningfully model. Failures here are warnings, not blocking issues:
  // install will surface a real error when it tries to write.
  try {
    const dir = dirname(loaded.path);
    try {
      const stat = statSync(dir);
      if (stat.isDirectory()) {
        try {
          accessSync(dir, fsConstants.W_OK);
          info.push(`Config directory writable: ${dir}`);
        } catch {
          warnings.push(`Config directory ${dir} is not writable`);
        }
      } else {
        issues.push(`${dir} exists but is not a directory`);
      }
    } catch {
      warnings.push(
        `Config directory ${dir} does not exist yet — will be created on first install`,
      );
    }
  } catch {
    // best-effort — never block on permission probes
  }

  // Render the report. Order: info, warnings, errors, summary.
  for (const line of info) console.log(`  ✓ ${line}`);
  for (const line of warnings) console.warn(`  ! ${line}`);
  for (const line of issues) console.error(`  ✗ ${line}`);

  const ok = issues.length === 0;
  if (ok) {
    console.log(`\n✓ Doctor: all checks passed`);
  } else {
    console.log(`\n✗ Doctor: ${issues.length} issue(s) found`);
  }

  return { ok, issues, warnings, info };
};
