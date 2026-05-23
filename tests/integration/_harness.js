/**
 * Shared integration-test harness for the e2e gap-closing suites.
 *
 * Same fake-LLM / RecordingStream / cfg() style as
 * `agent-recovery-e2e.test.ts` and `agent-features.test.ts` — extracted here so
 * the six new gap-closing suites reuse ONE harness instead of redefining it.
 * No production code is touched; this lives only under tests/integration/.
 */
import { LLMError } from "@/shared";
import { defaultTools, ToolRegistry } from "@/tool";
export const ev = (events) => ({ kind: "events", events });
export const thr = (error) => ({ kind: "throw", error });
/**
 * Replays a script step-per-`stream()` call. `throw` steps reject before
 * yielding (exercising the loop's same-turn retry / PTL path). The last step
 * repeats if the loop calls more often than scripted (defensive, like the
 * existing `ScriptedLLM`). Records every `StreamInput`.
 *
 * `seenMessages` is a derived view over `inputs` exposing just the per-call
 * `Message[]` — callers reaching for the per-turn reminder tail only care about
 * the messages array, not the full `StreamInput` envelope.
 */
export class ScriptedLLM {
    inputs = [];
    calls = 0;
    model = "scripted-test-model";
    steps;
    constructor(steps) {
        this.steps = steps;
    }
    get seenMessages() {
        return this.inputs.map((i) => i.messages);
    }
    async *stream(input) {
        this.inputs.push(input);
        this.calls += 1;
        const step = this.steps.shift() ?? this.steps[this.steps.length - 1];
        if (!step)
            throw new LLMError("script exhausted");
        if (step.kind === "throw")
            throw step.error;
        for (const e of step.events)
            yield e;
    }
}
/**
 * Simpler "one script per call" LLM double — the original `agent-loop.test.ts`
 * / `agent-features.test.ts` shape. Yields one scripted StreamEvent[] per
 * `stream()` call; the LAST script repeats if the loop calls more times than
 * scripted (matches the local copies it replaces). Records every `Message[]`
 * passed in, so callers can inspect the per-turn reminder tail.
 */
export class FakeLLM {
    seenMessages = [];
    calls = 0;
    scripts;
    last = [];
    /** Defaults to a single "ok" end-turn script so reminder-tail tests that
     *  only care about `seenMessages` can do `new FakeLLM()` without ceremony. */
    constructor(scripts = [text("ok")]) {
        this.scripts = scripts;
    }
    async *stream(input) {
        this.seenMessages.push(input.messages);
        const next = this.scripts.shift();
        if (next)
            this.last = next;
        const script = next ?? this.last;
        this.calls += 1;
        for (const e of script)
            yield e;
    }
}
/** StreamPort double recording every emitted AgentEvent. */
export class RecordingStream {
    events = [];
    emit(event) {
        this.events.push(event);
    }
}
/**
 * `NullStream` alias — same recording behaviour as `RecordingStream`, exposed
 * under the original local-test name so callers reading event traces don't
 * have to rename at every call site. Semantically identical.
 */
export const NullStream = RecordingStream;
export const text = (t, stop = "end_turn") => [
    { type: "text_delta", delta: t },
    { type: "message_stop", stop_reason: stop },
];
export const toolUse = (id, name, input) => [
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, input },
    { type: "message_stop", stop_reason: "tool_use" },
];
/** One assistant turn issuing multiple tool_use blocks in order (no trailing stop_reason per block — just one terminal `tool_use` stop). */
export const multiToolUse = (calls) => [
    ...calls.flatMap((c) => [
        { type: "tool_use_start", id: c.id, name: c.name },
        { type: "tool_use_end", id: c.id, input: c.input },
    ]),
    { type: "message_stop", stop_reason: "tool_use" },
];
export const cfg = (over) => ({
    registry: new ToolRegistry(defaultTools),
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
/**
 * Looser config builder that defaults `llm` to a no-op `FakeLLM` when callers
 * don't pass one. Used by Phase-8 reminder-tail tests where the LLM identity
 * is irrelevant — only the assembled `seenMessages` matters.
 */
export const baseConfig = (over = {}) => ({
    llm: over.llm ?? new FakeLLM([text("ok")]),
    registry: new ToolRegistry(defaultTools),
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
export const turnScript = (scripts) => scripts.map((s) => (s.type === "text" ? ev(text(s.text)) : ev(toolUse(s.id, s.name, s.input))));
/** Hard guard: a hang here is a real loop bug, not a slow test. */
export const withTimeout = async (p, ms, label) => {
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
/** Find the first emitted AgentEvent of a given discriminant `type`. Narrowed
 *  to the exact union member so callers get typed access to its payload. */
export const findEvent = (s, t) => s.events.find((e) => e.type === t);
/** All emitted AgentEvents of a given discriminant `type`, in emit order. */
export const eventsOf = (s, t) => s.events.filter((e) => e.type === t);
