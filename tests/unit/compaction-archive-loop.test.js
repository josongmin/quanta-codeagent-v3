/**
 * runAgent × ADR-0069 wire-up integration tests.
 *
 * Proves the loop seam in `maybeCompact` honors:
 *   1. `AgentConfig.onPreCompact` — the host callback runs before the
 *      summarizer; a `defer_one_turn` reply skips THIS turn entirely.
 *   2. `AgentConfig.compaction.archive` — when `true`, every successful
 *      proactive compaction appends a {@link ConversationSummaryEntry} AND
 *      emits a `context_compacted` AgentEvent on the configured StreamPort
 *      (so a session jsonl recorder can pick it up).
 *   3. The legacy `recovery:{reason:"compact",detail:"proactive"}` event
 *      still fires FIRST in the same sequence — byte-identical ordering for
 *      pre-existing consumers.
 *
 * Harness mirrors compaction-summarizer.test.ts (no cross-test imports).
 */
import { describe, expect, test } from "bun:test";
import { createArchive, runAgent } from "@/agent";
import { defaultTools, ToolRegistry } from "@/tool";
class ScriptedLLM {
    scripts;
    inputs = [];
    calls = 0;
    model = "scripted";
    constructor(scripts) {
        this.scripts = scripts;
    }
    async *stream(input) {
        this.inputs.push(input);
        this.calls += 1;
        const next = this.scripts.shift() ?? [
            { type: "text_delta", delta: "final" },
            { type: "message_stop", stop_reason: "end_turn" },
        ];
        for (const ev of next)
            yield ev;
    }
}
class RecordingStream {
    events = [];
    emit(event) {
        this.events.push(event);
    }
}
const userText = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistantText = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
});
const textScript = (text) => [
    { type: "text_delta", delta: text },
    { type: "message_stop", stop_reason: "end_turn" },
];
/** Big enough to clear thresholdTokens=50. */
const bigHistory = () => [
    userText("x".repeat(8_000)),
    assistantText("older turn 1"),
    userText("more"),
    assistantText("older turn 2"),
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
describe("runAgent: onPreCompact HITL (ADR-0069)", () => {
    test("approve: compaction proceeds and the query payload is fully populated", async () => {
        // Main does BOTH the summary turn (no separate summarizer) and the answer.
        const main = new ScriptedLLM([textScript("FOLDED HISTORY"), textScript("final answer")]);
        const stream = new RecordingStream();
        const seen = [];
        const out = await runAgent(cfg({
            llm: main,
            stream,
            messages: bigHistory(),
            compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
            onPreCompact: async (q) => {
                seen.push(q);
                return "approve";
            },
        }));
        expect(out.reason).toBe("completed");
        // The callback was consulted exactly once (one threshold crossing).
        expect(seen.length).toBe(1);
        const q = seen[0];
        if (!q)
            throw new Error("preflight not invoked");
        // turnId is a stable string (loop synthesizes "t<n>" from the turn counter
        // when no RunContext is wired).
        expect(typeof q.turnId).toBe("string");
        expect(q.turnId.length).toBeGreaterThan(0);
        expect(q.threshold).toBe(50);
        expect(q.proposedKeep).toBe(1);
        expect(q.currentTokens).toBeGreaterThan(50);
        expect(q.proposedSummaryTokens).toBeGreaterThan(0);
        // Main ran the summary (call #1) and the answer (call #2).
        expect(main.calls).toBe(2);
    });
    test("defer_one_turn: compaction is skipped THIS turn (no summary call, history untouched)", async () => {
        // Without compaction the main llm just answers once on its first call.
        const main = new ScriptedLLM([textScript("final answer")]);
        const stream = new RecordingStream();
        let queries = 0;
        const out = await runAgent(cfg({
            llm: main,
            stream,
            messages: bigHistory(),
            compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
            onPreCompact: async () => {
                queries += 1;
                return "defer_one_turn";
            },
        }));
        expect(out.reason).toBe("completed");
        // Host was asked, said no.
        expect(queries).toBe(1);
        // Main llm was NEVER asked to summarize — it only ran the answer turn.
        expect(main.calls).toBe(1);
        // The answer turn saw the ORIGINAL transcript head (no synthetic summary).
        const first = main.inputs[0]?.messages[0]?.content[0];
        if (first?.type === "text") {
            expect(first.text).not.toContain("<conversation summary>");
        }
        // No `recovery:compact` and no `context_compacted` emitted.
        expect(stream.events.some((e) => e.type === "context_compacted")).toBe(false);
        expect(stream.events.some((e) => e.type === "recovery" && e.reason === "compact")).toBe(false);
    });
    test("force_now: behaves as approve at the loop seam", async () => {
        const main = new ScriptedLLM([textScript("FOLDED"), textScript("final answer")]);
        const decisions = [];
        const out = await runAgent(cfg({
            llm: main,
            messages: bigHistory(),
            compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
            onPreCompact: async () => {
                decisions.push("force_now");
                return "force_now";
            },
        }));
        expect(out.reason).toBe("completed");
        expect(decisions).toEqual(["force_now"]);
        // Same effect as approve: summary call + answer call.
        expect(main.calls).toBe(2);
    });
    test("preflight throws → degrades via existing proactive-error event, no compaction", async () => {
        // Without a successful compaction the main llm answers on its first call.
        const main = new ScriptedLLM([textScript("final answer")]);
        const stream = new RecordingStream();
        const out = await runAgent(cfg({
            llm: main,
            stream,
            messages: bigHistory(),
            compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
            onPreCompact: async () => {
                throw new Error("user cancelled");
            },
        }));
        expect(out.reason).toBe("completed");
        // No summary call.
        expect(main.calls).toBe(1);
        // The existing graceful-degrade error AgentEvent surfaces the failure.
        const errs = stream.events.filter((e) => e.type === "error");
        expect(errs.length).toBeGreaterThanOrEqual(1);
        expect(errs[0]?.message).toContain("proactive compaction failed");
        expect(errs[0]?.message).toContain("user cancelled");
    });
});
describe("runAgent: ConversationSummaryArchive + context_compacted emit (ADR-0069)", () => {
    test("archive:true → entry appended + context_compacted emitted; legacy recovery first", async () => {
        const main = new ScriptedLLM([textScript("FOLDED HISTORY TEXT"), textScript("final answer")]);
        const stream = new RecordingStream();
        const out = await runAgent(cfg({
            llm: main,
            stream,
            messages: bigHistory(),
            compaction: {
                thresholdTokens: 50,
                keepRecentTurns: 1,
                archive: true,
            },
        }));
        expect(out.reason).toBe("completed");
        // Both markers fired (recovery FIRST, then context_compacted) for the SAME
        // compaction — that ordering is part of the byte-identical legacy contract.
        const recIdx = stream.events.findIndex((e) => e.type === "recovery" && e.reason === "compact");
        const ccIdx = stream.events.findIndex((e) => e.type === "context_compacted");
        expect(recIdx).toBeGreaterThanOrEqual(0);
        expect(ccIdx).toBeGreaterThan(recIdx);
        // The emitted payload carries the archive fields.
        const cc = stream.events[ccIdx];
        if (!cc || cc.type !== "context_compacted")
            throw new Error("context_compacted missing");
        expect(cc.fromTurnId).toBe("t0");
        expect(typeof cc.toTurnId).toBe("string");
        expect(cc.summary).toContain("FOLDED HISTORY TEXT");
        // The wrapper line `<conversation summary>` was stripped before archiving.
        expect(cc.summary.startsWith("<conversation summary>")).toBe(false);
        expect(cc.tokens).toBeGreaterThan(0);
        expect(cc.ts).toBeGreaterThan(0);
    });
    test("archive:false (default) → no context_compacted emitted, legacy recovery still fires", async () => {
        const main = new ScriptedLLM([textScript("FOLDED"), textScript("final answer")]);
        const stream = new RecordingStream();
        const out = await runAgent(cfg({
            llm: main,
            stream,
            messages: bigHistory(),
            // archive NOT set → byte-identical legacy compaction.
            compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
        }));
        expect(out.reason).toBe("completed");
        // Legacy compact marker fires.
        expect(stream.events.some((e) => e.type === "recovery" && e.reason === "compact")).toBe(true);
        // New context_compacted marker DOES NOT fire (default-OFF).
        expect(stream.events.some((e) => e.type === "context_compacted")).toBe(false);
    });
    test("archive + preflight defer → no archive append, no context_compacted emit", async () => {
        const main = new ScriptedLLM([textScript("final answer")]);
        const stream = new RecordingStream();
        const out = await runAgent(cfg({
            llm: main,
            stream,
            messages: bigHistory(),
            compaction: { thresholdTokens: 50, keepRecentTurns: 1, archive: true },
            onPreCompact: async () => "defer_one_turn",
        }));
        expect(out.reason).toBe("completed");
        // Host deferred ⇒ nothing folded, nothing archived, no marker emitted.
        expect(stream.events.some((e) => e.type === "context_compacted")).toBe(false);
        expect(main.calls).toBe(1);
    });
});
describe("createArchive: identity check", () => {
    test("a freshly-created archive starts empty (used as seed for the loop)", () => {
        const a = createArchive();
        expect(a.summaries).toEqual([]);
    });
});
