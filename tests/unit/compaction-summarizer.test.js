import { describe, expect, test } from "bun:test";
import { runAgent } from "@/agent";
import { compactIfNeeded, reactiveCompact } from "@/agent/compaction";
import { LLMError } from "@/shared";
import { defaultTools, ToolRegistry } from "@/tool";
/**
 * Proves the ADR-0011 dedicated compaction summarizer knob
 * (`AgentConfig.compaction.summarizerLlm`) is actually honored at BOTH loop
 * sites — the audit gap was "no test proves the override fires at either
 * site". We close it by:
 *
 *  1. Driving `compactIfNeeded` / `reactiveCompact` directly with a DISTINCT
 *     fake summarizer LLM and asserting THAT llm (not the main one) performed
 *     the summary turn — these are the exact functions the loop calls with
 *     `config.compaction.summarizerLlm ?? config.llm` (PROACTIVE,
 *     `loop.ts` `maybeCompact`) and `config.compaction?.summarizerLlm ??
 *     config.llm` (REACTIVE, `loop.ts` `applyAction` compact branch).
 *  2. Driving the REAL `runAgent` loop end-to-end so the pass-through at each
 *     site is proven through the public entry point, not just the leaf fn.
 *
 * Fake-LLM harness mirrors the duplicated-on-purpose pattern in
 * working-loop.test.ts / compaction.test.ts (no cross-test imports).
 */
/** Records every StreamInput it receives, tags emitted summary text with its
 *  own name so we can tell WHICH llm produced the summary, and replays scripts
 *  (last script repeats once exhausted). A scripted `throwOnCall` index makes
 *  the MAIN llm raise a PTL error to trigger the reactive site. */
class TaggedLLM {
    name;
    inputs = [];
    calls = 0;
    model;
    scripts;
    last = [];
    throwOnCall;
    constructor(name, scripts, opts) {
        this.name = name;
        this.model = name;
        this.scripts = scripts;
        this.throwOnCall = opts?.throwOnCall;
    }
    async *stream(input) {
        this.inputs.push(input);
        this.calls += 1;
        if (this.throwOnCall !== undefined && this.calls === this.throwOnCall) {
            throw new LLMError("400 Bad Request: prompt is too long for this model");
        }
        const next = this.scripts.shift();
        if (next)
            this.last = next;
        const script = next ?? this.last;
        for (const ev of script)
            yield ev;
    }
}
class RecordingStream {
    events = [];
    emit(event) {
        this.events.push(event);
    }
}
const textScript = (text) => [
    { type: "text_delta", delta: text },
    { type: "message_stop", stop_reason: "end_turn" },
];
const userText = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistantText = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
});
/** A transcript large enough to clear a tiny token threshold. */
const bigHistory = () => [
    userText("x".repeat(8000)),
    assistantText("older turn 1"),
    userText("more"),
    assistantText("older turn 2"),
    userText("current request"),
];
/** Reactive history: the loop calls `reactiveCompact` WITHOUT
 *  `keepRecentTurns` (so the default REACTIVE_KEEP_TURNS = 2 applies). This
 *  needs ≥3 assistant turns before the kept tail so `findBoundary` leaves a
 *  non-empty summarizable prefix (boundary > 0). */
const reactiveHistory = () => [
    userText("x".repeat(8000)),
    assistantText("older turn 1"),
    userText("more 1"),
    assistantText("older turn 2"),
    userText("more 2"),
    assistantText("older turn 3"),
    userText("more 3"),
    assistantText("older turn 4"),
    userText("current request"),
];
const cfg = (over) => ({
    registry: new ToolRegistry(defaultTools),
    stream: new RecordingStream(),
    permission: { mode: "acceptEdits" },
    messages: [userText("go")],
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
});
// ---------------------------------------------------------------------------
// Leaf-level: the exact functions the loop invokes at each site.
// ---------------------------------------------------------------------------
describe("summarizer override at the leaf the loop calls (compaction.ts)", () => {
    test("PROACTIVE leaf (compactIfNeeded): summarizer llm runs the summary, not main", async () => {
        const main = new TaggedLLM("MAIN", [textScript("MAIN-SHOULD-NOT-SUMMARIZE")]);
        const summarizer = new TaggedLLM("SUMMARIZER", [textScript("PROACTIVE SUMMARY")]);
        // `loop.ts` maybeCompact: llm = config.compaction.summarizerLlm ?? config.llm
        const res = await compactIfNeeded({
            messages: bigHistory(),
            llm: summarizer,
            system: "sys",
            thresholdTokens: 50,
            keepRecentTurns: 1,
        });
        expect(res.compacted).toBe(true);
        expect(summarizer.calls).toBe(1);
        expect(main.calls).toBe(0);
        if (res.compacted) {
            const head = res.messages[0]?.content[0];
            expect(head?.type === "text" && head.text).toContain("PROACTIVE SUMMARY");
        }
    });
    test("REACTIVE leaf (reactiveCompact): summarizer llm produces the continuation", async () => {
        const main = new TaggedLLM("MAIN", [textScript("MAIN-SHOULD-NOT-SUMMARIZE")]);
        const summarizer = new TaggedLLM("SUMMARIZER", [
            textScript("<summary>RESUME FROM SUMMARIZER</summary>"),
        ]);
        // `loop.ts` applyAction compact: llm = config.compaction?.summarizerLlm ?? config.llm
        const res = await reactiveCompact({
            messages: bigHistory(),
            llm: summarizer,
            system: "sys",
            keepRecentTurns: 1,
        });
        expect(res.ok).toBe(true);
        expect(summarizer.calls).toBe(1);
        expect(main.calls).toBe(0);
        if (res.ok) {
            const head = res.messages[0]?.content[0];
            expect(head?.type === "text" && head.text).toContain("RESUME FROM SUMMARIZER");
        }
    });
    test("FALLBACK leaf: with no summarizer the main llm (?? config.llm) does it", async () => {
        // The loop passes `config.compaction.summarizerLlm ?? config.llm`; with the
        // knob unset that resolves to the MAIN llm — byte-preserving default.
        const main = new TaggedLLM("MAIN", [textScript("MAIN SUMMARY")]);
        const res = await compactIfNeeded({
            messages: bigHistory(),
            llm: main,
            system: "sys",
            thresholdTokens: 50,
            keepRecentTurns: 1,
        });
        expect(res.compacted).toBe(true);
        expect(main.calls).toBe(1);
        if (res.compacted) {
            const head = res.messages[0]?.content[0];
            expect(head?.type === "text" && head.text).toContain("MAIN SUMMARY");
        }
    });
});
// ---------------------------------------------------------------------------
// End-to-end: the REAL runAgent loop wiring `?? config.llm` at each site.
// ---------------------------------------------------------------------------
describe("runAgent honors compaction.summarizerLlm at BOTH sites", () => {
    test("PROACTIVE site: maybeCompact routes the summary to summarizerLlm", async () => {
        // Main llm only ever produces the post-compaction answer turn; if the loop
        // wrongly summarized with the main llm its FIRST call would be the summary
        // and the recorded summary head would carry the MAIN tag.
        const main = new TaggedLLM("MAIN", [textScript("final answer")]);
        const summarizer = new TaggedLLM("SUMMARIZER", [textScript("PROACTIVE LOOP SUMMARY")]);
        const out = await runAgent(cfg({
            llm: main,
            messages: bigHistory(),
            // compaction block present (proactive) WITH a dedicated summarizer.
            compaction: {
                thresholdTokens: 50,
                keepRecentTurns: 1,
                summarizerLlm: summarizer,
            },
        }));
        expect(out.reason).toBe("completed");
        // The summarizer ran exactly the summary turn; the main llm never summarized.
        expect(summarizer.calls).toBe(1);
        expect(main.calls).toBe(1);
        // The summarizer saw the old prefix to condense.
        expect(summarizer.inputs[0]?.messages.length).toBeGreaterThan(0);
        // The post-compaction turn the MAIN llm saw begins with the synthetic
        // summary produced by the SUMMARIZER (proves the seam fed it through wm).
        const mainHead = main.inputs[0]?.messages[0]?.content[0];
        expect(mainHead?.type).toBe("text");
        if (mainHead?.type === "text") {
            expect(mainHead.text).toContain("<conversation summary>");
            expect(mainHead.text).toContain("PROACTIVE LOOP SUMMARY");
        }
    });
    test("PROACTIVE fallback: no summarizerLlm ⇒ main llm performs the summary", async () => {
        // [0] = the summary turn (because no summarizer), [1] = the answer turn.
        const main = new TaggedLLM("MAIN", [
            textScript("MAIN DID THE SUMMARY"),
            textScript("final answer"),
        ]);
        const out = await runAgent(cfg({
            llm: main,
            messages: bigHistory(),
            // compaction present but NO summarizerLlm → `?? config.llm` = main.
            compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
        }));
        expect(out.reason).toBe("completed");
        // Main llm did BOTH the summary and the answer (two calls).
        expect(main.calls).toBe(2);
        // The answer turn saw the summary the MAIN llm itself produced.
        const turnHead = main.inputs[1]?.messages[0]?.content[0];
        expect(turnHead?.type).toBe("text");
        if (turnHead?.type === "text") {
            expect(turnHead.text).toContain("<conversation summary>");
            expect(turnHead.text).toContain("MAIN DID THE SUMMARY");
        }
    });
    test("REACTIVE site: PTL from main ⇒ summarizerLlm writes the continuation", async () => {
        // Main: call #1 throws PTL (triggers reactive compact), call #2 answers.
        const main = new TaggedLLM("MAIN", [textScript("final answer after reactive")], {
            throwOnCall: 1,
        });
        const summarizer = new TaggedLLM("SUMMARIZER", [
            textScript("<summary>REACTIVE LOOP CONTINUATION</summary>"),
        ]);
        const out = await runAgent(cfg({
            llm: main,
            messages: reactiveHistory(),
            // NB: the loop calls reactiveCompact WITHOUT keepRecentTurns; only the
            // summarizerLlm override is exercised at the reactive site here.
            compaction: { summarizerLlm: summarizer },
            // Disable the breaker so a single reactive squeeze is not second-guessed.
            compactionBreaker: { disabled: true },
        }));
        expect(out.reason).toBe("completed");
        // Summarizer produced exactly the continuation; main was called twice
        // (the throwing PTL attempt + the resumed answer) but never summarized.
        expect(summarizer.calls).toBe(1);
        expect(main.calls).toBe(2);
        // After reactive compaction the resumed turn begins with the continuation
        // summary produced by the SUMMARIZER.
        const resumedHead = main.inputs[1]?.messages[0]?.content[0];
        expect(resumedHead?.type).toBe("text");
        if (resumedHead?.type === "text") {
            expect(resumedHead.text).toContain("continuation summary");
            expect(resumedHead.text).toContain("REACTIVE LOOP CONTINUATION");
        }
    });
    test("REACTIVE fallback: PTL with no summarizerLlm ⇒ main llm continues", async () => {
        // call #1 PTL throw, call #2 = the continuation summary (main, no
        // summarizer), call #3 = the resumed answer.
        const main = new TaggedLLM("MAIN", [textScript("<summary>MAIN WROTE THE CONTINUATION</summary>"), textScript("final answer")], { throwOnCall: 1 });
        const out = await runAgent(cfg({
            llm: main,
            messages: reactiveHistory(),
            // compaction block present but no summarizerLlm → reactive uses main.
            compaction: {},
            compactionBreaker: { disabled: true },
        }));
        expect(out.reason).toBe("completed");
        expect(main.calls).toBe(3);
        const resumedHead = main.inputs[2]?.messages[0]?.content[0];
        expect(resumedHead?.type).toBe("text");
        if (resumedHead?.type === "text") {
            expect(resumedHead.text).toContain("continuation summary");
            expect(resumedHead.text).toContain("MAIN WROTE THE CONTINUATION");
        }
    });
});
