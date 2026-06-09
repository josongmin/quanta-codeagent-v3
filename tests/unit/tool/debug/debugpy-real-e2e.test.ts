/**
 * W5 DAP — EXHAUSTIVE real-debugpy end-to-end battery (no fakes). Each test
 * spawns an ACTUAL `python3 -m debugpy.adapter` and debugs a real program,
 * covering the hard cases: deep stacks, multibyte locals (byte-accurate codec
 * vs the real chatty event stream), never-hit breakpoints, failed evaluate,
 * stopOnEntry, complex data, program args, abort-mid-run, multiple breakpoints,
 * spawn faults, missing program.
 *
 * Verified 2026-06-10 with debugpy 1.8.21. AUTO-SKIPS when python3+debugpy are
 * absent so CI without the toolchain stays green. This battery caught the
 * launch-sequencing deadlock + the presentation-pseudo-var noise the fakes hid.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeDebugInspectTool } from "@/tool/debug/tool"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const hasDebugpy = (): boolean => {
  try {
    return Bun.spawnSync(["python3", "-c", "import debugpy"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const D = hasDebugpy() ? describe : describe.skip

/** Write a program to a fresh temp dir, run debug_inspect, return the result. */
const debugProgram = async (
  src: string,
  opts: {
    line?: number
    lines?: number[]
    evaluate?: string
    stopOnEntry?: boolean
    args?: string[]
    program?: string // override (for missing-file test)
    adapterCommand?: string[]
    signal?: AbortSignal
  } = {},
): Promise<ToolResult> => {
  const dir = mkdtempSync(join(tmpdir(), "dap-"))
  const prog = join(dir, "prog.py")
  writeFileSync(prog, src)
  const target = opts.program ?? prog
  const bpLines = opts.lines ?? (opts.line !== undefined ? [opts.line] : [])
  const tool = makeDebugInspectTool()
  const ctx = { cwd: dir, signal: opts.signal ?? new AbortController().signal } as ToolContext
  const input: Record<string, unknown> = {
    program: target,
    breakpoints: bpLines.map((line) => ({ file: target, line })),
    ...(opts.adapterCommand ? { adapterCommand: opts.adapterCommand } : { adapter: "python" }),
    ...(opts.evaluate !== undefined ? { evaluate: opts.evaluate } : {}),
    ...(opts.stopOnEntry !== undefined ? { stopOnEntry: opts.stopOnEntry } : {}),
    ...(opts.args !== undefined ? { args: opts.args } : {}),
  }
  let r: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx) as AsyncIterable<ToolEvent>)
    if (ev.type === "result") r = ev.result
  if (r === undefined) throw new Error("no result")
  return r
}

D("debug_inspect — REAL debugpy e2e battery", () => {
  test("basic: stop + locals + evaluated expr", async () => {
    const r = await debugProgram(
      ["def f(n):", "    total = sum(range(n))", "    return total  # line 3", "print(f(5))"].join("\n"),
      { line: 3, evaluate: "total + 100" },
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Stopped (breakpoint)")
    expect(r.output).toContain("total = 10")
    expect(r.output).toContain("n = 5")
    expect(r.output).toContain("⇒ 110")
  }, 30_000)

  test("multibyte/unicode locals are byte-accurate through the real chunked stream", async () => {
    const r = await debugProgram(
      ['msg = "안녕 세계 🌍 テスト"', 'd = {"한국": 1, "日本": 2}', "z = 0  # line 3", "print(msg)"].join("\n"),
      { line: 3 },
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("msg = '안녕 세계 🌍 テスト'")
    expect(r.output).toContain("d = {'한국': 1, '日本': 2}")
  }, 30_000)

  test("deep nested call stack assembles in order (top frame locals only)", async () => {
    const r = await debugProgram(
      ["def a(n): return b(n)", "def b(n): return c(n)", "def c(n):", "    r = n * 2  # line 4", "    return r", "print(a(21))"].join("\n"),
      { line: 4 },
    )
    expect(r.ok).toBe(true)
    const stackBlock = r.output ?? ""
    // c → b → a → <module>, in that order.
    const idxC = stackBlock.indexOf("c (")
    const idxB = stackBlock.indexOf("b (")
    const idxA = stackBlock.indexOf("a (")
    const idxM = stackBlock.indexOf("<module> (")
    expect(idxC).toBeGreaterThan(-1)
    expect(idxC).toBeLessThan(idxB)
    expect(idxB).toBeLessThan(idxA)
    expect(idxA).toBeLessThan(idxM)
    expect(r.output).toContain("n = 21")
  }, 30_000)

  test("pseudo-variable noise ('special variables') is filtered out", async () => {
    const r = await debugProgram(["x = 1", "y = 2  # line 2", "print(x)"].join("\n"), { line: 2 })
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain("special variables")
    expect(r.output).not.toContain("function variables")
    expect(r.output).toContain("x = 1")
  }, 30_000)

  test("complex data structures (nested dict/list) render", async () => {
    const r = await debugProgram(
      ["data = {'items': [1, 2, {'k': 'v'}], 'n': 3}", "stop = True  # line 2", "print(data)"].join("\n"),
      { line: 2 },
    )
    expect(r.ok).toBe(true)
    // debugpy abbreviates the deepest nesting level to {...} in its repr — still
    // proves nested structure assembly through the real adapter.
    expect(r.output).toContain("data = {'items': [1, 2, {...}], 'n': 3}")
  }, 30_000)

  test("never-executed breakpoint (uncalled fn) ⇒ exited, not a hang", async () => {
    const r = await debugProgram(
      ["def never():", "    secret = 1  # line 2 (never runs)", "    return secret", "print('done')"].join("\n"),
      { line: 2 },
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("ran to completion")
  }, 30_000)

  test("failed evaluate ⇒ still ok, omits the Evaluated line", async () => {
    const r = await debugProgram(["a = 1  # line 1", "print(a)"].join("\n"), {
      line: 1,
      evaluate: "this_name_does_not_exist + 1",
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Stopped (breakpoint)")
    expect(r.output).not.toContain("Evaluated")
  }, 30_000)

  test("stopOnEntry stops before the first real line", async () => {
    const r = await debugProgram(["print('first')", "print('second')"].join("\n"), {
      lines: [],
      stopOnEntry: true,
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Stopped")
  }, 30_000)

  test("program receives args (sys.argv)", async () => {
    const r = await debugProgram(
      ["import sys", "argv = sys.argv", "marker = 1  # line 3 (argv now bound)", "print(argv)"].join("\n"),
      { line: 3, args: ["hello", "42"] },
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("hello")
    expect(r.output).toContain("42")
  }, 30_000)

  test("multiple breakpoints ⇒ stops at the first one reached", async () => {
    const r = await debugProgram(
      ["a = 1  # line 1", "b = 2  # line 2", "c = 3  # line 3", "print(a + b + c)"].join("\n"),
      { lines: [2, 3] },
    )
    expect(r.ok).toBe(true)
    // First reached is line 2 (a already defined, c not yet).
    expect(r.output).toContain("prog.py:2")
    expect(r.output).toContain("a = 1")
    expect(r.output).not.toContain("c = 3")
  }, 30_000)

  test("ABORT mid-run (long sleep) ⇒ prompt error, no 30s hang", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 1500)
    const start = Bun.nanoseconds()
    const r = await debugProgram(
      ["import time", "time.sleep(30)", "print('done')  # line 3"].join("\n"),
      { line: 3, signal: ac.signal },
    )
    const elapsedMs = (Bun.nanoseconds() - start) / 1e6
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("abort")
    expect(elapsedMs).toBeLessThan(15_000) // aborted, did NOT wait out the 30s sleep
  }, 30_000)

  test("spawn fault (nonexistent adapter binary) ⇒ ok:false, never throws", async () => {
    const r = await debugProgram(["x = 1", "print(x)"].join("\n"), {
      line: 1,
      adapterCommand: ["this_adapter_binary_does_not_exist_zzz"],
    })
    expect(r.ok).toBe(false)
  }, 30_000)

  test("missing program file ⇒ resolves (exited), never hangs", async () => {
    const r = await debugProgram("unused = 1\n", { line: 1, program: "/tmp/nonexistent-prog-zzz.py" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("ran to completion")
  }, 30_000)
})
