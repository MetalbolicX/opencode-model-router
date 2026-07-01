import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Plan C4 / R9: tests and dev-only config must NEVER ship in the npm package.
// The package.json `files` allowlist is the mechanism; this test is the guard
// that proves it stays correct as the test/ tree and tooling grow.
describe("packaging: published tarball excludes tests and dev config (plan C4)", () => {
  it("npm pack --dry-run ships only the allowlisted files", () => {
    const raw = execSync("npm pack --dry-run --json", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const paths = parsed.flatMap((p) => p.files.map((f) => f.path.replace(/\\/g, "/"))).sort();

    // MUST NOT ship tests, docs, tmp, coverage, or dev config.
    expect(paths.some((p) => p.startsWith("test/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("docs/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("tmp/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("coverage/"))).toBe(false);
    expect(paths).not.toContain("tsconfig.json");
    expect(paths).not.toContain("vitest.config.ts");

    // MUST ship the runtime entry point and config.
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("tiers.json");
  });
});

// Plan omr-cli PR 3: the package.json `bin` field wires the `omr` command to the
// built CLI, and the build must emit both the plugin and CLI bundles as .mjs.
// These tests are cheap static checks so a misconfigured package or build is
// caught at `pnpm test` time, before publish.
describe("packaging: `omr` CLI bin + built .mjs bundles", () => {
  it("package.json wires `omr` to ./dist/cli.mjs and ships dist/", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      bin?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.bin?.omr).toBe("./dist/cli.mjs");
    expect(pkg.files ?? []).toContain("dist/");
  });

  it("build emits dist/plugin.mjs and dist/cli.mjs", () => {
    expect(existsSync("dist/plugin.mjs")).toBe(true);
    expect(existsSync("dist/cli.mjs")).toBe(true);
  });
});
