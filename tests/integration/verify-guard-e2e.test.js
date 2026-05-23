// TODO(migrate-to-harness): swap the local `ScriptedLLM` + `RecordingStream`
// for `tests/integration/_harness.ts` exports (`ScriptedLLM` + `RecordingStream`
// + `baseConfig`). See `agent-loop.test.ts` for the pattern. Deferred from
// refactor B to keep that PR scoped to 3 files.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgent } from "@/agent";
import { VERIFY_FORCE_MESSAGE } from "@/agent/verify-guard";
import { ToolRegistry } from "@/tool";
class ScriptedLLM {
    inputs = [];
    calls = 0;
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
// ── Deterministic stub tools (no fs / no exec) ──────────────────────────────
// Each records every dispatch so a test can also assert call counts directly.
const dispatched = [];
const stubTool = (name, readOnly) => ({
    name,
    description: `stub ${name}`,
    inputSchema: z.any(),
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => readOnly,
    async *execute() {
        dispatched.push(name);
        yield { type: "result", result: { ok: true, output: `${name} ok` } };
    },
});
const stubRegistry = () => new ToolRegistry([
    stubTool("read", true),
    stubTool("edit", false),
    stubTool("write", false),
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
/** Hang guard: the loop's bounded budgets guarantee termination; a timeout
 *  here means a verify-guard regression spun the loop forever. */
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
/** All text in `m` joined (for ordered transcript assertions). */
const msgText = (m) => m.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
/** Names of tool_use blocks the assistant emitted across the transcript, in
 *  order — proves WHEN the edit / test_runner ran relative to the forcing. */
const toolUseSequence = (messages) => messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.name));
const hasForcing = (messages) => messages.some((m) => m.role === "user" &&
    m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE));
describe("verify-guard e2e — integrated runAgent", () => {
    test("1. forces an EXTRA turn after an unverified edit, then completes once verified", async () => {
        dispatched.length = 0;
        // turn1: edit (mutating). turn2: pure text "done" → finish attempt with NO
        // verify since the edit ⇒ guard MUST block + inject forcing + re-enter.
        // turn3 (the FORCED extra turn): test_runner (verify). turn4: text → done.
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
            ev(text("All done, the fix is complete.")),
            ev(toolUse("t1", "test_runner", { suite: "nearest" })),
            ev(text("Tests pass. Done for real.")),
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, verifyGuard: { maxTrips: 2 }, maxTurns: 6 })), 15_000, "forces-extra-turn");
        expect(out.reason).toBe("completed");
        // The loop did NOT finish at the turn-2 stop: it injected the forcing
        // message and ran more turns ⇒ strictly more LLM calls than the 2 scripted
        // up to the (unforced) finish.
        expect(llm.calls).toBe(4);
        // The forcing message was injected into working memory / transcript.
        expect(hasForcing(out.messages)).toBe(true);
        // Ordered proof the EXTRA turn happened AFTER the forcing: edit → forcing
        // user message → test_runner appear in that exact relative order.
        const editIdx = out.messages.findIndex((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use" && b.name === "edit"));
        const forceIdx = out.messages.findIndex((m) => m.role === "user" &&
            m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE));
        const verifyIdx = out.messages.findIndex((m) => m.role === "assistant" &&
            m.content.some((b) => b.type === "tool_use" && b.name === "test_runner"));
        expect(editIdx).toBeGreaterThanOrEqual(0);
        expect(forceIdx).toBeGreaterThan(editIdx);
        expect(verifyIdx).toBeGreaterThan(forceIdx);
        // The dropped "All done" assistant turn is KEPT (keepMessage:true) right
        // before the forcing user message.
        const beforeForce = out.messages[forceIdx - 1];
        expect(beforeForce?.role).toBe("assistant");
        expect(msgText(beforeForce)).toContain("All done");
        // Tools actually dispatched through the REAL registry, in order — exactly
        // one forcing trip was spent (the `recovery:unverified` event is asserted
        // in test 1c; the same-turn re-entry not consuming a slot in test 1b).
        expect(dispatched).toEqual(["edit", "test_runner"]);
    });
    test("1b. the forced re-entry is a SAME-turn re-stream — does NOT consume a maxTurns slot", async () => {
        dispatched.length = 0;
        // maxTurns is set to exactly the number of PRODUCTIVE turns:
        //   slot-1: the `edit` tool turn (a real `tools` TurnResult).
        //   slot-2: the model keeps emitting pure-text finishes; the guard forces
        //           it twice (maxTrips=2) then lets the 3rd finish through. Each
        //           forced re-stream re-enters runTurn's `for(;;)` — the SAME turn
        //           slot, NOT a `for turn` increment.
        // The model never verifies, so the forced re-entries never call a tool:
        // they all re-stream inside slot-2 and the run completes there. If a
        // forced re-entry consumed a turn slot this run (maxTurns=2) would instead
        // end "max_turns". 4 LLM calls completing within 2 turn slots is the proof
        // that the 2 extra (forced) streams were same-turn re-entries.
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
            ev(text("Done attempt 1.")),
            ev(text("Done attempt 2.")),
            ev(text("Done attempt 3 — allowed through.")),
            ev(text("must NOT be reached")), // defensive bound
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, verifyGuard: { maxTrips: 2 }, maxTurns: 2 })), 15_000, "forced-no-turn-consume");
        expect(out.reason).toBe("completed");
        expect(hasForcing(out.messages)).toBe(true);
        // 4 LLM calls (edit + 3 finish attempts) completing within maxTurns=2 ⇒
        // the 2 forced re-streams were SAME-turn re-entries, not turn increments
        // (else reason would be "max_turns"). The 5th scripted step is never
        // consumed — the maxTrips cap bounds the same-turn re-entry.
        expect(llm.calls).toBe(4);
        expect(out.turns).toBe(2);
    });
    test("1c. recovery:unverified AgentEvent is emitted on the forcing", async () => {
        dispatched.length = 0;
        const stream = new RecordingStream();
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
            ev(text("done")),
            ev(toolUse("t1", "test_runner", {})),
            ev(text("verified")),
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 6 })), 15_000, "unverified-recovery-event");
        expect(out.reason).toBe("completed");
        const unverified = stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified");
        expect(unverified).toHaveLength(1);
    });
    test("2. maxTrips cap — keeps trying to finish unverified, forced EXACTLY maxTrips then completes", async () => {
        dispatched.length = 0;
        // turn1 edit, then the model NEVER verifies — it just keeps emitting a
        // pure-text finish. With maxTrips=2 it is forced twice; the 3rd finish
        // attempt is allowed through (cap reached) ⇒ completed, NO infinite loop.
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
            ev(text("done attempt 1")),
            ev(text("done attempt 2")),
            ev(text("done attempt 3")),
            ev(text("done attempt 4")), // defensive: must NOT be reached
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, verifyGuard: { maxTrips: 2 }, maxTurns: 10 })), 15_000, "max-trips-cap");
        expect(out.reason).toBe("completed");
        // edit-call + 3 finish attempts: forced after attempt 1 and attempt 2
        // (2 == maxTrips), attempt 3 allowed ⇒ exactly 4 LLM calls. The 4th
        // scripted step is never consumed (bound proof — no spin).
        expect(llm.calls).toBe(4);
        // The forcing message was injected exactly maxTrips (2) times.
        const forcingCount = out.messages.filter((m) => m.role === "user" &&
            m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE)).length;
        expect(forcingCount).toBe(2);
        expect(dispatched).toEqual(["edit"]);
    });
    test("2b. maxTrips:1 — forced exactly once then allowed to complete", async () => {
        dispatched.length = 0;
        const stream = new RecordingStream();
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", {})),
            ev(text("finish 1")),
            ev(text("finish 2")),
            ev(text("finish 3")), // defensive: never reached
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 1 }, maxTurns: 10 })), 15_000, "max-trips-1");
        expect(out.reason).toBe("completed");
        expect(llm.calls).toBe(3); // edit + finish1(forced) + finish2(allowed)
        const forcingCount = out.messages.filter((m) => m.role === "user" &&
            m.content.some((b) => b.type === "text" && b.text === VERIFY_FORCE_MESSAGE)).length;
        expect(forcingCount).toBe(1);
        expect(stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified")).toHaveLength(1);
    });
    test("3. a verify (bash) AFTER the edit ⇒ NO forcing, completes on first finish attempt", async () => {
        dispatched.length = 0;
        const stream = new RecordingStream();
        // edit → bash (verify) → text done. Guard sees a verify after the last
        // mutating tool ⇒ never blocks. The bash command MUST be in the real
        // `command` input field (that is what the loop extracts as the guard
        // `arg`) AND match R1's test/repro regex — a `pytest` invocation does.
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts" })),
            ev(toolUse("b1", "bash", { command: "pytest -q" })),
            ev(text("Verified and done.")),
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 6 })), 15_000, "verify-after-edit");
        expect(out.reason).toBe("completed");
        expect(llm.calls).toBe(3); // exactly the 3 scripted turns, no extra
        expect(hasForcing(out.messages)).toBe(false);
        expect(stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified")).toHaveLength(0);
        expect(toolUseSequence(out.messages)).toEqual(["edit", "bash"]);
        expect(dispatched).toEqual(["edit", "bash"]);
    });
    test("3b. test_runner after the edit ⇒ NO forcing", async () => {
        dispatched.length = 0;
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", {})),
            ev(toolUse("t1", "test_runner", {})),
            ev(text("done")),
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, verifyGuard: { maxTrips: 2 }, maxTurns: 6 })), 15_000, "test-runner-after-edit");
        expect(out.reason).toBe("completed");
        expect(llm.calls).toBe(3);
        expect(hasForcing(out.messages)).toBe(false);
    });
    test("3c. a NOISE bash (git status) after the edit ⇒ STILL forces (prod regression)", async () => {
        dispatched.length = 0;
        const stream = new RecordingStream();
        // EMPIRICALLY-CONFIRMED prod defect: a real SWE-bench run had the guard
        // fire 0 times because the agent ran `git status` after editing and the
        // OLD policy counted ANY bash as "verified". R1's tightened policy must
        // NOT count a noise bash: edit → bash(git status) → finish MUST still be
        // forced; only the later real test (pytest) satisfies the guard.
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts" })),
            ev(toolUse("b1", "bash", { command: "git status" })),
            ev(text("All done.")),
            ev(toolUse("b2", "bash", { command: "python -m pytest -q" })),
            ev(text("Verified and done.")),
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 8 })), 15_000, "noise-bash-still-forces");
        expect(out.reason).toBe("completed");
        // edit + git-status + finish-attempt(forced) + pytest + finish(allowed)
        // = exactly 5 LLM calls. If `git status` had (wrongly) satisfied the guard
        // the run would have finished at call 3 with no forcing.
        expect(llm.calls).toBe(5);
        expect(hasForcing(out.messages)).toBe(true);
        expect(stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified")).toHaveLength(1);
        expect(toolUseSequence(out.messages)).toEqual(["edit", "bash", "bash"]);
        expect(dispatched).toEqual(["edit", "bash", "bash"]);
    });
    test("4. guard OFF (no config.verifyGuard) ⇒ byte-identical: edit-then-finish completes immediately", async () => {
        dispatched.length = 0;
        const stream = new RecordingStream();
        // EXACT same edit-then-finish script as test 1's first two turns, but with
        // NO verifyGuard config. Must complete on the first finish attempt with no
        // forcing message and no unverified recovery event — behavior unchanged.
        const llm = new ScriptedLLM([
            ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
            ev(text("All done, the fix is complete.")),
            ev(text("must NOT be reached")), // defensive
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, stream, maxTurns: 6 })), 15_000, "guard-off-byte-identical");
        expect(out.reason).toBe("completed");
        // Only the 2 scripted turns ran (no forced extra turn).
        expect(llm.calls).toBe(2);
        expect(hasForcing(out.messages)).toBe(false);
        expect(stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified")).toHaveLength(0);
        // Final assistant turn is the "All done" text, immediately after the edit
        // tool-result — identical to the pre-guard path.
        const last = out.messages.at(-1);
        expect(last?.role).toBe("assistant");
        expect(msgText(last)).toContain("All done");
        expect(dispatched).toEqual(["edit"]);
    });
    test("5. no mutating tool at all (only reads) ⇒ never forces", async () => {
        dispatched.length = 0;
        const stream = new RecordingStream();
        const llm = new ScriptedLLM([
            ev(toolUse("r1", "read", { path: "/a.ts" })),
            ev(toolUse("r2", "read", { path: "/b.ts" })),
            ev(text("Analysis complete, no changes needed.")),
        ]);
        const out = await withTimeout(runAgent(cfg({ llm, stream, verifyGuard: { maxTrips: 2 }, maxTurns: 6 })), 15_000, "no-mutating-tool");
        expect(out.reason).toBe("completed");
        expect(llm.calls).toBe(3); // no forced extra turn
        expect(hasForcing(out.messages)).toBe(false);
        expect(stream.events.filter((e) => e.type === "recovery" && e.reason === "unverified")).toHaveLength(0);
        expect(dispatched).toEqual(["read", "read"]);
    });
});
