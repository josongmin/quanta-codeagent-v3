/**
 * Session resume e2e — closes the L3 gap for `QUANTA_STATE_PATH` /
 * `QUANTA_RESUME` (catalog row 10.2). Existing coverage:
 *   - `tests/unit/state.test.ts`: round-trip, missing file, corrupt JSON,
 *     wrong shape, single-runAgent closure (C5).
 *
 * What was MISSING is a multi-turn closure that proves:
 *   (a) the FULL transcript — including tool_use / tool_result blocks — is
 *       preserved across a save/load boundary, and
 *   (b) the loaded transcript can be RESUMED by a fresh runAgent and the
 *       second session sees the prior messages as starting history.
 *
 * The unit C5 covered single-message preservation. Tool-bearing turns are
 * the regression-risk shape: a refactor to message normalization or content-
 * block typing that dropped tool_use IDs (a real RFC-0002 risk) would pass
 * the unit C5 but fail the resume contract HERE — that's the gap closed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadSession, runAgent, saveSession } from "@/agent";
import { defaultTools, ToolRegistry } from "@/tool";
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness";
/** Tiny tool with deterministic output — so the resume assertions can pin
 *  the EXACT preview text that was persisted. */
const echoTool = {
    name: "tiny_echo",
    description: "Echo input.message back as the result.",
    inputSchema: z.object({ message: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input) {
        yield {
            type: "result",
            result: { ok: true, output: input.message },
        };
    },
};
let dir;
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cli-resume-e2e-"));
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});
describe("Session resume e2e — save/load preserves multi-turn transcript and resumes", () => {
    test("multi-turn run with tool use → save → load → resume → second runAgent sees prior history", async () => {
        const path = join(dir, "session.json");
        // ── First session: tool_use turn + a follow-up text turn.
        const llm1 = new ScriptedLLM([
            ev(toolUse("call-1", "tiny_echo", { message: "stage-one-output" })),
            ev(text("done with stage one")),
        ]);
        const config1 = cfg({
            llm: llm1,
            registry: new ToolRegistry([...defaultTools, echoTool]),
            stream: new RecordingStream(),
            cwd: dir,
        });
        const outcome1 = await withTimeout(runAgent(config1), 10_000, "resume session 1");
        expect(outcome1.reason).toBe("completed");
        // Sanity: the transcript must have grown past the initial user turn —
        // at minimum: [user, assistant(tool_use), user(tool_result), assistant(text)].
        expect(outcome1.messages.length).toBeGreaterThanOrEqual(4);
        // Confirm the tool_use / tool_result pair survived into the transcript
        // before we even touch the disk. Stable shape: tool_use is in an
        // assistant message; tool_result is in a user message.
        const hasToolUse = outcome1.messages.some((m) => m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((c) => c.type === "tool_use"));
        const hasToolResult = outcome1.messages.some((m) => m.role === "user" &&
            Array.isArray(m.content) &&
            m.content.some((c) => c.type === "tool_result"));
        expect(hasToolUse).toBe(true);
        expect(hasToolResult).toBe(true);
        await saveSession(path, {
            sessionId: "resume-e2e",
            messages: outcome1.messages,
            reason: outcome1.reason,
            turns: outcome1.turns,
        });
        // ── Load + assert the on-disk shape is faithful.
        const loaded = await loadSession(path);
        expect(loaded).not.toBeNull();
        expect(loaded?.sessionId).toBe("resume-e2e");
        expect(loaded?.messages).toEqual(outcome1.messages);
        // ── Second session: feed the loaded transcript as the starting history
        // and run one more turn. The new ScriptedLLM gets to OBSERVE the prior
        // transcript via its `inputs` recorder — that's the real "resume" proof.
        const llm2 = new ScriptedLLM([ev(text("resumed and finished"))]);
        const config2 = cfg({
            llm: llm2,
            registry: new ToolRegistry([...defaultTools, echoTool]),
            stream: new RecordingStream(),
            cwd: dir,
            messages: loaded?.messages ?? [],
        });
        const outcome2 = await withTimeout(runAgent(config2), 10_000, "resume session 2");
        expect(outcome2.reason).toBe("completed");
        // The second LLM call MUST have received the prior transcript in its
        // input.messages — that's how "resume" actually composes.
        expect(llm2.inputs.length).toBeGreaterThanOrEqual(1);
        const firstInput = llm2.inputs[0];
        expect(firstInput).toBeDefined();
        if (firstInput) {
            const inputMessages = firstInput.messages;
            // The starting messages contain the previously-recorded tool_use/result
            // blocks — i.e. the resume is not just text echo, it's full content.
            const seenToolUse = inputMessages.some((m) => m.role === "assistant" &&
                Array.isArray(m.content) &&
                m.content.some((c) => c.type === "tool_use"));
            const seenToolResult = inputMessages.some((m) => m.role === "user" &&
                Array.isArray(m.content) &&
                m.content.some((c) => c.type === "tool_result"));
            expect(seenToolUse).toBe(true);
            expect(seenToolResult).toBe(true);
        }
        // Final transcript strictly extends the loaded one.
        expect(outcome2.messages.length).toBeGreaterThan(loaded?.messages.length ?? 0);
    }, 25_000);
    test("loadSession on missing file → null (resume gracefully degrades to fresh run)", async () => {
        const path = join(dir, "does-not-exist.json");
        const loaded = await loadSession(path);
        expect(loaded).toBeNull();
        // A fresh runAgent with the empty/loaded history starts from scratch and
        // still completes — proving the CLI's `loadSession ?? []` pattern is safe.
        const llm = new ScriptedLLM([ev(text("fresh start"))]);
        const config = cfg({
            llm,
            stream: new RecordingStream(),
            cwd: dir,
            messages: loaded?.messages ?? [],
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "resume-missing-file");
        expect(outcome.reason).toBe("completed");
    }, 15_000);
    test("loadSession on corrupt JSON → null; saveSession then writes fresh atomic", async () => {
        const path = join(dir, "corrupt.json");
        // Pre-seed corrupt content; loadSession must return null (never throw).
        await Bun.write(path, "{this is not json");
        const before = await loadSession(path);
        expect(before).toBeNull();
        // saveSession over corrupt file replaces it cleanly via the .tmp → rename
        // dance. A subsequent load returns the new transcript.
        await saveSession(path, {
            sessionId: "post-corrupt",
            messages: [{ role: "user", content: [{ type: "text", text: "after corrupt" }] }],
            reason: "completed",
            turns: 1,
        });
        const after = await loadSession(path);
        expect(after).not.toBeNull();
        expect(after?.sessionId).toBe("post-corrupt");
    }, 10_000);
});
