import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { readMergedConfig } from "../../src/router/config-loader";
import { getActiveTiers } from "../../src/router/protocol";
import { createSessionStore } from "../../src/router/sessions";

/**
 * Phase 0.3 acceptance + DoD:
 *  - trajectory is recorded for a simulated subagent session (record-only);
 *  - GA-1: the model-visible banner output is byte-identical to the pre-wiring
 *    behaviour (the trajectory observation must add NOTHING to output).
 */

function trajFile(sid: string): string {
  return join(tmpdir(), "opencode-model-router-trajectory", `${sid}.log`);
}

afterEach(() => {
  delete process.env.MODEL_ROUTER_TRAJECTORY_DEBUG;
});

describe("trajectory wiring (Phase 0.3, record-only)", () => {
  it("GA-1: emitted cap banner is byte-identical with trajectory wiring active", async () => {
    const plugin: any = await ModelRouterPlugin({} as any);
    const cfg = readMergedConfig({ cwd: process.cwd() });
    const tierNames = Object.keys(getActiveTiers(cfg));
    const ref = createSessionStore();

    const msg = { agent: "fast", sessionID: "ses_ga1" };
    const dispatch = { parts: [{ text: "do recon" }] };
    await plugin["chat.message"](msg, dispatch);
    ref.registerFromChatMessage(msg, dispatch, cfg, tierNames);

    const toolInput = { sessionID: "ses_ga1", tool: "read", args: { file_path: "a.ts" } };
    const outPlugin: any = { output: "RESULT" };
    const outRef: any = { output: "RESULT" };
    await plugin["tool.execute.after"](toolInput, outPlugin);
    ref.recordToolCall(toolInput, outRef);

    // The plugin (with trajectory observation) must emit EXACTLY what a bare
    // session store emits — trajectory recording is invisible to the model.
    expect(outPlugin.output).toBe(outRef.output);
    expect(outPlugin.output).toContain("[cap: 1/8]");
  });

  it("does NOT track or dump orchestrator (non-subagent) sessions", async () => {
    process.env.MODEL_ROUTER_TRAJECTORY_DEBUG = "1";
    const plugin: any = await ModelRouterPlugin({} as any);
    const sid = "ses_orchestrator";
    // No chat.message registering this as a subagent → not tracked.
    const out: any = { output: "RESULT" };
    await plugin["tool.execute.after"]({ sessionID: sid, tool: "read", args: { file_path: "a.ts" } }, out);
    await plugin["event"]({ event: { type: "session.idle", properties: { sessionID: sid } } });
    expect(out.output).toBe("RESULT"); // untouched
    expect(() => readFileSync(trajFile(sid), "utf-8")).toThrow(); // no dump file
  });

  it("records a subagent trajectory and writes a gated debug dump on session.idle", async () => {
    process.env.MODEL_ROUTER_TRAJECTORY_DEBUG = "1";
    const plugin: any = await ModelRouterPlugin({} as any);
    const sid = "ses_traj_dump";
    rmSync(trajFile(sid), { force: true });

    await plugin["chat.message"]({ agent: "fast", sessionID: sid }, { parts: [{ text: "recon" }] });
    // one read-only call + one producing (edit) call → tool_call_count = 2, ttfa = 2
    await plugin["tool.execute.after"]({ sessionID: sid, tool: "read", args: { file_path: "a.ts" } }, { output: "R" });
    await plugin["tool.execute.after"]({ sessionID: sid, tool: "edit", args: { file_path: "a.ts" } }, { output: "E" });
    await plugin["event"]({ event: { type: "session.idle", properties: { sessionID: sid } } });

    const content = readFileSync(trajFile(sid), "utf-8");
    expect(content).toContain(`[trajectory ${sid}]`);
    expect(content).toContain('"tool_call_count":2');
    expect(content).toContain('"ttfa":2');

    rmSync(trajFile(sid), { force: true });
  });

  it("debug dump is a no-op when MODEL_ROUTER_TRAJECTORY_DEBUG is unset", async () => {
    const plugin: any = await ModelRouterPlugin({} as any);
    const sid = "ses_no_debug";
    rmSync(trajFile(sid), { force: true });
    await plugin["chat.message"]({ agent: "fast", sessionID: sid }, { parts: [{ text: "recon" }] });
    await plugin["tool.execute.after"]({ sessionID: sid, tool: "read", args: { file_path: "a.ts" } }, { output: "R" });
    await plugin["event"]({ event: { type: "session.idle", properties: { sessionID: sid } } });
    expect(() => readFileSync(trajFile(sid), "utf-8")).toThrow(); // no file written
  });
});
