/**
 * Trust-scope wire-up e2e (Phase C, ADR-0045). Exercises the full runAgent
 * stack with a `once_only` grant seeded BEFORE the run:
 *
 *   - Turn 1: LLM emits a mutating tool_use. Registry has a once_only grant
 *     ⇒ admissibility-gate SKIPS onConfirm, tool executes, the grant is
 *     consumed inline.
 *   - Turn 2: LLM emits the SAME tool_use again. Grant is gone ⇒ legacy
 *     onConfirm path runs (returns false here) ⇒ dispatch denies and the
 *     loop emits a `tool_result.ok=false`.
 *   - Turn 3: LLM closes with a text turn so the loop reaches `completed`.
 *
 * Asserts:
 *   - onConfirm was called exactly ONCE across the run.
 *   - First tool_result ok=true (executed), second tool_result ok=false
 *     (declined after grant consumption).
 *   - Loop reaches `completed` cleanly (no abort, no max_turns).
 *
 * Behavior-preserving: the test sets `trustScope` explicitly, so the
 * DEFAULT-OFF invariant is unaffected — the surrounding e2e suite still
 * passes byte-identically.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "@/agent";
import { createInMemoryTrustScopeRegistry } from "@/permission";
import { defaultTools, ToolRegistry } from "@/tool";
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness";
const captureWriteTool = (executions) => ({
    name: "captured_write",
    description: "Mutating tool; records each successful invocation.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute() {
        executions.count += 1;
        yield { type: "result", result: { ok: true, output: "WROTE" } };
    },
});
let dir;
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "trust-scope-e2e-"));
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});
describe("trust-scope wire-up e2e (Phase C)", () => {
    test("once_only grant: first call skips onConfirm, second call re-prompts", async () => {
        const executions = { count: 0 };
        const writeStub = captureWriteTool(executions);
        const registry = createInMemoryTrustScopeRegistry();
        registry.grant("project-A", { tool: "captured_write", scope: "once_only" });
        let onConfirmCalls = 0;
        const llm = new ScriptedLLM([
            ev(toolUse("w-1", "captured_write", { path: "/tmp/a", content: "first" })),
            ev(toolUse("w-2", "captured_write", { path: "/tmp/a", content: "second" })),
            ev(text("done")),
        ]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            registry: new ToolRegistry([...defaultTools, writeStub]),
            stream,
            cwd: dir,
            permission: { mode: "default" },
            onConfirm: async () => {
                onConfirmCalls += 1;
                return false; // second call ⇒ declined ⇒ deny short-circuit
            },
            trustScope: { registry, projectKey: "project-A" },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "trust-scope-once-only");
        expect(outcome.reason).toBe("completed");
        // onConfirm called once, ONLY on the second (post-consumption) invocation.
        expect(onConfirmCalls).toBe(1);
        // First call executed (grant honored), second call did NOT execute (declined).
        expect(executions.count).toBe(1);
        const writeResults = stream.events.filter((e) => e.type === "tool_result" && e.name === "captured_write");
        expect(writeResults.length).toBe(2);
        if (writeResults[0]?.type === "tool_result")
            expect(writeResults[0].ok).toBe(true);
        if (writeResults[1]?.type === "tool_result") {
            expect(writeResults[1].ok).toBe(false);
            // Sanity: the second deny is a user-declined, NOT a hard deny.
            expect(writeResults[1].preview.toLowerCase()).toContain("declined");
        }
    }, 15_000);
    test("trustScope UNSET ⇒ legacy onConfirm runs for every ask (control)", async () => {
        const executions = { count: 0 };
        const writeStub = captureWriteTool(executions);
        let onConfirmCalls = 0;
        const llm = new ScriptedLLM([
            ev(toolUse("w-1", "captured_write", { path: "/tmp/a", content: "first" })),
            ev(toolUse("w-2", "captured_write", { path: "/tmp/a", content: "second" })),
            ev(text("done")),
        ]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            registry: new ToolRegistry([...defaultTools, writeStub]),
            stream,
            cwd: dir,
            permission: { mode: "default" },
            onConfirm: async () => {
                onConfirmCalls += 1;
                return true; // approve both
            },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "trust-scope-unset-control");
        expect(outcome.reason).toBe("completed");
        // Without a trust-scope, onConfirm is consulted on each ask — both turns.
        expect(onConfirmCalls).toBe(2);
        expect(executions.count).toBe(2);
    }, 15_000);
});
