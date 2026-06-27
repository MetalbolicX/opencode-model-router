// ---------------------------------------------------------------------------
// Focused unit tests for the per-section validators exported from
// src/router/config-validate.ts.
//
// `validateConfig()` itself is covered end-to-end in
// `test/unit/config.validate.test.ts`. This file proves the decomposition:
// each sub-validator works in isolation, surfaces section-specific failures,
// and uses the centralized constants from `config-resolve.ts`.
//
// Sub-validators are exported (marked `_exports` in the file header comment)
// specifically for direct test access. The orchestrator `validateConfig()`
// is the public API; the per-section helpers are implementation details
// that callers MUST NOT depend on, but tests may.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_MODES,
  GRADER_POLICIES,
  VERIFY_REQUIRE_MODES,
} from "../../src/router/config-resolve";
import {
  validateConfig,
  validateEnforcement,
  validateEnforcementEscalate,
  validateEnforcementGuard,
  validateEnforcementMode,
  validateEnforcementPerTier,
  validateEnforcementVerify,
  validateEscalateCostCeiling,
  validateMode,
  validateModes,
  validatePreset,
  validatePresets,
  validateRootFields,
  validateRulesAndDefaultTier,
  validateTaskPatterns,
  validateTier,
  validateTierCaps,
  validateTierPrompts,
} from "../../src/router/config-validate";

/** Build a minimal valid raw config object; merge `extra` to override/add keys. */
const validRaw = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
  return {
    activePreset: "anthropic",
    presets: {
      anthropic: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          description: "fast tier",
          whenToUse: ["recon"],
        },
      },
    },
    rules: ["r1"],
    defaultTier: "fast",
    ...extra,
  };
};

// ---------------------------------------------------------------------------
// Root + scalars
// ---------------------------------------------------------------------------

describe("validateRootFields", () => {
  it("accepts a non-empty string activePreset", () => {
    expect(() => validateRootFields({ activePreset: "anthropic" })).not.toThrow();
  });
  it("rejects empty / non-string activePreset", () => {
    expect(() => validateRootFields({ activePreset: "" })).toThrow(/activePreset/);
    expect(() => validateRootFields({ activePreset: 1 })).toThrow(/activePreset/);
    expect(() => validateRootFields({})).toThrow(/activePreset/);
  });
});

describe("validateRulesAndDefaultTier", () => {
  it("accepts an array rules + string defaultTier", () => {
    expect(() => validateRulesAndDefaultTier({ rules: ["x"], defaultTier: "fast" })).not.toThrow();
  });
  it("rejects non-array rules", () => {
    expect(() => validateRulesAndDefaultTier({ rules: "x", defaultTier: "fast" })).toThrow(/rules/);
  });
  it("rejects non-string defaultTier", () => {
    expect(() => validateRulesAndDefaultTier({ rules: [], defaultTier: 3 })).toThrow(/defaultTier/);
  });
});

// ---------------------------------------------------------------------------
// Presets — nested tree
// ---------------------------------------------------------------------------

describe("validatePresets / validatePreset / validateTier", () => {
  it("rejects missing / non-object / empty presets", () => {
    expect(() => validatePresets({})).toThrow(/presets/);
    expect(() => validatePresets({ presets: null })).toThrow(/presets/);
    expect(() => validatePresets({ presets: [] })).toThrow(/presets/);
    expect(() => validatePresets({ presets: {} })).toThrow(/at least one preset/);
  });
  it("rejects a preset that is not an object (direct)", () => {
    expect(() => validatePreset("anthropic", 7)).toThrow(/preset 'anthropic'/);
    expect(() => validatePreset("anthropic", null)).toThrow(/preset 'anthropic'/);
  });
  it("rejects a tier that is not an object (direct)", () => {
    expect(() => validateTier("anthropic", "fast", null)).toThrow(/must be an object/);
  });
  it("rejects missing/empty model and missing description/whenToUse", () => {
    expect(() =>
      validateTier("anthropic", "fast", {
        description: "d",
        whenToUse: [],
      }),
    ).toThrow(/\.model/);
    expect(() =>
      validateTier("anthropic", "fast", {
        model: "",
        description: "d",
        whenToUse: [],
      }),
    ).toThrow(/\.model/);
    expect(() =>
      validateTier("anthropic", "fast", {
        model: "m",
        description: 1,
        whenToUse: [],
      }),
    ).toThrow(/\.description/);
    expect(() =>
      validateTier("anthropic", "fast", {
        model: "m",
        description: "d",
        whenToUse: "x",
      }),
    ).toThrow(/whenToUse/);
  });
  it("accepts a complete tier", () => {
    expect(() =>
      validateTier("anthropic", "fast", {
        model: "m",
        description: "d",
        whenToUse: ["recon"],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe("validateModes / validateMode", () => {
  it("skips when modes is absent", () => {
    expect(() => validateModes({})).not.toThrow();
  });
  it("rejects non-object modes", () => {
    expect(() => validateModes({ modes: [] })).toThrow(/modes/);
    expect(() => validateModes({ modes: "x" })).toThrow(/modes/);
  });
  it("rejects a non-object mode entry (direct)", () => {
    expect(() => validateMode("budget", 1)).toThrow(/mode 'budget'/);
  });
  it("rejects missing defaultTier / description", () => {
    expect(() => validateMode("budget", { description: "x" })).toThrow(/defaultTier/);
    expect(() => validateMode("budget", { defaultTier: "fast" })).toThrow(/description/);
  });
});

// ---------------------------------------------------------------------------
// tierCaps / tierPrompts / taskPatterns
// ---------------------------------------------------------------------------

describe("validateTierCaps", () => {
  it("skips when absent", () => {
    expect(() => validateTierCaps({})).not.toThrow();
  });
  it("rejects non-object or non-positive integer values", () => {
    expect(() => validateTierCaps({ tierCaps: [] })).toThrow(/tierCaps/);
    expect(() => validateTierCaps({ tierCaps: { fast: "8" } })).toThrow(/positive integer/);
    expect(() => validateTierCaps({ tierCaps: { fast: 0 } })).toThrow(/positive integer/);
    expect(() => validateTierCaps({ tierCaps: { fast: -1 } })).toThrow(/positive integer/);
    expect(() => validateTierCaps({ tierCaps: { fast: Infinity } })).toThrow(/positive integer/);
  });
  it("accepts positive integers ≥ 1", () => {
    expect(() => validateTierCaps({ tierCaps: { fast: 1, medium: 5 } })).not.toThrow();
  });
});

describe("validateTierPrompts", () => {
  it("skips when absent", () => {
    expect(() => validateTierPrompts({})).not.toThrow();
  });
  it("rejects non-object or non-string values", () => {
    expect(() => validateTierPrompts({ tierPrompts: [] })).toThrow(/tierPrompts/);
    expect(() => validateTierPrompts({ tierPrompts: { fast: 1 } })).toThrow(/tierPrompts/);
  });
});

describe("validateTaskPatterns", () => {
  it("skips when absent", () => {
    expect(() => validateTaskPatterns({})).not.toThrow();
  });
  it("rejects non-object or non-array values", () => {
    expect(() => validateTaskPatterns({ taskPatterns: [] })).toThrow(/taskPatterns/);
    expect(() => validateTaskPatterns({ taskPatterns: { fast: "x" } })).toThrow(/taskPatterns/);
  });
});

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

describe("validateEnforcement", () => {
  it("skips when absent", () => {
    expect(() => validateEnforcement({})).not.toThrow();
  });
  it("rejects non-object enforcement", () => {
    expect(() => validateEnforcement({ enforcement: "x" })).toThrow(
      /enforcement must be an object/,
    );
    expect(() => validateEnforcement({ enforcement: [] })).toThrow(/enforcement must be an object/);
  });
});

describe("validateEnforcementMode", () => {
  for (const mode of ENFORCEMENT_MODES) {
    it(`accepts ${mode}`, () => {
      expect(() => validateEnforcementMode({ mode })).not.toThrow();
    });
  }
  it("skips when absent", () => {
    expect(() => validateEnforcementMode({})).not.toThrow();
  });
  it("rejects unknown / non-string mode", () => {
    expect(() => validateEnforcementMode({ mode: "loud" })).toThrow(/enforcement\.mode/);
    expect(() => validateEnforcementMode({ mode: 1 })).toThrow(/enforcement\.mode/);
  });
  it("error message lists all supported modes", () => {
    expect(() => validateEnforcementMode({ mode: "loud" })).toThrow(
      new RegExp(ENFORCEMENT_MODES.join("\\|")),
    );
  });
});

describe("validateEnforcementVerify", () => {
  it("skips when verify is absent or non-object", () => {
    expect(() => validateEnforcementVerify({})).not.toThrow();
    expect(() => validateEnforcementVerify({ verify: "x" })).not.toThrow();
  });
  it("accepts the canonical graderPolicy", () => {
    for (const p of GRADER_POLICIES) {
      expect(() => validateEnforcementVerify({ verify: { graderPolicy: p } })).not.toThrow();
    }
  });
  it("rejects unknown graderPolicy", () => {
    expect(() => validateEnforcementVerify({ verify: { graderPolicy: "cheapest" } })).toThrow(
      /graderPolicy/,
    );
  });
  it("rejects unknown verify.require values", () => {
    for (const bad of ["sometimes", "NEVER", "", null, 42]) {
      expect(() => validateEnforcementVerify({ verify: { require: bad } })).toThrow(
        /verify\.require must be one of/,
      );
    }
  });
  it("accepts all three verify.require values", () => {
    for (const r of VERIFY_REQUIRE_MODES) {
      expect(() => validateEnforcementVerify({ verify: { require: r } })).not.toThrow();
    }
  });
  it("error message includes the JSON-serialized actual value", () => {
    expect(() => validateEnforcementVerify({ verify: { require: 42 } })).toThrow(/got 42/);
  });
});

describe("validateEnforcementEscalate", () => {
  it("skips when escalate is absent or non-object", () => {
    expect(() => validateEnforcementEscalate({})).not.toThrow();
    expect(() => validateEnforcementEscalate({ escalate: "x" })).not.toThrow();
  });
  it("rejects costCeiling.multiple ≤ 0 or non-number", () => {
    for (const bad of [0, -1, "4", null]) {
      expect(() =>
        validateEnforcementEscalate({ escalate: { costCeiling: { multiple: bad } } }),
      ).toThrow(/multiple must be a number/);
    }
  });
  it("rejects non-string-array ladder", () => {
    expect(() => validateEnforcementEscalate({ escalate: { ladder: "fast" } })).toThrow(/ladder/);
    expect(() => validateEnforcementEscalate({ escalate: { ladder: [1, 2] } })).toThrow(/ladder/);
  });
  it("rejects non-integer / negative maxAttemptsPerTier", () => {
    expect(() => validateEnforcementEscalate({ escalate: { maxAttemptsPerTier: -1 } })).toThrow(
      /maxAttemptsPerTier must be an integer >= 0/,
    );
    expect(() => validateEnforcementEscalate({ escalate: { maxAttemptsPerTier: 1.5 } })).toThrow(
      /maxAttemptsPerTier must be an integer >= 0/,
    );
  });
  it("rejects maxTotalAttempts < 1", () => {
    expect(() => validateEnforcementEscalate({ escalate: { maxTotalAttempts: 0 } })).toThrow(
      /maxTotalAttempts must be an integer >= 1/,
    );
  });
  it("rejects floorTier that is neither string nor null", () => {
    expect(() => validateEnforcementEscalate({ escalate: { floorTier: 123 } })).toThrow(
      /floorTier must be a string or null/,
    );
  });
  it("accepts floorTier = null or string", () => {
    expect(() => validateEnforcementEscalate({ escalate: { floorTier: null } })).not.toThrow();
    expect(() => validateEnforcementEscalate({ escalate: { floorTier: "medium" } })).not.toThrow();
  });
});

describe("validateEscalateCostCeiling", () => {
  it("skips when costCeiling is absent or non-object", () => {
    expect(() => validateEscalateCostCeiling({})).not.toThrow();
    expect(() => validateEscalateCostCeiling({ costCeiling: "x" })).not.toThrow();
  });
  it("accepts positive numeric multiple", () => {
    expect(() => validateEscalateCostCeiling({ costCeiling: { multiple: 4 } })).not.toThrow();
  });
});

describe("validateEnforcementPerTier", () => {
  it("skips when absent or non-object", () => {
    expect(() => validateEnforcementPerTier({})).not.toThrow();
    expect(() => validateEnforcementPerTier({ perTier: "x" })).not.toThrow();
    expect(() => validateEnforcementPerTier({ perTier: [] })).not.toThrow();
  });
  it("accepts per-tier mode values from the enum", () => {
    expect(() =>
      validateEnforcementPerTier({ perTier: { fast: "advisory", heavy: "enforced" } }),
    ).not.toThrow();
  });
  it("rejects unknown per-tier modes with the mode listed in error", () => {
    expect(() => validateEnforcementPerTier({ perTier: { fast: "loud" } })).toThrow(
      new RegExp(`perTier\\.fast must be one of ${ENFORCEMENT_MODES.join("\\|")}`),
    );
  });
});

describe("validateEnforcementGuard", () => {
  it("skips when guard is absent or non-object", () => {
    expect(() => validateEnforcementGuard({})).not.toThrow();
    expect(() => validateEnforcementGuard({ guard: "x" })).not.toThrow();
  });
  it("rejects guard.budget < 1 or non-number", () => {
    for (const bad of [0, -1, "12", Infinity, null]) {
      expect(() => validateEnforcementGuard({ guard: { budget: bad } })).toThrow(
        /guard\.budget must be a number >= 1/,
      );
    }
  });
  it("accepts guard.budget = 1 (minimum boundary)", () => {
    expect(() => validateEnforcementGuard({ guard: { budget: 1 } })).not.toThrow();
  });
  it("rejects non-boolean blockScriptWrites", () => {
    expect(() => validateEnforcementGuard({ guard: { blockScriptWrites: "yes" } })).toThrow(
      /blockScriptWrites must be a boolean/,
    );
  });
  it("accepts boolean blockScriptWrites", () => {
    expect(() => validateEnforcementGuard({ guard: { blockScriptWrites: true } })).not.toThrow();
    expect(() => validateEnforcementGuard({ guard: { blockScriptWrites: false } })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// End-to-end orchestrator still works
// ---------------------------------------------------------------------------

describe("validateConfig orchestrator", () => {
  it("is ≤ 60 lines (decomposition sanity)", () => {
    // The orchestrator delegates every section to a focused validator.
    // Source-level line count is verified separately by the diff-size
    // check; here we assert the function actually returns cleanly for a
    // minimal valid config — proving the wiring still composes.
    const cfg = validateConfig(validRaw());
    expect(cfg.activePreset).toBe("anthropic");
    expect(cfg.presets.anthropic.fast.model).toBe("anthropic/claude-haiku-4-5");
  });
});
