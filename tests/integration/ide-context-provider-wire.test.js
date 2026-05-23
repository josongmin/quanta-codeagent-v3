/**
 * ADR-0080 — IDE context provider seam, end-to-end through `runAgent`.
 *
 * Drives the REAL agent loop with a fake `IdeContextProvider` that returns a
 * fixed snapshot. The contract checked here is the SEAM, not the renderer (the
 * renderer is unit-tested in `tests/unit/agent/ide-context-render.test.ts`):
 *
 *  1. With a provider wired, the rendered `<ide-context>` block appears in the
 *     latest user message that the LLM actually sees.
 *  2. The block sits in the USER turn (not inside a `<system-reminder>`) and
 *     BEFORE any trailing `<system-reminder>` tail — so its trust attribution
 *     is user-side, matching the spec.
 *  3. With no provider wired the per-turn user message is byte-identical to
 *     the pre-ADR shape (the seam is default-OFF).
 *  4. Provider rejection / throw is caught at the boundary, logged as an
 *     `error` AgentEvent, and the turn proceeds with no IDE block (an IDE
 *     bug must NOT crash the turn).
 *  5. Returning `null` from the provider also renders no block (closed signal
 *     for "no IDE attached").
 *  6. Provider's `snapshot()` is called once per turn (turn-entry capture).
 */
import { describe, expect, test } from "bun:test";
import { runAgent } from "@/agent";
import { baseConfig, FakeLLM, RecordingStream, text, withTimeout } from "./_harness";
/** First index `i` in `messages` such that `messages[i]` is a user message
 *  whose first text block matches `pred`. Returns -1 if none. Extracted so
 *  individual tests stay below the lint complexity threshold. */
const findFirstUserMessageIdx = (messages, pred) => {
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m?.role !== "user")
            continue;
        const t = m.content.find((b) => b.type === "text");
        if (t?.type === "text" && pred(t.text))
            return i;
    }
    return -1;
};
/** All user messages the LLM saw on its k-th call (1-indexed), joined for
 *  searching across the system-reminder tail + the conversation user turn. */
const allUserTexts = (seenMessages, call = 1) => {
    const messages = seenMessages[call - 1];
    if (!messages)
        throw new Error(`no messages on call ${call}`);
    const out = [];
    for (const m of messages) {
        if (m.role !== "user")
            continue;
        for (const b of m.content) {
            if (b.type === "text")
                out.push(b.text);
        }
    }
    return out;
};
const fixedSnapshot = () => ({
    activeFile: { path: "src/foo.ts", line: 42 },
    openTabs: [{ path: "src/foo.ts", dirty: true }, { path: "src/bar.ts" }],
    selection: { path: "src/foo.ts", range: [100, 120], text: "doThing()" },
    diagnostics: [{ path: "src/foo.ts", severity: "error", line: 42, message: "boom" }],
});
class FixedProvider {
    value;
    calls = 0;
    constructor(value) {
        this.value = value;
    }
    async snapshot(_signal) {
        this.calls += 1;
        return this.value;
    }
}
class ThrowingProvider {
    calls = 0;
    async snapshot(_signal) {
        this.calls += 1;
        throw new Error("IDE bridge offline");
    }
}
describe("IDE context provider wire (ADR-0080)", () => {
    test("default-OFF: no provider ⇒ no <ide-context> in any user message", async () => {
        const llm = new FakeLLM([text("ok")]);
        const config = baseConfig({ llm });
        await withTimeout(runAgent(config), 2000, "default-off");
        const texts = allUserTexts(llm.seenMessages, 1);
        for (const t of texts) {
            expect(t).not.toContain("<ide-context>");
        }
    });
    test("provider returning a snapshot prepends rendered block to the user turn", async () => {
        const llm = new FakeLLM([text("ok")]);
        const provider = new FixedProvider(fixedSnapshot());
        const config = baseConfig({ llm, ideContextProvider: provider });
        await withTimeout(runAgent(config), 2000, "provider-wired");
        expect(provider.calls).toBe(1);
        // The IDE block lands in the CONVERSATION user turn (the seed "go" — the
        // first user message), NOT in the trailing <system-reminder>.
        const userTurn = lastUserTextNonReminder(llm.seenMessages, 1);
        expect(userTurn).toContain("<ide-context>");
        expect(userTurn).toContain("## Active file: src/foo.ts:42");
        expect(userTurn).toContain("- src/foo.ts [dirty]");
        expect(userTurn).toContain("## Selection in src/foo.ts [100:120]:");
        expect(userTurn).toContain("doThing()");
        expect(userTurn).toContain("- error src/foo.ts:42 — boom");
        expect(userTurn).toContain("</ide-context>");
        // Seed user text follows the IDE block (prepend semantics).
        expect(userTurn.indexOf("<ide-context>")).toBeLessThan(userTurn.indexOf("go"));
    });
    test("IDE block sits BEFORE the trailing <system-reminder> tail in the messages array", async () => {
        const llm = new FakeLLM([text("ok")]);
        const provider = new FixedProvider(fixedSnapshot());
        const config = baseConfig({ llm, ideContextProvider: provider });
        await withTimeout(runAgent(config), 2000, "ordering");
        const messages = llm.seenMessages[0];
        if (!messages)
            throw new Error("no first call");
        const ideIdx = findFirstUserMessageIdx(messages, (t) => t.includes("<ide-context>"));
        const reminderIdx = findFirstUserMessageIdx(messages, (t) => t.startsWith("<system-reminder>"));
        expect(ideIdx).toBeGreaterThanOrEqual(0);
        expect(reminderIdx).toBeGreaterThanOrEqual(0);
        // The reminder is appended LAST; the IDE block lives in an EARLIER user
        // turn (the conversation seed). So ideIdx < reminderIdx.
        expect(ideIdx).toBeLessThan(reminderIdx);
    });
    test("IDE block is NOT inside the <system-reminder> wrapper", async () => {
        const llm = new FakeLLM([text("ok")]);
        const provider = new FixedProvider(fixedSnapshot());
        const config = baseConfig({ llm, ideContextProvider: provider });
        await withTimeout(runAgent(config), 2000, "trust-boundary");
        const messages = llm.seenMessages[0];
        if (!messages)
            throw new Error("no first call");
        // Inspect the reminder user message — it must NOT contain the IDE block.
        for (const m of messages) {
            if (m.role !== "user")
                continue;
            const t = m.content.find((b) => b.type === "text");
            if (t?.type !== "text")
                continue;
            if (t.text.startsWith("<system-reminder>")) {
                expect(t.text).not.toContain("<ide-context>");
            }
        }
    });
    test("null snapshot ⇒ no block rendered", async () => {
        const llm = new FakeLLM([text("ok")]);
        const provider = new FixedProvider(null);
        const config = baseConfig({ llm, ideContextProvider: provider });
        await withTimeout(runAgent(config), 2000, "null-snapshot");
        expect(provider.calls).toBe(1);
        for (const t of allUserTexts(llm.seenMessages, 1)) {
            expect(t).not.toContain("<ide-context>");
        }
    });
    test("provider throw ⇒ logged as error event, turn proceeds with no block", async () => {
        const llm = new FakeLLM([text("ok")]);
        const provider = new ThrowingProvider();
        const stream = new RecordingStream();
        const config = baseConfig({ llm, stream, ideContextProvider: provider });
        const outcome = await withTimeout(runAgent(config), 2000, "throwing");
        // The turn completed (the IDE bug did NOT abort).
        expect(outcome.reason).toBe("completed");
        expect(provider.calls).toBe(1);
        // No IDE block in the request payload.
        for (const t of allUserTexts(llm.seenMessages, 1)) {
            expect(t).not.toContain("<ide-context>");
        }
        // The error WAS surfaced as an AgentEvent (observability boundary).
        const errors = stream.events.filter((e) => e.type === "error");
        expect(errors.length).toBeGreaterThan(0);
        const matched = errors.find((e) => e.type === "error" && e.message.includes("ide-context provider failed"));
        expect(matched).toBeDefined();
    });
});
/** Latest user message that is NOT the trailing <system-reminder> tail. The
 *  reminder is appended as its own user message; the IDE block lives in the
 *  conversation user turn that precedes it. */
const lastUserTextNonReminder = (seenMessages, call = 1) => {
    const messages = seenMessages[call - 1];
    if (!messages)
        throw new Error(`no messages on call ${call}`);
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== "user")
            continue;
        const t = m.content.find((b) => b.type === "text");
        if (t?.type !== "text")
            continue;
        if (t.text.startsWith("<system-reminder>"))
            continue;
        return t.text;
    }
    throw new Error("no non-reminder user message with text");
};
