/**
 * E2E — Cursor `preToolUse.updated_input` parity, validated THROUGH the real
 * runAgent loop (not just the dispatch unit seam).
 *
 * Existing unit coverage:
 *   - `tests/unit/hooks-updated-input.test.ts` — HookBus.emit composition
 *   - `tests/unit/agent/hook-updated-input.test.ts` — dispatchTool seam
 *
 * The unverified surface this suite closes: a `pre_tool_use` hook registered on
 * the `AgentConfig.hooks` channel rewrites the SHELL COMMAND a `bash` tool
 * call executes, end-to-end:
 *   1. ScriptedLLM emits a `tool_use` for `bash {command:"ls -la"}`.
 *   2. A registered HookBus handler returns `{updatedInput:{command:"ls"}}`.
 *   3. The loop's dispatch threads the rewrite into the bash tool's execute.
 *   4. The recorded shell run's argv (captured via a stub `runShell` is NOT
 *      used — we use a registry-level capture tool that conforms to the same
 *      `extractShellCommand` contract bash exposes) shows "ls", not "ls -la".
 *   5. The tool_result preview reflects the executed (rewritten) command.
 *
 * The 4-case matrix mirrors the dispatch unit but at the loop level:
 *   (a) no hook              ⇒ original command executes (byte-identical)
 *   (b) hook rewrites command ⇒ rewritten command executes
 *   (c) hook denies          ⇒ no execute; loop completes with a deny preview
 *   (d) hook rewrites then a later hook denies ⇒ deny wins, no execute
 *
 * Why a custom shell-shape tool instead of the real `bashTool`: bash actually
 * shells out via `runShell` and would invoke a subprocess. We want a HERMETIC
 * e2e — the test asserts the AGENT WIRING, not the OS shell. The stub tool
 * implements `extractShellCommand` (so it travels the SAME admissibility-gate
 * path the real bash tool does) and reflects the input it actually received,
 * so we can assert WHICH command reached execute.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { HookBus, runAgent } from "@/agent"
import type { AgentEvent } from "@/stream"
import { defaultTools, type Tool, ToolRegistry } from "@/tool"
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

/** Shell-shape tool: same `extractShellCommand` contract as bashTool, but
 *  execute is a pure reflector (no subprocess). The `seen` ref records the
 *  command string the tool ACTUALLY ran with — the post-rewrite shape if a
 *  hook fired, the original shape if not. */
const captureShell = (seen: { commands: string[] }): Tool => ({
  name: "bash",
  description: "shell-shape stub tool for hook-rewrite e2e",
  inputSchema: z.object({ command: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  extractShellCommand: (input: unknown): string => (input as { command: string }).command,
  async *execute(input: unknown) {
    const cmd = (input as { command: string }).command
    seen.commands.push(cmd)
    yield { type: "result", result: { ok: true, output: `ran:${cmd}` } }
  },
})

describe("hook updated_input rewrite — runAgent e2e (bash shape)", () => {
  test("(a) no hook ⇒ original command executes (byte-identical default path)", async () => {
    const seen = { commands: [] as string[] }
    const llm = new ScriptedLLM([
      ev(toolUse("c-1", "bash", { command: "ls -la" })),
      ev(text("done")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry([
        ...defaultTools.filter((t) => t.name !== "bash"),
        captureShell(seen),
      ]),
      stream,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "rewrite:none")
    expect(outcome.reason).toBe("completed")
    // executed verbatim
    expect(seen.commands).toEqual(["ls -la"])
    const result = stream.events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.name === "bash",
    )
    expect(result?.ok).toBe(true)
    expect(result?.preview).toBe("ran:ls -la")
  }, 15_000)

  test("(b) hook rewrites command 'ls -la'→'ls' ⇒ execute sees rewritten command", async () => {
    const seen = { commands: [] as string[] }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", (e) => {
      // Sanity: the hook OBSERVES the original command before rewriting.
      expect((e.input as { command: string }).command).toBe("ls -la")
      return { updatedInput: { command: "ls" } }
    })
    const llm = new ScriptedLLM([
      ev(toolUse("c-2", "bash", { command: "ls -la" })),
      ev(text("done")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry([
        ...defaultTools.filter((t) => t.name !== "bash"),
        captureShell(seen),
      ]),
      stream,
      hooks,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "rewrite:simple")
    expect(outcome.reason).toBe("completed")
    // CRITICAL: tool executed the REWRITTEN command, not the original.
    expect(seen.commands).toEqual(["ls"])
    const result = stream.events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.name === "bash",
    )
    expect(result?.ok).toBe(true)
    expect(result?.preview).toBe("ran:ls")
  }, 15_000)

  test("(c) hook denies ⇒ no execute; loop completes with deny preview", async () => {
    const seen = { commands: [] as string[] }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "policy refusal" }))
    const llm = new ScriptedLLM([
      ev(toolUse("c-3", "bash", { command: "ls -la" })),
      ev(text("done")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry([
        ...defaultTools.filter((t) => t.name !== "bash"),
        captureShell(seen),
      ]),
      stream,
      hooks,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "rewrite:deny")
    expect(outcome.reason).toBe("completed")
    // tool never reached execute
    expect(seen.commands).toEqual([])
    const result = stream.events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.name === "bash",
    )
    expect(result?.ok).toBe(false)
    expect(result?.preview).toBe("hook-denied")
  }, 15_000)

  test("(d) handler-1 rewrites, handler-2 denies ⇒ deny wins; tool never runs", async () => {
    const seen = { commands: [] as string[] }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { command: "ls" } }))
    hooks.on("pre_tool_use", () => ({ deny: "later-deny" }))
    const llm = new ScriptedLLM([
      ev(toolUse("c-4", "bash", { command: "ls -la" })),
      ev(text("done")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry([
        ...defaultTools.filter((t) => t.name !== "bash"),
        captureShell(seen),
      ]),
      stream,
      hooks,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "rewrite:rewrite-then-deny")
    expect(outcome.reason).toBe("completed")
    // deny > rewrite: the rewrite was COMPUTED but execute never happened.
    expect(seen.commands).toEqual([])
    const result = stream.events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.name === "bash",
    )
    expect(result?.ok).toBe(false)
    expect(result?.preview).toBe("hook-denied")
  }, 15_000)
})
