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
const stubRegistry = () => new ToolRegistry([stubTool("read", true), stubTool("edit", false)]);
const cfg = (over) => ({
    registry: stubRegistry(),
    stream: new RecordingStream(),
    permission: { mode: "bypass" },
    messages: [{ role: "user", content: [{ type: "text", text: "analyze" }] }],
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 6,
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
describe("closeout-guard arms tool_choice:'none' on next LLM call (ADR-0079)", () => {
    test("after first finish-intent, the FORCED re-entry's StreamInput has toolChoice.kind === 'none'", async () => {
        // turn 1: pure text finish-intent (analysis-only session, no tool ran).
        // closeout-guard fires (single-shot): injects reminder + ARMs.
        // turn 2 (forced re-entry): MUST see tool_choice.kind === "none".
        // Model emits closeout text → completed.
        const llm = new RecordingLLM([ev(text("My analysis is done.")), ev(text("Closeout text."))]);
        const out = await withTimeout(runAgent(cfg({ llm, closeoutGuard: { enabled: true }, maxTurns: 4 })), 15_000, "closeout-forces-none");
        expect(out.reason).toBe("completed");
        expect(llm.calls).toBe(2);
        // Call 1: nothing armed yet ⇒ auto.
        const call1 = llm.inputs[0];
        expect(call1?.toolChoice?.kind ?? "auto").toBe("auto");
        // Call 2 (forced closeout re-entry): the precise wiring assertion. The
        // closeout-guard armed `closeoutAttempted`, consumeTurnSignals read it,
        // resolveToolChoice → {kind:"none"}, streamConsume threaded it onto
        // StreamInput. The adapter will map "none" to Anthropic
        // `tool_choice:{type:"none"}` / OpenAI `tool_choice:"none"` so the model
        // is FORBIDDEN from emitting any tool_use.
        const call2 = llm.inputs[1];
        expect(call2?.toolChoice).toEqual({ kind: "none" });
    });
    test("closeoutGuard disabled (default-OFF) ⇒ every StreamInput.toolChoice is auto", async () => {
        // Without the guard the closeoutAttempted flag is never armed; the loop
        // threads {kind:"auto"} for every call ⇒ byte-identical wire payload.
        const llm = new RecordingLLM([ev(text("Done."))]);
        const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 4 })), 15_000, "closeout-guard-off-byte-identical");
        expect(out.reason).toBe("completed");
        expect(llm.calls).toBe(1);
        for (const input of llm.inputs) {
            expect(input.toolChoice?.kind ?? "auto").toBe("auto");
        }
    });
    test("closeout-guard is single-shot — only the FIRST finish-intent arms the gate", async () => {
        // The closeout-guard is single-shot (`state.trips >= 1` ⇒ no block). A
        // model that emits text → forced "none" → text-again should see "none"
        // ONLY on the first forced re-entry; if the loop allowed a second nudge,
        // it would re-arm and we'd see "none" again. The single-shot policy plus
        // the 1-turn-TTL consume together pin behavior: exactly ONE call has
        // toolChoice.kind === "none", everything before and after is auto.
        const llm = new RecordingLLM([ev(text("first")), ev(text("second")), ev(text("third"))]);
        const out = await withTimeout(runAgent(cfg({ llm, closeoutGuard: { enabled: true }, maxTurns: 4 })), 15_000, "closeout-single-shot");
        expect(out.reason).toBe("completed");
        // single-shot: edit-less session, no mutating tool, but the closeout
        // armed once at first finish. The 1-turn-TTL clears it on the next
        // consume so the third call (if any) is back to auto.
        const armed = llm.inputs.filter((i) => i.toolChoice?.kind === "none");
        expect(armed).toHaveLength(1);
    });
});
