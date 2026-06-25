// ---------------------------------------------------------------------------
// test/unit/timeout.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { withTimeout } from "../../src/utils/timeout";

describe("withTimeout", () => {
  it("resolves with the value when promise completes within timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "test");
    expect(result).toBe("ok");
  });

  it("rejects with timeout error when promise is slower than timeout", async () => {
    await expect(
      withTimeout(new Promise(() => {}), 10, "slow-promise"),
    ).rejects.toThrow("slow-promise timed out after 10ms");
  });

  it("includes the label in the timeout error message", async () => {
    await expect(
      withTimeout(new Promise(() => {}), 10, "custom-label"),
    ).rejects.toThrow("custom-label");
  });

  it("rejects with the original error when promise rejects before timeout", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("original")), 1000, "test"),
    ).rejects.toThrow("original");
  });
});