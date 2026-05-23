import { describe, expect, test } from "bun:test";
import { compactIfNeeded, estimateTokens, findBoundary } from "@/agent";
/** FakeLLM that records its StreamInput and yields a fixed summary text. */
class SummarizingLLM {
    summary;
    lastSystem;
    lastMessages = [];
    constructor(summary) {
        this.summary = summary;
    }
    async *stream(input) {
        this.lastSystem = input.system;
        this.lastMessages = input.messages;
        yield { type: "text_delta", delta: this.summary };
        yield { type: "message_stop", stop_reason: "end_turn" };
    }
}
const userText = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistantText = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
});
const assistantToolUse = (id, text) => ({
    role: "assistant",
    content: [
        { type: "text", text },
        { type: "tool_use", id, name: "read", input: { path: "/x" } },
    ],
});
const toolResult = (id, content) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content }],
});
describe("estimateTokens", () => {
    test("chars/4 heuristic", () => {
        expect(estimateTokens([userText("a".repeat(40))])).toBe(10);
    });
});
describe("findBoundary", () => {
    test("keeps last N assistant turns", () => {
        const msgs = [userText("seed"), assistantText("a1"), assistantText("a2"), assistantText("a3")];
        // keep 1 → boundary at index of last assistant (3)
        expect(findBoundary(msgs, 1)).toBe(3);
    });
    test("expands backward so a retained tool_result keeps its tool_use", () => {
        const msgs = [
            userText("seed"),
            assistantToolUse("t1", "calling"),
            toolResult("t1", "result data"),
            assistantText("done"),
        ];
        // keep 1 → scanning back: assistantText(#1), toolResult, assistantToolUse
        // (#2 → break) leaves naive boundary at the toolResult (idx 2). Its
        // tool_use t1 lives at idx 1 (prefix) → orphaned, so the boundary walks
        // back to idx 1 to keep the (tool_use, tool_result) pair together.
        expect(findBoundary(msgs, 1)).toBe(1);
        const b1 = findBoundary(msgs, 1);
        const suffix = msgs.slice(b1);
        const useIds = new Set(suffix.flatMap((m) => m.content
            .filter((x) => x.type === "tool_use")
            .map((x) => (x.type === "tool_use" ? x.id : ""))));
        for (const m of suffix) {
            for (const x of m.content) {
                if (x.type === "tool_result")
                    expect(useIds.has(x.tool_use_id)).toBe(true);
            }
        }
        // No tool calls → boundary is the plain keepTurns cut, no expansion.
        const plain = [userText("s"), assistantText("a1"), assistantText("a2")];
        expect(findBoundary(plain, 1)).toBe(2);
    });
    test("keepTurns=0 with an assistant tail does not crash (empty-suffix guard)", () => {
        // Regression: the initial scan can leave the boundary at messages.length
        // (empty suffix) when the (keepTurns+1)-th assistant is the LAST message —
        // the break fires before `idx = i`, so idx stays at the sentinel length.
        // The orphan-walk then dereferenced messages[length] (undefined) and threw
        // a TypeError. The walk must treat an empty suffix as already orphan-free.
        const msgs = [assistantText("a1"), assistantText("a2")];
        expect(() => findBoundary(msgs, 0)).not.toThrow();
        expect(findBoundary(msgs, 0)).toBe(msgs.length);
    });
    test("keepTurns=0 over a tool pair stays orphan-free and never out of bounds", () => {
        // The empty-suffix path must not leave a dangling tool_result either.
        const msgs = [
            assistantToolUse("t1", "calling"),
            toolResult("t1", "result"),
            assistantText("done"),
        ];
        const b = findBoundary(msgs, 0);
        const suffix = msgs.slice(b);
        const useIds = new Set(suffix.flatMap((m) => m.content
            .filter((x) => x.type === "tool_use")
            .map((x) => (x.type === "tool_use" ? x.id : ""))));
        for (const m of suffix) {
            for (const x of m.content) {
                if (x.type === "tool_result")
                    expect(useIds.has(x.tool_use_id)).toBe(true);
            }
        }
    });
});
describe("compactIfNeeded", () => {
    test("under threshold → unchanged, compacted:false", async () => {
        const msgs = [userText("hi"), assistantText("hello")];
        const llm = new SummarizingLLM("SUMMARY");
        const res = await compactIfNeeded({
            messages: msgs,
            llm,
            system: "sys",
            thresholdTokens: 100_000,
        });
        expect(res.compacted).toBe(false);
        expect(res.messages).toBe(msgs);
        expect(llm.lastMessages).toEqual([]);
    });
    test("over threshold → old prefix replaced by one summary, recent preserved, no orphan", async () => {
        const msgs = [
            userText("a".repeat(2000)),
            assistantToolUse("t1", "old1"),
            toolResult("t1", "b".repeat(2000)),
            assistantText("old2"),
            userText("recent ask"),
            assistantText("recent answer"),
        ];
        const llm = new SummarizingLLM("CONDENSED HISTORY");
        const res = await compactIfNeeded({
            messages: msgs,
            llm,
            system: "sys",
            thresholdTokens: 100,
            keepRecentTurns: 1,
        });
        expect(res.compacted).toBe(true);
        if (!res.compacted)
            return;
        // First message is the synthetic summary user message.
        const first = res.messages[0];
        expect(first?.role).toBe("user");
        const firstText = first?.content[0];
        expect(firstText?.type).toBe("text");
        if (firstText?.type === "text") {
            expect(firstText.text).toContain("<conversation summary>");
            expect(firstText.text).toContain("CONDENSED HISTORY");
        }
        // Recent suffix preserved verbatim.
        expect(res.messages.at(-1)).toEqual(assistantText("recent answer"));
        // No orphaned tool_result: every tool_result has its tool_use in the suffix.
        const useIds = new Set(res.messages.flatMap((m) => m.content
            .filter((b) => b.type === "tool_use")
            .map((b) => (b.type === "tool_use" ? b.id : ""))));
        for (const m of res.messages) {
            for (const b of m.content) {
                if (b.type === "tool_result")
                    expect(useIds.has(b.tool_use_id)).toBe(true);
            }
        }
        // Summarizer received the original system prompt context.
        expect(llm.lastSystem).toBeDefined();
        expect(res.summaryTokens).toBeGreaterThan(0);
    });
});
