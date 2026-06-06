import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateConfig } from "../../src/router/config";
import { assembleSystemPrompt } from "../../src/router/protocol";

const cfg = validateConfig(
  JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")),
);

const MODELS: (string | undefined)[] = [
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5",
  undefined,
];

describe("GA-1: enforcement OFF adds zero tokens", () => {
  for (const model of MODELS) {
    const label = model ?? "undefined";

    it(`model=${label}: default param is byte-identical to explicit false`, () => {
      expect(assembleSystemPrompt(cfg, model)).toBe(
        assembleSystemPrompt(cfg, model, false),
      );
    });

    it(`model=${label}: off-mode output contains no DoD markers`, () => {
      const off = assembleSystemPrompt(cfg, model, false);
      expect(off).not.toContain("[acceptance]");
      expect(off).not.toMatch(/Definition of Done/i);
    });
  }
});

describe("GA-7: enforcement ON injects a bounded DoD section", () => {
  const ON_MODELS: string[] = [
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5",
  ];

  for (const model of ON_MODELS) {
    it(`model=${model}: enforcement-on is longer and contains [acceptance]`, () => {
      const off = assembleSystemPrompt(cfg, model, false);
      const on = assembleSystemPrompt(cfg, model, true);

      expect(on.length).toBeGreaterThan(off.length);
      expect(on).toContain("[acceptance]");

      const added = on.length - off.length;
      const approxTokens = Math.ceil(added / 4);
      console.info(
        `[GA-7] model=${model} enforcement-on adds ${added} chars (~${approxTokens} tokens)`,
      );

      expect(added).toBeGreaterThan(0);
      expect(added).toBeLessThanOrEqual(4000);
    });

    it(`model=${model}: off-mode contains none of the on-only DoD section`, () => {
      const off = assembleSystemPrompt(cfg, model, false);
      expect(off).not.toContain("[acceptance]");
    });
  }
});
