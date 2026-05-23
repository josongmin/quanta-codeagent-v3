/**
 * RFC may-22-unified-agent-runtime / Phase 4+ — interactive mode-preset
 * runner contract.
 *
 * Pins the contract:
 *   1. `runMode` rejects a non-"interactive" req.mode.
 *   2. With `seams.runAgent` stub, the real REPL is NEVER invoked.
 *   3. With `seams.runRepl` stub, the REPL is delegated to the stub.
 *   4. Returned RunOutcome carries `exitCode` (and `outcome?` when runAgent fires).
 *   5. The assembled config (visible via seams.runAgent's captured cfg) has
 *      modePolicy.mode === "interactive" and reviewer-backed permission.
 */
import { describe, expect, test } from "bun:test";
import { runMode } from "@/../src/apps/agent/mode-presets/interactive";
import { defaultTools, ToolRegistry } from "@/tool";
const fakeLlm = {
    model: "test",
    stream: async function* () {
        yield { type: "message_stop", stop_reason: "end_turn" };
    },
};
const recordingStream = { emit: () => undefined };
const baseReq = (over = {}) => ({
    mode: "interactive",
    base: {
        llm: fakeLlm,
        registry: new ToolRegistry(defaultTools),
        stream: recordingStream,
        permission: { mode: "default" },
        messages: [],
        system: "",
        cwd: "/tmp",
        maxTurns: 5,
        signal: new AbortController().signal,
    },
    ...over,
});
const fakeOutcome = (reason) => ({
    reason,
    turns: 1,
    messages: [],
});
describe("interactive.runMode — guard", () => {
    test("rejects a wrong req.mode", async () => {
        const req = { ...baseReq(), mode: "headless" };
        await expect(runMode(req)).rejects.toThrow(/req.mode must be "interactive"/);
    });
});
describe("interactive.runMode — hermetic via seams.runAgent", () => {
    test("uses seams.runAgent and skips the real REPL", async () => {
        let cfgSeen;
        const seams = {
            runAgent: async (cfg) => {
                cfgSeen = cfg;
                return fakeOutcome("completed");
            },
        };
        const out = await runMode(baseReq({ seams }));
        expect(out.exitCode).toBe(0);
        expect(out.outcome?.reason).toBe("completed");
        expect(cfgSeen).toBeDefined();
        expect(cfgSeen?.modePolicy?.mode).toBe("interactive");
        expect(cfgSeen?.modePolicy?.permission.kind).toBe("reviewer-backed");
        expect(cfgSeen?.budgetMeter).toBeDefined();
    });
    test("maps reason=error to exitCode=1", async () => {
        const seams = { runAgent: async () => fakeOutcome("error") };
        const out = await runMode(baseReq({ seams }));
        expect(out.exitCode).toBe(1);
    });
});
describe("interactive.runMode — REPL delegate", () => {
    test("invokes seams.runRepl when no seams.runAgent is set", async () => {
        let called = 0;
        const seams = {
            runRepl: async () => {
                called += 1;
            },
        };
        const out = await runMode(baseReq({ seams }));
        expect(called).toBe(1);
        expect(out.exitCode).toBe(0);
        expect(out.outcome).toBeUndefined();
    });
    test("converts AbortError to exitCode 130", async () => {
        const seams = {
            runRepl: async () => {
                const e = new Error("aborted");
                e.name = "AbortError";
                throw e;
            },
        };
        const out = await runMode(baseReq({ seams }));
        expect(out.exitCode).toBe(130);
    });
    test("re-throws non-abort errors", async () => {
        const seams = {
            runRepl: async () => {
                throw new Error("fatal config error");
            },
        };
        await expect(runMode(baseReq({ seams }))).rejects.toThrow(/fatal config error/);
    });
});
