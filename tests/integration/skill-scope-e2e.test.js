// TODO(migrate-to-harness): swap the local `FakeLLM` + `RecordingStream` +
// `baseConfig` for `tests/integration/_harness.ts` exports
// (`FakeLLM` + `RecordingStream` + `baseConfig`). See `agent-loop.test.ts` for
// the pattern. Deferred from refactor B to keep that PR scoped to 3 files.
/**
 * Skill tool-scoping ENFORCEMENT — end-to-end (ADR-0011).
 *
 * Proves the loop's `SkillGate` is actually wired through
 * runAgent → runTurn → streamConsume → dispatch closure:
 *
 *  (a) after a scoped `Skill` invocation, a DISALLOWED tool is denied as a
 *      recoverable (`is_error`) tool_result WITHOUT being dispatched (a stub
 *      side-effect counter proves non-execution), the model recovers, and a
 *      subsequently-ALLOWED tool runs normally.
 *  (b) the `Skill` / `ToolSearch` meta-tools are always permitted even under
 *      an active scope.
 *  (c) a skill that declares NO `tools:` imposes no restriction.
 *  (d) control: with no skills configured there is no gate at all.
 *
 * Deterministic: scripted fake LLM, no network, temp skill dirs cleaned up.
 * Mirrors the fake-LLM harness in tests/integration/agent-features.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "@/agent";
import { ToolRegistry } from "@/tool";
/** Yields one scripted StreamEvent[] per stream() call, in order. */
class FakeLLM {
    scripts;
    last = [];
    calls = 0;
    constructor(scripts) {
        this.scripts = scripts;
    }
    async *stream() {
        const next = this.scripts.shift();
        if (next)
            this.last = next;
        const script = next ?? this.last;
        this.calls += 1;
        for (const ev of script)
            yield ev;
    }
}
/** StreamPort double recording every emitted AgentEvent. */
class RecordingStream {
    events = [];
    emit(event) {
        this.events.push(event);
    }
}
const toolUseScript = (id, name, input) => [
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, input },
    { type: "message_stop", stop_reason: "tool_use" },
];
const textScript = (text) => [
    { type: "text_delta", delta: text },
    { type: "message_stop", stop_reason: "end_turn" },
];
/** A counting stub tool: every actual `execute()` bumps `counts[name]`. If a
 *  call is scope-DENIED by the loop the closure never runs, so the counter
 *  staying flat is the non-dispatch proof. */
const countingTool = (name, counts) => ({
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute() {
        counts[name] = (counts[name] ?? 0) + 1;
        yield { type: "result", result: { ok: true, output: `${name} ran` } };
    },
});
const baseConfig = (llm, registry, stream, cwd, permission) => ({
    llm,
    registry,
    stream,
    permission,
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "test",
    cwd,
    maxTurns: 12,
    signal: new AbortController().signal,
    onConfirm: async () => false,
});
const allToolResults = (outcome) => outcome.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
const SCOPE_MSG = "not in the active skill's permitted tool set";
describe("skill tool-scoping enforcement (e2e)", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "skill-scope-e2e-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    // (a) + (b): scoped skill arms a gate; disallowed tool denied & NOT
    // dispatched; meta-tools always allowed; allowed tool runs.
    test("scoped skill denies out-of-scope tool without dispatching, allows in-scope + meta", async () => {
        // Skill `narrow` permits ONLY the "Read" tool.
        await mkdir(join(dir, "narrow"), { recursive: true });
        await writeFile(join(dir, "narrow", "SKILL.md"), '---\nname: narrow\ndescription: narrow scope\ntools: ["Read"]\n---\nUse only Read.\n');
        const counts = {};
        const registry = new ToolRegistry([
            countingTool("Read", counts),
            countingTool("danger", counts),
        ]);
        const llm = new FakeLLM([
            // 1. arm the scope via the scoped skill
            toolUseScript("s1", "Skill", { name: "narrow" }),
            // 2. ToolSearch meta-tool — must be allowed even under active scope
            toolUseScript("t1", "ToolSearch", { query: "select:Read" }),
            // 3. disallowed tool — must be DENIED, recoverable, NOT executed
            toolUseScript("d1", "danger", {}),
            // 4. model recovers and uses the allowed tool
            toolUseScript("r1", "Read", {}),
            // 5. another Skill call is always allowed (meta) — re-arm
            toolUseScript("s2", "Skill", { name: "narrow" }),
            // 6. done
            textScript("finished"),
        ]);
        const stream = new RecordingStream();
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
            skills: { dir },
        });
        expect(outcome.reason).toBe("completed");
        // The disallowed tool was NEVER executed (non-dispatch proof).
        expect(counts.danger).toBeUndefined();
        // The allowed tool DID execute exactly once.
        expect(counts.Read).toBe(1);
        const results = allToolResults(outcome);
        // Exactly one scope-deny tool_result, and it is a recoverable error.
        const denied = results.filter((b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG));
        expect(denied).toHaveLength(1);
        const d = denied[0];
        if (d?.type === "tool_result") {
            expect(d.is_error).toBe(true);
            expect(d.tool_use_id).toBe("d1");
        }
        // The ToolSearch meta-call ran (allowed) — its result is present & not a
        // scope-deny.
        const tsResult = results.find((b) => b.type === "tool_result" && b.tool_use_id === "t1");
        expect(tsResult).toBeDefined();
        if (tsResult?.type === "tool_result") {
            expect(tsResult.is_error ?? false).toBe(false);
            expect(tsResult.content.includes(SCOPE_MSG)).toBe(false);
        }
        // The allowed Read call produced a normal (non-error) result.
        const readResult = results.find((b) => b.type === "tool_result" && b.tool_use_id === "r1");
        expect(readResult).toBeDefined();
        if (readResult?.type === "tool_result") {
            expect(readResult.is_error ?? false).toBe(false);
            expect(readResult.content).toContain("Read ran");
        }
        // The Skill meta-tool itself was never scope-denied.
        const skillDenied = results.some((b) => b.type === "tool_result" &&
            (b.tool_use_id === "s1" || b.tool_use_id === "s2") &&
            b.content.includes(SCOPE_MSG));
        expect(skillDenied).toBe(false);
    });
    // (c): a skill that declares NO `tools:` imposes no restriction — any tool
    // invoked after it runs normally.
    test("skill with no tools: declared ⇒ no restriction (arbitrary tool runs)", async () => {
        await mkdir(join(dir, "open"), { recursive: true });
        await writeFile(join(dir, "open", "SKILL.md"), "---\nname: open\ndescription: open scope\n---\nNo tool restriction.\n");
        const counts = {};
        const registry = new ToolRegistry([countingTool("anything", counts)]);
        const llm = new FakeLLM([
            toolUseScript("s1", "Skill", { name: "open" }),
            toolUseScript("a1", "anything", {}),
            textScript("done"),
        ]);
        const stream = new RecordingStream();
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
            skills: { dir },
        });
        expect(outcome.reason).toBe("completed");
        // No allowlist anywhere ⇒ skillAllowlists absent ⇒ gate undefined ⇒ the
        // arbitrary tool runs.
        expect(counts.anything).toBe(1);
        const denied = allToolResults(outcome).filter((b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG));
        expect(denied).toHaveLength(0);
    });
    // (c'): a scoped skill EXISTS in the dir (so a gate is built) but the model
    // invokes the UNSCOPED skill — the gate stays disarmed, arbitrary tool runs.
    test("invoking the unscoped skill leaves the gate disarmed even when a scoped skill exists", async () => {
        await mkdir(join(dir, "narrow"), { recursive: true });
        await writeFile(join(dir, "narrow", "SKILL.md"), '---\nname: narrow\ndescription: n\ntools: ["Read"]\n---\nbody\n');
        await mkdir(join(dir, "open"), { recursive: true });
        await writeFile(join(dir, "open", "SKILL.md"), "---\nname: open\ndescription: o\n---\nbody\n");
        const counts = {};
        const registry = new ToolRegistry([countingTool("danger", counts)]);
        const llm = new FakeLLM([
            // invoke the UNSCOPED skill — gate exists but is not armed by this
            toolUseScript("s1", "Skill", { name: "open" }),
            // a tool not in narrow's list — must still run (scope never armed)
            toolUseScript("d1", "danger", {}),
            textScript("done"),
        ]);
        const stream = new RecordingStream();
        const outcome = await runAgent({
            ...baseConfig(llm, registry, stream, dir, { mode: "bypass" }),
            skills: { dir },
        });
        expect(outcome.reason).toBe("completed");
        expect(counts.danger).toBe(1);
        const denied = allToolResults(outcome).filter((b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG));
        expect(denied).toHaveLength(0);
    });
    // (d): control — no skills configured at all ⇒ no gate, behavior unchanged.
    test("control: no skills configured ⇒ no gate, tools run unrestricted", async () => {
        const counts = {};
        const registry = new ToolRegistry([
            countingTool("Read", counts),
            countingTool("danger", counts),
        ]);
        const llm = new FakeLLM([
            toolUseScript("a1", "danger", {}),
            toolUseScript("a2", "Read", {}),
            textScript("done"),
        ]);
        const stream = new RecordingStream();
        // NOTE: no `skills:` block.
        const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "bypass" }));
        expect(outcome.reason).toBe("completed");
        expect(counts.danger).toBe(1);
        expect(counts.Read).toBe(1);
        const denied = allToolResults(outcome).filter((b) => b.type === "tool_result" && b.content.includes(SCOPE_MSG));
        expect(denied).toHaveLength(0);
    });
});
