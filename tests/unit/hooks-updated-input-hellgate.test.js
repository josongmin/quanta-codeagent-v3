/**
 * HELLGATE — adversarial pre_tool_use `updatedInput` (Cursor parity) proofs.
 *
 * A hook rewrite is operator-trusted, but it must NOT be able to:
 *   1. resurrect a DENIED call — deny wins over any rewrite, in any order;
 *   2. run when a call was blocked UPSTREAM (mode/permission) — the hook is the
 *      last gate, so a blocked call never reaches it (no rewrite, no execute);
 *   3. crash the loop with a schema-garbage rewrite — it degrades to a
 *      recoverable error tool_result (no-throw contract);
 *   4. leak across matchers — a rewrite scoped to one tool never touches another;
 *   5. be corrupted by a throwing sibling mid-composition.
 *
 * Source under test: src/agent/hooks.ts (emit composition) +
 * src/agent/admissibility-gate.ts (runPreToolUseHook sink) + dispatch wiring.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HookBus, runAgent } from "@/agent";
import { dispatchTool } from "@/agent/dispatch";
import { StructuredLogger } from "@/observability";
import { ToolRegistry } from "@/tool";
// --- harness (duplicated locally on purpose — test files, not modules) ------
class RecordingLLM {
    inputs = [];
    scripts;
    last = [];
    constructor(scripts) {
        this.scripts = scripts;
    }
    async *stream(input) {
        this.inputs.push(input);
        const next = this.scripts.shift();
        if (next)
            this.last = next;
        for (const ev of next ?? this.last)
            yield ev;
    }
}
class RecordingStream {
    events = [];
    emit(e) {
        this.events.push(e);
    }
}
const textScript = (text) => [
    { type: "text_delta", delta: text },
    { type: "message_stop", stop_reason: "end_turn" },
];
const toolUseScript = (id, name, input) => [
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, input },
    { type: "message_stop", stop_reason: "tool_use" },
];
const echoTool = (sink) => ({
    name: "echo",
    description: "echo",
    inputSchema: z.object({ path: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: (input) => (async function* () {
        sink.received.push(input);
        yield {
            type: "result",
            result: { ok: true, output: `ran:${JSON.stringify(input)}` },
        };
    })(),
});
/** A MUTATING tool (not read-only) so plan mode blocks it upstream. */
const mutatingTool = (sink) => ({
    name: "mutate",
    description: "mutate",
    inputSchema: z.object({ v: z.string() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: (input) => (async function* () {
        sink.received.push(input);
        yield { type: "result", result: { ok: true, output: "ran" } };
    })(),
});
const cfg = (over) => ({
    registry: new ToolRegistry([]),
    stream: new RecordingStream(),
    permission: { mode: "acceptEdits" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
});
const callOf = (name, input) => ({
    type: "tool_use",
    id: "c1",
    name,
    input,
});
const perm = { mode: "acceptEdits" };
describe("HELLGATE updatedInput — deny dominates rewrite in every ordering", () => {
    test("rewrite-first then deny-last ⇒ blocked, tool never runs", async () => {
        const sink = { received: [] };
        const hooks = new HookBus();
        hooks.on("pre_tool_use", () => ({ updatedInput: { path: "privileged" } }));
        hooks.on("pre_tool_use", () => ({ deny: "no" }));
        const res = await dispatchTool(callOf("echo", { path: "orig" }), cfg({ llm: new RecordingLLM([]), registry: new ToolRegistry([echoTool(sink)]), hooks }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("hook-denied");
        expect(sink.received).toEqual([]);
    });
    test("deny-first then rewrite-last ⇒ blocked, tool never runs", async () => {
        const sink = { received: [] };
        const hooks = new HookBus();
        hooks.on("pre_tool_use", () => ({ deny: "first" }));
        hooks.on("pre_tool_use", () => ({ updatedInput: { path: "privileged" } }));
        const res = await dispatchTool(callOf("echo", { path: "orig" }), cfg({ llm: new RecordingLLM([]), registry: new ToolRegistry([echoTool(sink)]), hooks }), perm);
        expect(res.preview).toBe("hook-denied");
        expect(res.block.content).toContain("first");
        expect(sink.received).toEqual([]);
    });
});
describe("HELLGATE updatedInput — a rewrite cannot bypass an UPSTREAM block", () => {
    test("plan mode blocks a mutating tool BEFORE the hook ⇒ hook never fires, no rewrite, no run", async () => {
        const sink = { received: [] };
        let hookFired = false;
        const hooks = new HookBus();
        hooks.on("pre_tool_use", () => {
            hookFired = true;
            return { updatedInput: { v: "rewritten" } };
        });
        const res = await dispatchTool(callOf("mutate", { v: "orig" }), cfg({
            llm: new RecordingLLM([]),
            registry: new ToolRegistry([mutatingTool(sink)]),
            hooks,
            planMode: true,
            permission: { mode: "default" },
        }), { mode: "default" });
        expect(res.ok).toBe(false);
        // mode-block deny can surface as either the gate's `${mode}-blocked`
        // preview (e.g. "plan-blocked") OR the dispatch seam's `"mode-blocked"`
        // preview, depending on which check fires first; the human-readable
        // content always names the mode. Assert via content (semantic) — the
        // hook-never-fires invariant is the actual contract under test.
        const denyText = `${res.preview} ${res.block.content}`;
        expect(denyText.toLowerCase()).toContain("plan");
        expect(hookFired).toBe(false); // the hook is the LAST gate; a blocked call never reaches it
        expect(sink.received).toEqual([]);
    });
});
describe("HELLGATE updatedInput — schema-garbage rewrite degrades, never crashes", () => {
    test("a rewrite to a schema-invalid shape ⇒ recoverable error tool_result, loop survives", async () => {
        const sink = { received: [] };
        const hooks = new HookBus();
        // echo expects { path: string }; rewrite it to a number
        hooks.on("pre_tool_use", () => ({ updatedInput: { path: 12345 } }));
        const out = await runAgent(cfg({
            llm: new RecordingLLM([toolUseScript("t1", "echo", { path: "orig" }), textScript("done")]),
            registry: new ToolRegistry([echoTool(sink)]),
            hooks,
        }));
        // tool's schema rejected the garbage BEFORE execute ⇒ body never ran
        expect(sink.received).toEqual([]);
        // and the loop completed normally with an error tool_result in the transcript
        expect(out.reason).toBe("completed");
        expect(JSON.stringify(out.messages)).toContain("path");
    });
    test("a rewrite to null ⇒ recoverable error, no throw", async () => {
        const sink = { received: [] };
        const hooks = new HookBus();
        hooks.on("pre_tool_use", () => ({ updatedInput: null }));
        const res = await dispatchTool(callOf("echo", { path: "orig" }), cfg({ llm: new RecordingLLM([]), registry: new ToolRegistry([echoTool(sink)]), hooks }), perm);
        expect(res.ok).toBe(false);
        expect(sink.received).toEqual([]);
    });
});
describe("HELLGATE updatedInput — matcher isolation + composition integrity", () => {
    test("a rewrite scoped to `write` never rewrites `read`", async () => {
        const bus = new HookBus();
        bus.on("pre_tool_use", () => ({ updatedInput: { leaked: true } }), { matcher: ["write"] });
        const r = await bus.emit({ type: "pre_tool_use", name: "read", input: { path: "x" } });
        expect("updatedInput" in r).toBe(false);
    });
    test("a throwing handler mid-chain does NOT corrupt the composed rewrite", async () => {
        const lines = [];
        const bus = new HookBus(new StructuredLogger({ level: "error", sink: (l) => lines.push(l) }));
        const seen = [];
        bus.on("pre_tool_use", (e) => {
            seen.push(e.input);
            return { updatedInput: { n: 1 } };
        });
        bus.on("pre_tool_use", () => {
            throw new Error("boom");
        });
        bus.on("pre_tool_use", (e) => {
            seen.push(e.input);
            return { updatedInput: { n: 2 } };
        });
        const r = await bus.emit({ type: "pre_tool_use", name: "x", input: { n: 0 } });
        // the throwing sibling is isolated+logged; composition still threads {n:1}→{n:2}
        expect(seen).toEqual([{ n: 0 }, { n: 1 }]);
        expect(r.updatedInput).toEqual({ n: 2 });
        expect(lines).toHaveLength(1);
    });
    test("deterministic last-wins under a long rewrite chain", async () => {
        const bus = new HookBus();
        for (let i = 0; i < 64; i++) {
            const n = i;
            bus.on("pre_tool_use", () => ({ updatedInput: { n } }));
        }
        const r = await bus.emit({ type: "pre_tool_use", name: "x", input: { n: -1 } });
        expect(r.updatedInput).toEqual({ n: 63 });
    });
});
