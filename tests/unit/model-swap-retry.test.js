import { describe, expect, test } from "bun:test";
import { NoAlternateModelError, pickNextModel, resolveRetryModel, streamWithModel } from "@/llm";
/** Fake LLMPort yielding a fixed scripted list of events. Records calls + the
 *  input it was streamed with so we can assert forwarding. */
class ScriptedLLM {
    model;
    events;
    calls = 0;
    lastInput;
    constructor(model, events) {
        this.model = model;
        this.events = events;
    }
    async *stream(input) {
        this.calls += 1;
        this.lastInput = input;
        for (const ev of this.events)
            yield ev;
    }
}
const candidate = (id, events = []) => ({
    id,
    port: new ScriptedLLM(id, events),
});
const collect = async (it) => {
    const out = [];
    for await (const ev of it)
        out.push(ev);
    return out;
};
const emptyInput = { messages: [], tools: [] };
describe("pickNextModel", () => {
    test("returns the next id in the ordered list", () => {
        expect(pickNextModel("a", ["a", "b", "c"])).toBe("b");
        expect(pickNextModel("b", ["a", "b", "c"])).toBe("c");
    });
    test("wrapping is not allowed: returns null at the end of the list", () => {
        expect(pickNextModel("c", ["a", "b", "c"])).toBeNull();
    });
    test("returns null when current is absent from the list", () => {
        expect(pickNextModel("z", ["a", "b", "c"])).toBeNull();
    });
});
describe("resolveRetryModel", () => {
    test("picks the requested model when present and distinct", () => {
        const candidates = [candidate("a"), candidate("b"), candidate("c")];
        const chosen = resolveRetryModel({ current: "a", candidates, requested: "c" });
        expect(chosen.id).toBe("c");
    });
    test("escalates to the next candidate when no model is requested", () => {
        const candidates = [candidate("a"), candidate("b"), candidate("c")];
        const chosen = resolveRetryModel({ current: "a", candidates });
        expect(chosen.id).toBe("b");
    });
    test("throws NoAlternateModelError when escalation has no next (last entry)", () => {
        const candidates = [candidate("a"), candidate("b"), candidate("c")];
        expect(() => resolveRetryModel({ current: "c", candidates })).toThrow(NoAlternateModelError);
    });
    test("throws NoAlternateModelError when requested model is absent", () => {
        const candidates = [candidate("a"), candidate("b")];
        expect(() => resolveRetryModel({ current: "a", candidates, requested: "zzz" })).toThrow(NoAlternateModelError);
    });
    test("throws NoAlternateModelError when requested equals current (no swap)", () => {
        const candidates = [candidate("a"), candidate("b")];
        expect(() => resolveRetryModel({ current: "a", candidates, requested: "a" })).toThrow(NoAlternateModelError);
    });
});
describe("streamWithModel", () => {
    test("emits a leading stream_reset then forwards inner events", async () => {
        const inner = [
            { type: "text_delta", delta: "hello" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        const cand = candidate("b", inner);
        const out = await collect(streamWithModel(cand, emptyInput));
        expect(out[0]).toEqual({ type: "stream_reset" });
        expect(out.slice(1)).toEqual(inner);
    });
    test("forwards the StreamInput unchanged to the chosen candidate's port", async () => {
        const port = new ScriptedLLM("b", [{ type: "message_stop", stop_reason: "end_turn" }]);
        const cand = { id: "b", port };
        const input = { messages: [], tools: [] };
        await collect(streamWithModel(cand, input));
        expect(port.calls).toBe(1);
        expect(port.lastInput).toBe(input);
    });
    test("emits only the stream_reset when the inner stream is empty", async () => {
        const cand = candidate("b", []);
        const out = await collect(streamWithModel(cand, emptyInput));
        expect(out).toEqual([{ type: "stream_reset" }]);
    });
});
