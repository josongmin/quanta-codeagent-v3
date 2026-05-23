/**
 * DockerSandbox × runAgent e2e — closes the runAgent integration half of the
 * L3 gap for the Docker sandbox (catalog row 3.4 / ADR-0006).
 *
 * Complement to `docker-sandbox-e2e.test.ts`, which covers the full
 * `policy → buildArgv → spawn → stdout/stderr/exit/timeout` pipeline against
 * a STUB bash binary. That file proves `Sandbox.run()` is wired correctly;
 * THIS file proves `Sandbox.run()` is wired correctly *through the agent
 * dispatch path* — i.e. a tool whose body calls `sandbox.run()` produces a
 * `tool_result` event that lets the loop continue.
 *
 * Why both files matter: a refactor that broke `tool_result` mapping for any
 * tool-with-side-effects (e.g. moved the result yield, swallowed an error
 * class) would pass `docker-sandbox-e2e.test.ts` (no agent loop) AND the
 * generic agent loop tests (no sandbox), but fail HERE. The composition
 * itself is the gap.
 *
 * Always-on path: a bogus `dockerBin` → `SandboxUnavailableError` from
 * `sandbox.run()`, the tool maps it to `ok:false`, the loop completes. No
 * Docker needed. The contract-gated docker round trip is intentionally NOT
 * duplicated here — `tests/contract/sandbox-docker.test.ts` already owns it
 * and `docker-sandbox-e2e.test.ts` proves the spawn pipeline.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "@/agent";
import { DockerSandbox, SandboxUnavailableError } from "@/runtime";
import { defaultTools, ToolRegistry } from "@/tool";
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness";
/** Adapter tool that opts a sandbox into the dispatch pipeline. Any tool that
 *  wraps `sandbox.run()` must (1) catch `SandboxUnavailableError` and surface
 *  ok:false, never re-throw — re-throwing would abort the turn; and (2) emit a
 *  single `{type:"result"}` yield. This tool is the structural contract. */
const sandboxShellTool = (sandbox) => ({
    name: "sandbox_shell",
    description: "Shell command run inside an isolated DockerSandbox.",
    inputSchema: z.object({ command: z.string() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input) {
        const { command } = input;
        try {
            const res = await sandbox.run(command, {
                cwdJail: process.cwd(),
                allowNetwork: false,
                timeoutMs: 30_000,
            });
            yield {
                type: "result",
                result: {
                    ok: res.exitCode === 0 && !res.timedOut,
                    output: res.stdout || res.stderr,
                },
            };
        }
        catch (e) {
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: e instanceof SandboxUnavailableError
                        ? `sandbox-unavailable: ${e.message}`
                        : `error: ${e.message}`,
                },
            };
        }
    },
});
let dir;
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "docker-sandbox-runagent-e2e-"));
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});
describe("DockerSandbox × runAgent — sandbox-backed tool dispatch round trip", () => {
    test("bogus dockerBin → SandboxUnavailableError mapped to ok:false through real runAgent", async () => {
        const fake = new DockerSandbox({ dockerBin: "definitely-not-docker-xyz" });
        const tool = sandboxShellTool(fake);
        const llm = new ScriptedLLM([
            ev(toolUse("s-1", "sandbox_shell", { command: "echo hi" })),
            ev(text("acknowledged unavailable")),
        ]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            registry: new ToolRegistry([...defaultTools, tool]),
            stream,
            cwd: dir,
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "sandbox-unavailable");
        expect(outcome.reason).toBe("completed");
        const result = stream.events.find((e) => e.type === "tool_result" && e.name === "sandbox_shell");
        expect(result).toBeDefined();
        if (result && result.type === "tool_result") {
            expect(result.ok).toBe(false);
            expect(result.preview).toContain("sandbox-unavailable");
        }
        // LLM was called twice — once for the tool_use, once for the recovery
        // text. If a future regression made the loop abort on tool-internal
        // exceptions, calls would be 1 and this assertion would fail.
        expect(llm.calls).toBe(2);
    }, 15_000);
    test("tool that throws an unrelated Error → mapped to ok:false (no loop abort)", async () => {
        // Defence-in-depth: not every failure inside a sandbox-backed tool is a
        // SandboxUnavailableError. The contract is "any exception inside execute
        // becomes ok:false"; we exercise that with a different error class.
        const tool = {
            name: "sandbox_shell",
            description: "throws to assert the result-mapping contract",
            inputSchema: z.object({}),
            isReadOnly: () => false,
            isConcurrencySafe: () => false,
            async *execute() {
                try {
                    throw new Error("some-other-failure");
                }
                catch (e) {
                    yield {
                        type: "result",
                        result: { ok: false, output: `error: ${e.message}` },
                    };
                }
            },
        };
        const llm = new ScriptedLLM([ev(toolUse("s-2", "sandbox_shell", {})), ev(text("noted"))]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            registry: new ToolRegistry([...defaultTools, tool]),
            stream,
            cwd: dir,
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "sandbox-generic-error");
        expect(outcome.reason).toBe("completed");
        const result = stream.events.find((e) => e.type === "tool_result" && e.name === "sandbox_shell");
        expect(result).toBeDefined();
        if (result && result.type === "tool_result") {
            expect(result.ok).toBe(false);
            expect(result.preview).toContain("some-other-failure");
        }
    }, 15_000);
});
