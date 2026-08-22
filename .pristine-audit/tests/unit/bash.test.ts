import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"

const dir = mkdtempSync(join(tmpdir(), "bash-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string, signal?: AbortSignal): ToolContext => ({
  cwd,
  signal: signal ?? new AbortController().signal,
})

const collect = async (
  input: unknown,
  c: ToolContext,
): Promise<{ result: ToolResult; events: ToolEvent[] }> => {
  const events: ToolEvent[] = []
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute(input as never, c)) {
    events.push(ev)
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return { result, events }
}

describe("bashTool", () => {
  test("metadata: not read-only, not concurrency-safe", () => {
    expect(bashTool.name).toBe("bash")
    expect(bashTool.isReadOnly()).toBe(false)
    expect(bashTool.isConcurrencySafe({ command: "ls" })).toBe(false)
  })

  test("captures stdout and exit 0", async () => {
    const { result, events } = await collect({ command: "echo hello" }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(result.output).toBe("[exit 0]\nhello")
    expect(result.evidence?.executedCommand).toBe("echo hello")
    expect(events[0]).toMatchObject({
      type: "progress",
      message: expect.stringMatching(/^running( \(bg-capable\))?: echo hello$/),
    })
  })

  test("true succeeds with no output", async () => {
    const { result } = await collect({ command: "true" }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(result.output).toBe("[exit 0]\n(no output)")
  })

  test("non-zero exit is reported, not thrown", async () => {
    const { result } = await collect({ command: "false" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.output).toBe("[exit 1]\n(no output)")
  })

  test("custom exit code is surfaced in the status header", async () => {
    const { result } = await collect({ command: "exit 7" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.output).toContain("[exit 7]")
  })

  test("stderr is combined into the output body", async () => {
    const { result } = await collect({ command: "echo oops 1>&2; false" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.output).toContain("oops")
  })

  test("runs in ctx.cwd", async () => {
    const { result } = await collect({ command: "pwd" }, ctx(dir))
    expect(result.ok).toBe(true)
    // macOS tmpdir may be symlinked (/var → /private/var); compare the tail.
    const tail = dir.split(sep).pop() as string
    expect(result.output).toContain(tail)
  })

  test("aborted signal kills the command and reports non-zero", async () => {
    const ac = new AbortController()
    // Abort once the child has actually spawned (runShell attaches the
    // abort listener after Bun.spawn), so the kill is delivered.
    const timer = setTimeout(() => ac.abort(), 100)
    const { result } = await collect({ command: "sleep 30" }, ctx(dir, ac.signal))
    clearTimeout(timer)
    expect(result.ok).toBe(false)
  }, 15000)

  test("timeout_ms aborts a long command and flags timed out", async () => {
    const { result } = await collect(
      { command: "sleep 5", timeout_ms: 50, timeout_behavior: "kill" },
      ctx(dir),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("[timed out]")
  })

  test("timeout → failure.mode timeout with timeoutMs (absorb #2)", async () => {
    const { result } = await collect(
      { command: "sleep 5", timeout_ms: 50, timeout_behavior: "kill" },
      ctx(dir),
    )
    expect(result.ok).toBe(false)
    expect(result.failure).toEqual({ mode: "timeout", timeoutMs: 50 })
  })

  test("command-not-found (exit 127) → failure.mode spawn_error (absorb #2)", async () => {
    const { result } = await collect(
      { command: "this_command_definitely_does_not_exist_xyz" },
      ctx(dir),
    )
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("spawn_error")
    if (result.failure?.mode === "spawn_error") {
      expect(result.failure.error.toLowerCase()).toContain("command not found")
    }
  })

  test("ordinary non-zero exit carries NO failure (byte-identical legacy)", async () => {
    const { result } = await collect({ command: "false" }, ctx(dir))
    expect(result.ok).toBe(false)
    expect(result.failure).toBeUndefined()
  })

  test("long command is previewed in the progress event", async () => {
    const cmd = `echo ${"x".repeat(200)}`
    const { events } = await collect({ command: cmd }, ctx(dir))
    const progress = events.find((e) => e.type === "progress")
    expect(progress).toBeDefined()
    if (progress?.type === "progress") expect(progress.message).toContain("…")
  })

  test("schema rejects missing command", () => {
    expect(bashTool.inputSchema.safeParse({}).success).toBe(false)
  })

  test("does NOT leak provider API keys into the shell child", async () => {
    process.env.OPENAI_API_KEY = "sk-fake-openai"
    process.env.ANTHROPIC_API_KEY = "sk-fake-anthropic"
    try {
      const { result } = await collect(
        { command: 'echo "K=[$OPENAI_API_KEY][$ANTHROPIC_API_KEY]"' },
        ctx(dir),
      )
      expect(result.ok).toBe(true)
      expect(result.output).toContain("K=[][]")
      expect(result.output).not.toContain("sk-fake")
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  test("PATH/HOME still present so ordinary commands work", async () => {
    const { result } = await collect({ command: 'echo "$HOME"' }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(result.output.replace("[exit 0]\n", "").trim().length).toBeGreaterThan(1)
  })
})
