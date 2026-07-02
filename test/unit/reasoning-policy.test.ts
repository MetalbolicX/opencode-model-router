import { describe, expect, it } from "vitest";
import type { ReasoningCapability, ReasoningLevel } from "../../src/reasoning/capability";
import { resolveReasoningOverride } from "../../src/reasoning/policy";
import { createReasoningStore } from "../../src/reasoning/store";
import type { ReasoningPolicyConfig, TierConfig } from "../../src/router/config.types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseTier = (overrides: Partial<TierConfig> = {}): TierConfig => ({
  model: "test/model",
  description: "test tier",
  whenToUse: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// resolveReasoningOverride — static mode is the primary regression guard
// ---------------------------------------------------------------------------

describe("resolveReasoningOverride — static mode (regression guard)", () => {
  const tier = baseTier({ variant: "thinking" });
  const staticPolicy: ReasoningPolicyConfig = { mode: "static" };

  it("returns null for every level when policy mode is static", () => {
    const levels: ReasoningLevel[] = ["minimal", "normal", "elevated", "max"];
    for (const level of levels) {
      expect(resolveReasoningOverride(tier, staticPolicy, level)).toBeNull();
    }
  });

  it("returns null even when a session override is set (static ignores overrides)", () => {
    expect(resolveReasoningOverride(tier, staticPolicy, "elevated")).toBeNull();
    expect(resolveReasoningOverride(tier, staticPolicy, "max")).toBeNull();
  });

  it("returns null when reasoningPolicy is absent (default = static)", () => {
    expect(resolveReasoningOverride(tier, undefined, "elevated")).toBeNull();
  });

  it("static with surfaceLimits:true still returns null (limits are not applied in static mode)", () => {
    expect(
      resolveReasoningOverride(tier, { mode: "static", surfaceLimits: true }, "elevated"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveReasoningOverride — manual mode applies the override (or default)
// ---------------------------------------------------------------------------

describe("resolveReasoningOverride — manual mode applies override", () => {
  const discreteTier = baseTier({
    reasoning: { effort: "high" }, // -> discrete / reasoning.effort / 3-level ladder
  });
  const binaryTier = baseTier({ variant: "thinking" }); // -> binary / variant / elevated="thinking"
  const budgetedTier = baseTier({ thinking: { budgetTokens: 4096 } }); // -> budgeted
  const manualPolicy: ReasoningPolicyConfig = { mode: "manual" };

  it("translates the session override for a discrete / reasoning.effort tier", () => {
    expect(resolveReasoningOverride(discreteTier, manualPolicy, "max")).toEqual({
      options: { reasoning_effort: "high" },
    });
    expect(resolveReasoningOverride(discreteTier, manualPolicy, "minimal")).toEqual({
      options: { reasoning_effort: "low" },
    });
  });

  it("translates the session override for a binary tier", () => {
    expect(resolveReasoningOverride(binaryTier, manualPolicy, "elevated")).toEqual({
      variant: "thinking",
    });
  });

  it("translates the session override for a budgeted tier", () => {
    expect(resolveReasoningOverride(budgetedTier, manualPolicy, "max")).toEqual({
      options: { budget_tokens: 16000 },
    });
  });

  it("manual mode with no override falls back to defaultLevel", () => {
    const policy: ReasoningPolicyConfig = { mode: "manual", defaultLevel: "elevated" };
    expect(resolveReasoningOverride(binaryTier, policy)).toEqual({ variant: "thinking" });
  });

  it("manual mode with no override AND no defaultLevel returns null", () => {
    expect(resolveReasoningOverride(binaryTier, manualPolicy)).toBeNull();
  });

  it("session override wins over defaultLevel", () => {
    const policy: ReasoningPolicyConfig = { mode: "manual", defaultLevel: "minimal" };
    expect(resolveReasoningOverride(binaryTier, policy, "max")).toEqual({
      variant: "thinking",
    });
  });

  it("never mutates a none-capability tier", () => {
    const noneTier = baseTier(); // no reasoning fields
    expect(resolveReasoningOverride(noneTier, manualPolicy, "elevated")).toBeNull();
    expect(resolveReasoningOverride(noneTier, manualPolicy, "max")).toBeNull();
  });

  it("explicit capability declaration wins over inference", () => {
    const cap: ReasoningCapability = {
      kind: "binary",
      field: "variant",
      elevated: "max",
    };
    const tierWithCap = baseTier({ capability: cap, variant: "thinking" });
    // Capability says elevated="max" — overrides the inference path that
    // would have used variant="thinking".
    expect(resolveReasoningOverride(tierWithCap, manualPolicy, "elevated")).toEqual({
      variant: "max",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveReasoningOverride — adaptive mode is a stub (returns null)
// ---------------------------------------------------------------------------

describe("resolveReasoningOverride — adaptive mode (stub)", () => {
  const tier = baseTier({ variant: "thinking" });

  it("returns null for every level under adaptive mode", () => {
    const policy: ReasoningPolicyConfig = { mode: "adaptive" };
    const levels: ReasoningLevel[] = ["minimal", "normal", "elevated", "max"];
    for (const level of levels) {
      expect(resolveReasoningOverride(tier, policy, level)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// createReasoningStore — per-session override lifecycle
// ---------------------------------------------------------------------------

describe("createReasoningStore — session override lifecycle", () => {
  it("getOverride returns undefined before set", () => {
    const store = createReasoningStore();
    expect(store.getOverride("s1")).toBeUndefined();
  });

  it("setOverride + getOverride round-trips a level", () => {
    const store = createReasoningStore();
    store.setOverride("s1", "elevated");
    expect(store.getOverride("s1")).toBe("elevated");
  });

  it("clearOverride drops the override for one session only", () => {
    const store = createReasoningStore();
    store.setOverride("s1", "max");
    store.setOverride("s2", "minimal");
    store.clearOverride("s1");
    expect(store.getOverride("s1")).toBeUndefined();
    expect(store.getOverride("s2")).toBe("minimal");
  });

  it("clear(sessionID) also releases any tier ownership the session was holding", () => {
    const store = createReasoningStore();
    store.setOverride("s1", "max");
    store.acquireTierOwner("fast", "s1");
    store.acquireTierOwner("heavy", "s1");
    store.acquireTierOwner("medium", "s2"); // owned by a different session
    store.clear("s1");
    expect(store.getOverride("s1")).toBeUndefined();
    // s1's locks are released
    expect(store.getTierOwner("fast")).toBeUndefined();
    expect(store.getTierOwner("heavy")).toBeUndefined();
    // s2's lock survives — clear is scoped to the session
    expect(store.getTierOwner("medium")).toBe("s2");
  });

  it("two sessions are isolated (the spec scenario)", () => {
    const store = createReasoningStore();
    store.setOverride("session-A", "max");
    // session-B is untouched
    expect(store.getOverride("session-B")).toBeUndefined();
    // Clearing session-B does not affect session-A
    store.clearOverride("session-B");
    expect(store.getOverride("session-A")).toBe("max");
  });
});

// ---------------------------------------------------------------------------
// createReasoningStore — tier baseline + per-tier in-flight ownership
// ---------------------------------------------------------------------------

describe("createReasoningStore — tier baseline + in-flight ownership", () => {
  it("setBaseline / getBaseline round-trips the agent def reference", () => {
    const store = createReasoningStore();
    const baseline = { model: "test/model", variant: "thinking", options: { foo: "bar" } };
    store.setBaseline("medium", baseline);
    expect(store.getBaseline("medium")).toBe(baseline);
  });

  it("clear(sessionID) does NOT drop baselines (baselines are tier-scoped, not session-scoped)", () => {
    const store = createReasoningStore();
    store.setBaseline("medium", { model: "test/model" });
    store.setOverride("s1", "max");
    store.clear("s1");
    // baseline survives — it belongs to the tier, not the session
    expect(store.getBaseline("medium")).toBeDefined();
  });

  it("acquireTierOwner returns true on a free tier and records the session as owner", () => {
    const store = createReasoningStore();
    expect(store.getTierOwner("fast")).toBeUndefined();
    expect(store.acquireTierOwner("fast", "s1")).toBe(true);
    expect(store.getTierOwner("fast")).toBe("s1");
  });

  it("acquireTierOwner is idempotent for the same session (re-acquire is a no-op)", () => {
    const store = createReasoningStore();
    expect(store.acquireTierOwner("fast", "s1")).toBe(true);
    expect(store.acquireTierOwner("fast", "s1")).toBe(true);
    expect(store.getTierOwner("fast")).toBe("s1");
  });

  it("acquireTierOwner returns false when a different session already owns the tier", () => {
    const store = createReasoningStore();
    expect(store.acquireTierOwner("fast", "s1")).toBe(true);
    expect(store.acquireTierOwner("fast", "s2")).toBe(false);
    // s1 keeps the lock; s2 did not steal it
    expect(store.getTierOwner("fast")).toBe("s1");
  });

  it("tiers are independent: owning `fast` does not block `heavy`", () => {
    const store = createReasoningStore();
    expect(store.acquireTierOwner("fast", "s1")).toBe(true);
    expect(store.acquireTierOwner("heavy", "s1")).toBe(true);
    // two different sessions, two different tiers — both succeed
    expect(store.acquireTierOwner("heavy", "s2")).toBe(false);
    expect(store.getTierOwner("fast")).toBe("s1");
    expect(store.getTierOwner("heavy")).toBe("s1");
  });

  it("releaseTierOwner returns true only when the caller is the owner", () => {
    const store = createReasoningStore();
    store.acquireTierOwner("fast", "s1");
    // Foreign release — s2 is not the owner, must NOT drop s1's lock.
    expect(store.releaseTierOwner("fast", "s2")).toBe(false);
    expect(store.getTierOwner("fast")).toBe("s1");
    // Owner release — succeeds and clears the lock.
    expect(store.releaseTierOwner("fast", "s1")).toBe(true);
    expect(store.getTierOwner("fast")).toBeUndefined();
  });

  it("releaseTierOwner on a free tier is a no-op (returns false)", () => {
    const store = createReasoningStore();
    expect(store.releaseTierOwner("fast", "s1")).toBe(false);
    expect(store.getTierOwner("fast")).toBeUndefined();
  });

  it("after release, a different session can acquire the tier", () => {
    const store = createReasoningStore();
    expect(store.acquireTierOwner("fast", "s1")).toBe(true);
    expect(store.acquireTierOwner("fast", "s2")).toBe(false);
    expect(store.releaseTierOwner("fast", "s1")).toBe(true);
    expect(store.acquireTierOwner("fast", "s2")).toBe(true);
    expect(store.getTierOwner("fast")).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// Integration: policy + store agree end-to-end on the static regression guard
// ---------------------------------------------------------------------------

describe("integration — static mode never produces a patch, even with a stored override", () => {
  it("staticPolicy + setOverride still yields null from resolveReasoningOverride", () => {
    const store = createReasoningStore();
    store.setOverride("s1", "max");
    const tier = baseTier({ variant: "thinking" });
    const policy: ReasoningPolicyConfig = { mode: "static" };
    const override = store.getOverride("s1");
    expect(resolveReasoningOverride(tier, policy, override)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: surfaceLimits flag is read by policy but does NOT change the
// resolved patch (surfacing is a presentation concern, owned by the command
// handler / log layer). The flag's only effect here is that policy.ts
// ignores it — callers decide whether to emit.
// ---------------------------------------------------------------------------

describe("integration — surfaceLimits flag does not affect resolveReasoningOverride output", () => {
  it("identical patch with or without surfaceLimits", () => {
    const tier = baseTier({ variant: "thinking" });
    const policyOff: ReasoningPolicyConfig = { mode: "manual" };
    const policyOn: ReasoningPolicyConfig = { mode: "manual", surfaceLimits: true };
    expect(resolveReasoningOverride(tier, policyOff, "elevated")).toEqual(
      resolveReasoningOverride(tier, policyOn, "elevated"),
    );
  });
});
