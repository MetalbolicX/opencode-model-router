import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Loader-export contract test.
//
// OpenCode's plugin loader iterates the value exports of the entrypoint
// module (`Object.values(mod)`) and calls each as a hook factory. Adding
// any non-default value export here would cause the loader to invoke it
// at startup with no arguments and almost certainly crash.
//
// Slice 4 keeps `src/index.ts` as a thin composition root: every helper
// and adapter lives in a focused module, and `src/index.ts` only exports
// the default plugin factory. Type-only re-exports (`export type {...}`)
// compile to nothing at runtime, so the runtime namespace MUST contain
// exactly one key: `"default"`.
//
// This test is the regression guard. If a future slice accidentally
// promotes a type re-export to a value re-export, or adds a stray
// `export const ...`, this test fails before the loader misbehaves.
// ---------------------------------------------------------------------------

describe("loader-export contract", () => {
  it("runtime exports of src/index are exactly [\"default\"]", async () => {
    // ESM Module Namespace Object: keys reflect runtime exports only,
    // not type-only re-exports (which compile to nothing).
    const mod = await import("../../src/index");
    const keys = Object.keys(mod).sort();
    expect(keys).toEqual(["default"]);
  });

  it("default export is the plugin factory (a function)", async () => {
    const mod = await import("../../src/index");
    expect(typeof mod.default).toBe("function");
  });

  it("default export accepts a PluginInput and returns a hook object", async () => {
    const mod = await import("../../src/index");
    // The factory is async — awaiting it must produce an object whose
    // hook names match the opencode contract (chat.params, chat.message,
    // tool.execute.before, tool.execute.after, event, config, etc.).
    // We assert shape, not full behaviour, to keep this test stable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks: any = await mod.default({} as any);
    expect(typeof hooks).toBe("object");
    expect(hooks).not.toBeNull();
    // Named hooks must remain wired — these are the loader-facing surfaces.
    expect(typeof hooks["chat.params"]).toBe("function");
    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["experimental.text.complete"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
    expect(typeof hooks["command.execute.before"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks.config).toBe("function");
  });

  it("config hook registers both tier agents and router commands", async () => {
    const mod = await import("../../src/index");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks: any = await mod.default({} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opencodeConfig: any = { agent: undefined, command: undefined };
    await hooks.config(opencodeConfig);

    // Tier agents: tiers.json ships three tiers by default (fast/medium/heavy).
    // The active preset may vary per fixture; assert at least one agent was
    // registered rather than pinning a specific count.
    expect(typeof opencodeConfig.agent).toBe("object");
    expect(Object.keys(opencodeConfig.agent).length).toBeGreaterThan(0);

    // Router commands: all six must be present after config() runs.
    expect(typeof opencodeConfig.command).toBe("object");
    for (const name of [
      "tiers",
      "preset",
      "budget",
      "bypass",
      "annotate-plan",
      "router",
    ]) {
      expect(opencodeConfig.command[name]).toBeDefined();
      expect(typeof opencodeConfig.command[name].template).toBe("string");
      expect(typeof opencodeConfig.command[name].description).toBe("string");
    }
  });
});
