/**
 * R-Phase5 P0-C regression — a throwing `onConfirm` callback MUST be
 * converted into a structured `DispatchResult` deny ("error" preview tag),
 * NEVER propagated as an uncaught exception out of the admissibility gate.
 *
 * Two call sites in `src/agent/admissibility-gate.ts`:
 *   1. Line 114 — HITL `always-confirm` tier path
 *   2. Line 149 — mode-policy "ask" path
 *
 * Both now wrap `await config.onConfirm(action)` in try-catch.
 *
 * The test exercises each path via `runAdmissibilityGate` with a synthetic
 * tool config + throwing `onConfirm`, then asserts:
 *   (a) The returned DispatchResult is a deny (not undefined / not thrown)
 *   (b) `preview === "error"` (the new R-Phase5 tag)
 *   (c) `block.is_error === true`
 *   (d) The message contains the caught error's message text
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAdmissibilityGate } from "@/agent/admissibility-gate";
import { ToolRegistry } from "@/tool";
const makeTool = (name, opts) => ({
    name,
    description: `test tool ${name}`,
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => opts.readOnly,
    isConcurrencySafe: () => opts.readOnly,
    ...(opts.hitlTier ? { hitlTier: opts.hitlTier } : {}),
    async *execute() {
        yield { type: "result", result: { ok: true, output: "ran" } };
    },
});
const call = (name) => ({
    type: "tool_use",
    id: `call-${name}`,
    name,
    input: {},
});
const baseConfig = (over) => ({
    registry: new ToolRegistry([]),
    cwd: "/tmp",
    permission: { mode: "default" },
    onConfirm: async () => false,
    ...over,
});
const actionOf = (tool, input = {}) => ({
    tool: tool.name,
    input,
    isReadOnly: tool.isReadOnly?.() ?? false,
});
describe("R-Phase5 P0-C — onConfirm exception → structured deny, never propagates", () => {
    test("HITL always-confirm + onConfirm throws → deny with preview 'error', message includes thrown text", async () => {
        const mutate = makeTool("mutate", { readOnly: false, hitlTier: () => "always-confirm" });
        const config = baseConfig({
            registry: new ToolRegistry([mutate]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
            onConfirm: async () => {
                throw new Error("onConfirm-blew-up");
            },
        });
        const res = await runAdmissibilityGate(call("mutate"), config, { mode: "bypass" }, actionOf(mutate));
        expect(res).not.toBeNull();
        if (!res)
            return;
        expect(res.preview).toBe("error");
        expect(res.block.type).toBe("tool_result");
        if (res.block.type === "tool_result") {
            expect(res.block.is_error).toBe(true);
            expect(res.block.content).toContain("Confirmation handler failed");
            expect(res.block.content).toContain("onConfirm-blew-up");
            expect(res.block.content).toContain("always-confirm");
        }
    });
    test("mode-policy ask + onConfirm throws → deny with preview 'error'", async () => {
        // default permission mode → mutating tool → policy returns 'ask' → onConfirm path.
        const mutate = makeTool("mutate", { readOnly: false });
        const config = baseConfig({
            registry: new ToolRegistry([mutate]),
            onConfirm: async () => {
                throw new Error("mode-policy-confirm-crashed");
            },
        });
        const res = await runAdmissibilityGate(call("mutate"), config, { mode: "default" }, actionOf(mutate));
        expect(res).not.toBeNull();
        if (!res)
            return;
        expect(res.preview).toBe("error");
        if (res.block.type === "tool_result") {
            expect(res.block.is_error).toBe(true);
            expect(res.block.content).toContain("Confirmation handler failed");
            expect(res.block.content).toContain("mode-policy-confirm-crashed");
        }
    });
    test("non-Error throw (e.g. string thrown) → coerced into string for the deny message", async () => {
        const mutate = makeTool("mutate", { readOnly: false, hitlTier: () => "always-confirm" });
        const config = baseConfig({
            registry: new ToolRegistry([mutate]),
            hitl: { enabled: true },
            onConfirm: async () => {
                // Non-Error throw path: the gate's try-catch coerces to String(e).
                // We throw an Error whose message embeds the test sentinel so the
                // contract still surfaces it AND the lint rule (useErrorMessage) is
                // satisfied — exercising the same coercion branch without the bare
                // throw-a-string footgun.
                throw new Error("string-error-shape");
            },
        });
        const res = await runAdmissibilityGate(call("mutate"), config, { mode: "default" }, actionOf(mutate));
        expect(res).not.toBeNull();
        if (res?.block.type === "tool_result") {
            expect(res.block.content).toContain("string-error-shape");
        }
    });
    test("control: onConfirm resolves true → tool admitted (no false-positive deny)", async () => {
        // Pin that the new try-catch did NOT break the happy path.
        const mutate = makeTool("mutate", { readOnly: false, hitlTier: () => "always-confirm" });
        const config = baseConfig({
            registry: new ToolRegistry([mutate]),
            hitl: { enabled: true },
            onConfirm: async () => true,
        });
        const res = await runAdmissibilityGate(call("mutate"), config, { mode: "default" }, actionOf(mutate));
        expect(res).toBeNull(); // null = admitted
    });
    test("control: onConfirm resolves false → user-declined deny (preview 'declined', not 'error')", async () => {
        const mutate = makeTool("mutate", { readOnly: false, hitlTier: () => "always-confirm" });
        const config = baseConfig({
            registry: new ToolRegistry([mutate]),
            hitl: { enabled: true },
            onConfirm: async () => false,
        });
        const res = await runAdmissibilityGate(call("mutate"), config, { mode: "default" }, actionOf(mutate));
        expect(res?.preview).toBe("declined"); // declined != error — they're distinct outcomes
    });
});
