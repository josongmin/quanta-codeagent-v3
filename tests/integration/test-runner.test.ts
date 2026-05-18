import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRunnerTool } from "../../src/tool/test-runner"
import type { ToolEvent } from "../../src/tool/types"

const drive = async (
  input: { command?: string; path?: string; timeout_ms?: number },
  cwd: string,
): Promise<{ progress: string[]; output: string; ok: boolean }> => {
  const progress: string[] = []
  let output = ""
  let ok = false
  for await (const ev of testRunnerTool.execute(input, {
    cwd,
    signal: new AbortController().signal,
  }) as AsyncIterable<ToolEvent>) {
    if (ev.type === "progress") progress.push(ev.message)
    else {
      output = ev.result.output
      ok = ev.result.ok
    }
  }
  return { progress, output, ok }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "test-runner-"))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("testRunnerTool", () => {
  test("interface flags", () => {
    expect(testRunnerTool.isReadOnly()).toBe(false)
    expect(testRunnerTool.isConcurrencySafe({})).toBe(false)
  })

  test("explicit passing command → ok, verdict passed, exit 0", async () => {
    const { progress, output, ok } = await drive({ command: "bash -c 'exit 0'" }, tmpRoot)
    expect(ok).toBe(true)
    expect(progress).toContain("running: bash -c 'exit 0'")
    expect(output).toContain("[exit 0]")
    expect(output).toContain("verdict: passed")
  })

  test("explicit failing command → not ok, verdict failed, exit 1", async () => {
    const { output, ok } = await drive({ command: "bash -c 'echo boom; exit 1'" }, tmpRoot)
    expect(ok).toBe(false)
    expect(output).toContain("[exit 1]")
    expect(output).toContain("verdict: failed")
    expect(output).toContain("boom")
  })

  test("timeout case → timed out, not ok", async () => {
    const { output, ok } = await drive({ command: "sleep 2", timeout_ms: 100 }, tmpRoot)
    expect(ok).toBe(false)
    expect(output).toContain("[timed out]")
    expect(output).toContain("verdict: timed out")
  })

  test("no command and undetectable tree → helpful failure", async () => {
    const empty = mkdtempSync(join(tmpdir(), "test-runner-empty-"))
    try {
      const { ok, output } = await drive({}, empty)
      expect(ok).toBe(false)
      expect(output).toContain("could not auto-detect")
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
