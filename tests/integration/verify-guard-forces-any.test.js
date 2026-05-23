import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgent } from "@/agent";
import { ToolRegistry } from "@/tool";
class RecordingLLM {
    inputs = [];
    calls = 0;
    model = "scripted-test-model";
    steps;
    constructor(steps) {
        this.steps = steps;
    }
    async *stream(input) {
        this.inputs.push(input);
        this.calls += 1;
        const step = this.steps.shift() ?? this.steps[this.steps.length - 1];
        if (!step)
            throw new Error("script exhausted");
        for (const ev of step.events)
            yield ev;
    }
}
class RecordingStream {
    events = [];
    emit(event) {
        this.events.push(event);
    }
}
const text = (t) => [
    { type: "text_delta", delta: t },
    { type: "message_stop", stop_reason: "end_turn" },
];
const toolUse = (id, name, input) => [
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, input },
    { type: "message_stop", stop_reason: "tool_use" },
];
const ev = (events) => ({ kind: "events", events });
const stubTool = (name, readOnly) => ({
    name,
    description: `stub ${name}`,
    inputSchema: z.any(),
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => readOnly,
    async *execute() {
        yield { type: "result", result: { ok: true, output: `${name} ok` } };
    },
});
const stubRegistry = () => new ToolRegistry([
    stubTool("read", true),
    stubTool("edit", false),
    stubTool("test_runner", false),
    stubTool("bash", false),
]);
const cfg = (over) => ({
    registry: stubRegistry(),
    stream: new RecordingStream(),
    permission: { mode: "bypass" },
    messages: [{ role: "user", content: [{ type: "text", text: "fix the bug" }] }],
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 8,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
});
const withTimeout = async (p, ms, label) => {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([p, guard]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
};
describe("verify-guard arms tool_choice:'any' on next LLM call (ADR-0079)", () => {
    test("after edit+unverified-finish, the FORCED re-entry's StreamInput has toolChoice.kind === 'any'", async () => {
        // turn 1: edit (mutating). turn 2: pure text "done" → guard fires →
        // forces SAME-TURN re-entry with ARM. turn 3 (forced re-entry): model
        // is given tool_choice:"any" — emits test_runner. turn 4: text → done.
        const llm = new RecordingLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
            ev(text("All done.")),
            ev(toolUse("t1", "test_runner", {})),
            ev(text("Verified.")),
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, verifyGuard: { maxTrips: 2 }, maxTurns: 6 })), 15_000, "verify-guard-forces-any");
        expect(out.reason).toBe("completed");
        // 4 LLM calls landed (edit + finish-attempt + forced + closeout).
        expect(llm.calls).toBe(4);
        // Call 1 (edit dispatch): no flag is armed yet ⇒ auto/undefined on wire.
        const call1 = llm.inputs[0];
        expect(call1?.toolChoice?.kind ?? "auto").toBe("auto");
        // Call 2 (model's finish-intent text turn): again no ARM yet — verify
        // guard fires AFTER this call's assembled message.
        const call2 = llm.inputs[1];
        expect(call2?.toolChoice?.kind ?? "auto").toBe("auto");
        // Call 3 (FORCED re-entry): this is the assertion that pins the wiring.
        // The verify-guard armed `verifyGuardViolated`, `consumeTurnSignals` at
        // the top of the next runTurn iteration read+cleared it, resolved to
        // {kind:"any"}, and `streamConsume` threaded it onto StreamInput.
        const call3 = llm.inputs[2];
        expect(call3?.toolChoice).toEqual({ kind: "any" });
        // Call 4 (closeout text turn): flag was cleared on read ⇒ back to auto.
        const call4 = llm.inputs[3];
        expect(call4?.toolChoice?.kind ?? "auto").toBe("auto");
    });
    test("with NO verifyGuard config: every StreamInput.toolChoice is auto/undefined (byte-identical)", async () => {
        // Same edit-then-finish script but with the guard absent. No flag ever
        // gets armed ⇒ every consume returns {} ⇒ resolveToolChoice → auto ⇒
        // adapter omits the wire field. We assert toolChoice.kind === "auto"
        // (the loop always threads through; the BYTE-identical part is the
        // adapter omit, asserted in the unit suite below).
        const llm = new RecordingLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
            ev(text("All done.")),
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 6 })), 15_000, "verify-guard-off-byte-identical");
        expect(out.reason).toBe("completed");
        expect(llm.calls).toBe(2);
        for (const input of llm.inputs) {
            // Either explicit auto (loop always threads) or the adapter would
            // see undefined and omit. Both shapes are byte-identical post-adapter.
            expect(input.toolChoice?.kind ?? "auto").toBe("auto");
        }
    });
});
