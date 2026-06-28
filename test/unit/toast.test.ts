import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type RouterToastClient,
  type RouterToastInput,
  showRouterToast,
} from "../../src/utils/toast";

// ---------------------------------------------------------------------------
// Toast helper (src/utils/toast.ts) — fire-and-forget TUI toast adapter.
//
// These tests pin the helper's public contract from the SDD change
// tui-toast-verification:
//   - Defaults: title "Router", variant "warning", duration 5000ms.
//   - Fire-and-forget: `showRouterToast` is synchronous (returns `void`).
//   - Missing TUI surface (undefined client, missing tui, missing
//     showToast) is a silent no-op — never throws, never rejects.
//   - A rejected `showToast()` promise is swallowed via `.catch(() => {})`
//     — the primary delegation / verification outcome is NEVER affected
//     by a toast failure.
//   - Body shape: exactly `{ title, message, variant, duration }` with
//     all fields present after defaults are applied.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe("showRouterToast — defaults", () => {
  it("calls client.tui.showToast with the documented default body", async () => {
    const showToast = vi.fn().mockResolvedValue(undefined);
    const client: RouterToastClient = { tui: { showToast } };

    showRouterToast(client, { message: "Delegation unmet after 3 attempts" });

    // Wait for the unawaited promise chain to settle so the spy is called.
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: "Router",
        message: "Delegation unmet after 3 attempts",
        variant: "warning",
        duration: 5000,
      },
    });
  });

  it("applies defaults when only message is supplied", () => {
    const showToast = vi.fn().mockResolvedValue(undefined);
    const client: RouterToastClient = { tui: { showToast } };

    showRouterToast(client, { message: "hi" });
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: "Router",
        message: "hi",
        variant: "warning",
        duration: 5000,
      },
    });
  });

  it("honours caller overrides for title, variant, and duration", () => {
    const showToast = vi.fn().mockResolvedValue(undefined);
    const client: RouterToastClient = { tui: { showToast } };

    const input: RouterToastInput = {
      message: "Delegation failed: invalid model",
      variant: "error",
      title: "Router (custom)",
      duration: 1000,
    };
    showRouterToast(client, input);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: "Router (custom)",
        message: "Delegation failed: invalid model",
        variant: "error",
        duration: 1000,
      },
    });
  });

  it("accepts every documented variant without rewriting it", () => {
    const variants = ["info", "success", "warning", "error"] as const;
    for (const variant of variants) {
      const showToast = vi.fn().mockResolvedValue(undefined);
      const client: RouterToastClient = { tui: { showToast } };

      showRouterToast(client, { message: "x", variant });
      const args = showToast.mock.calls[0]?.[0] as { body: { variant: string } } | undefined;
      expect(args?.body.variant).toBe(variant);
    }
  });
});

describe("showRouterToast — missing TUI surface (silent no-op)", () => {
  it("does not throw when client is undefined", () => {
    expect(() => showRouterToast(undefined, { message: "hi" })).not.toThrow();
  });

  it("does not throw when client.tui is missing", () => {
    const client: RouterToastClient = {};
    expect(() => showRouterToast(client, { message: "hi" })).not.toThrow();
  });

  it("does not throw when client.tui.showToast is missing", () => {
    const client: RouterToastClient = { tui: {} };
    expect(() => showRouterToast(client, { message: "hi" })).not.toThrow();
  });

  it("does not throw when client.tui.showToast is not a function", () => {
    // Some test doubles or alternative SDK shapes may set showToast to a
    // non-function value; the helper must not crash on the unexpected
    // shape.
    const client = { tui: { showToast: "not-a-function" } } as unknown as RouterToastClient;
    expect(() => showRouterToast(client, { message: "hi" })).not.toThrow();
  });
});

describe("showRouterToast — rejected showToast promise is swallowed", () => {
  it("does not propagate a rejection from client.tui.showToast", async () => {
    const showToast = vi.fn().mockRejectedValue(new Error("TUI offline"));
    const client: RouterToastClient = { tui: { showToast } };

    // Synchronous call — must not throw immediately even though the
    // returned promise will reject.
    expect(() => showRouterToast(client, { message: "hi" })).not.toThrow();

    // Drain the microtask queue so the unawaited promise rejects and
    // the `.catch(() => {})` runs. If the catch were missing, vitest's
    // unhandled-rejection handler would fail this test.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("does not throw when showToast synchronously throws either", () => {
    const showToast = vi.fn(() => {
      throw new Error("sync boom");
    });
    const client: RouterToastClient = { tui: { showToast } };

    // A synchronous throw from the underlying call should NOT escape —
    // toast failure must never change the primary outcome. The helper
    // wraps the call in a try-free path because the throw escapes before
    // any catch can attach; we accept either behavior as long as the
    // helper does not propagate. In practice the opencode SDK returns
    // promises, so the rejection path is the realistic one.
    let caught: unknown;
    try {
      showRouterToast(client, { message: "hi" });
    } catch (err) {
      caught = err;
    }
    // If a synchronous throw escaped, that's a leak — flag it.
    expect(caught).toBeUndefined();
  });
});

describe("showRouterToast — sync return contract", () => {
  it("returns void synchronously (does not return the showToast promise)", () => {
    const showToast = vi.fn().mockResolvedValue(undefined);
    const client: RouterToastClient = { tui: { showToast } };

    const ret = showRouterToast(client, { message: "hi" });
    // Must be exactly `undefined` (i.e. `void`), not a Promise. The
    // public contract is fire-and-forget — callers must NOT await the
    // helper.
    expect(ret).toBeUndefined();
  });
});
