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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
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
    breakpoints?: { line: number; condition?: string }[]
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
  const bps: { line: number; condition?: string }[] =
    opts.breakpoints ??
    (opts.lines ?? (opts.line !== undefined ? [opts.line] : [])).map((line) => ({ line }))
  const tool = makeDebugInspectTool()
  const ctx = { cwd: dir, signal: opts.signal ?? new AbortController().signal } as ToolContext
  const input: Record<string, unknown> = {
    program: target,
    breakpoints: bps.map((b) => ({ file: target, line: b.line, ...(b.condition ? { condition: b.condition } : {}) })),
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

/** Multi-file variant: write several files, debug `entry`, bp paths are relative
 *  to the temp dir (resolved to absolute). */
const debugMultiFile = async (
  files: Record<string, string>,
  entry: string,
  breakpoints: { file: string; line: number }[],
): Promise<ToolResult> => {
  const dir = mkdtempSync(join(tmpdir(), "dap-mf-"))
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src)
  const tool = makeDebugInspectTool()
  const ctx = { cwd: dir, signal: new AbortController().signal } as ToolContext
  const input = {
    program: join(dir, entry),
    adapter: "python",
    breakpoints: breakpoints.map((b) => ({ file: join(dir, b.file), line: b.line })),
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

  test("CONDITIONAL breakpoint only stops when the condition is truthy", async () => {
    const r = await debugProgram(
      ["def run():", "    found = -1", "    for i in range(10):", "        found = i  # line 4", "    return found", "print(run())"].join("\n"),
      { breakpoints: [{ line: 4, condition: "i == 3" }] },
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("i = 3") // stopped exactly at the conditional iteration
  }, 30_000)

  test("MULTI-FILE: breakpoint in an imported module ⇒ stack crosses files", async () => {
    const r = await debugMultiFile(
      {
        "helper.py": ["def helper(x):", "    y = x * 10  # line 2", "    return y"].join("\n"),
        "main.py": ["from helper import helper", "def go():", "    return helper(7)", "print(go())"].join("\n"),
      },
      "main.py",
      [{ file: "helper.py", line: 2 }],
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("helper.py:2")
    expect(r.output).toContain("main.py:3") // caller frame in the OTHER file
    expect(r.output).toContain("x = 7")
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

// ── SECOND LANGUAGE: C/C++ via lldb-dap (proves the tool is language-agnostic
//    over `adapterCommand`; surfaced the `terminate`-at-breakpoint hang debugpy
//    masked). Gated on lldb-dap + clang being present. ──────────────────────
const lldbDapPath = (): string | undefined => {
  try {
    const r = Bun.spawnSync(["xcrun", "-f", "lldb-dap"], { stdout: "pipe", stderr: "ignore" })
    if (r.exitCode === 0) {
      const p = r.stdout.toString().trim()
      if (p.length > 0) return p
    }
  } catch {
    /* not macOS / no xcrun */
  }
  try {
    if (Bun.spawnSync(["lldb-dap", "--help"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) return "lldb-dap"
  } catch {
    /* not on PATH */
  }
  return undefined
}
const hasClang = (): boolean => {
  try {
    return Bun.spawnSync(["clang", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const LLDB = lldbDapPath()
const DL = LLDB !== undefined && hasClang() ? describe : describe.skip

DL("debug_inspect — REAL lldb-dap e2e (C, second language)", () => {
  const compile = (src: string): { dir: string; bin: string; csrc: string } => {
    const dir = mkdtempSync(join(tmpdir(), "dap-c-"))
    const csrc = join(dir, "prog.c")
    const bin = join(dir, "prog")
    writeFileSync(csrc, src)
    const r = Bun.spawnSync(["clang", "-g", "-O0", "-o", bin, csrc], { stdout: "pipe", stderr: "pipe" })
    if (r.exitCode !== 0) throw new Error(`clang failed: ${r.stderr.toString()}`)
    return { dir, bin, csrc }
  }
  const runC = async (bin: string, csrc: string, cwd: string, bp: { line: number; condition?: string }, evaluate?: string): Promise<ToolResult> => {
    const tool = makeDebugInspectTool()
    const ctx = { cwd, signal: new AbortController().signal } as ToolContext
    const input = {
      program: bin,
      adapterCommand: [LLDB], // resolved lldb-dap (macOS Xcode path / PATH)
      breakpoints: [{ file: csrc, line: bp.line, ...(bp.condition ? { condition: bp.condition } : {}) }],
      ...(evaluate ? { evaluate } : {}),
    }
    let r: ToolResult | undefined
    for await (const ev of tool.execute(input as never, ctx) as AsyncIterable<ToolEvent>)
      if (ev.type === "result") r = ev.result
    if (r === undefined) throw new Error("no result")
    return r
  }

  test("C: stops at breakpoint, reports stack + locals + evaluated expr", async () => {
    const { dir, bin, csrc } = compile(
      ["#include <stdio.h>", "int add(int a, int b) {", "    int sum = a + b;  // line 3", "    return sum;", "}", "int main() {", "    int r = add(20, 22);", "    printf(\"%d\\n\", r);", "    return 0;", "}"].join("\n"),
    )
    const r = await runC(bin, csrc, dir, { line: 3 }, "a + b")
    expect(r.ok).toBe(true)
    expect(r.output).toContain("add (")
    expect(r.output).toContain("main (")
    expect(r.output).toContain("a = 20")
    expect(r.output).toContain("b = 22")
    expect(r.output).toContain("42") // evaluated a+b (lldb format: (int) $0 = 42)
  }, 40_000)

  test("C: conditional breakpoint in a loop stops at the matching iteration", async () => {
    const { dir, bin, csrc } = compile(
      ["#include <stdio.h>", "int main() {", "    int acc = 0;", "    for (int i = 0; i < 10; i++) {", "        acc += i;  // line 5", "    }", "    printf(\"%d\\n\", acc);", "    return 0;", "}"].join("\n"),
    )
    const r = await runC(bin, csrc, dir, { line: 5, condition: "i == 4" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("i = 4")
  }, 40_000)

  test("C: never-hit breakpoint ⇒ exited, no hang (terminate-at-bp robustness)", async () => {
    const { dir, bin, csrc } = compile(
      ["#include <stdio.h>", "int dead(void) { return 99; }  // line 2 (never called)", "int main() { printf(\"ok\\n\"); return 0; }"].join("\n"),
    )
    const r = await runC(bin, csrc, dir, { line: 2 })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("ran to completion")
  }, 40_000)
})

// ── THIRD LANGUAGE: Rust via lldb-dap (same adapter as C, just `cargo build`).
//    Proves Rust DAP and exercises the realpath source-path matching (rustc's
//    DWARF comp_dir uses the canonical path; on macOS /tmp → /private/tmp). ──
const hasCargo = (): boolean => {
  try {
    return Bun.spawnSync(["cargo", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const DR = LLDB !== undefined && hasCargo() ? describe : describe.skip

DR("debug_inspect — REAL Rust e2e via lldb-dap (third language)", () => {
  test("stops in a Rust fn, reports stack + locals (realpath source matching)", async () => {
    // realpath the dir so the breakpoint path matches rustc's DWARF comp_dir.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dap-rs-")))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "Cargo.toml"), ['[package]', 'name = "t"', 'version = "0.1.0"', 'edition = "2021"', "", "[[bin]]", 'name = "t"', 'path = "src/main.rs"'].join("\n"))
    const rs = join(dir, "src", "main.rs")
    writeFileSync(rs, ["fn compute(n: i32) -> i32 {", "    let mut total = 0;", "    for i in 0..n {", "        total += i;  // line 4", "    }", "    total", "}", "fn main() {", "    let r = compute(5);", '    println!("{}", r);', "}"].join("\n"))
    const build = Bun.spawnSync(["cargo", "build", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } })
    expect(build.exitCode).toBe(0)
    const bin = join(dir, "target", "debug", "t")
    const tool = makeDebugInspectTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as ToolContext
    let r: ToolResult | undefined
    for await (const ev of tool.execute(
      { program: bin, adapterCommand: [LLDB], breakpoints: [{ file: rs, line: 4 }], evaluate: "n" } as never,
      ctx,
    ) as AsyncIterable<ToolEvent>)
      if (ev.type === "result") r = ev.result
    expect(r?.ok).toBe(true)
    expect(r?.output).toContain("compute")
    expect(r?.output).toContain("n = 5")
    // SOTA++: the DAP `type` is surfaced inline (lldb types the ints).
    expect(r?.output).toContain("(int)")
    // SOTA++: nested aggregate expansion — the desugared `for` loop's Range
    // iterator (a struct local) reveals its `end` field as an expanded child.
    // `end` is NOT a top-level local, so its presence proves one expansion level
    // through a REAL lldb-dap (red-on-injection: drop expansion ⇒ no `end = 5`).
    expect(r?.output).toContain("end = 5")
  }, 90_000)
})

// ── FOURTH carrier: Node via CDP (node --inspect-brk), no DAP adapter. Proves
//    the `debug_inspect` tool's `adapter:"node"` path against a REAL node. ──
const hasNode = (): boolean => {
  try {
    return Bun.spawnSync(["node", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const DNODE = hasNode() ? describe : describe.skip

DNODE("debug_inspect — REAL Node e2e via CDP (node --inspect-brk)", () => {
  test("stops in a node program and reports the stack + local over CDP", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dap-node-")))
    const prog = join(dir, "x.mjs")
    writeFileSync(
      prog,
      ["function compute(n) {", "  let total = 0", "  for (let i = 0; i < n; i++) total += i", "  const result = total", "  return result // line 5", "}", "globalThis.__r = compute(5)", ""].join("\n"),
    )
    const tool = makeDebugInspectTool() // real ports (CDP carrier)
    const ctx = { cwd: dir, signal: new AbortController().signal } as ToolContext
    let r: ToolResult | undefined
    for await (const ev of tool.execute({ program: prog, adapter: "node", breakpoints: [{ file: prog, line: 5 }] } as never, ctx) as AsyncIterable<ToolEvent>)
      if (ev.type === "result") r = ev.result
    expect(r?.ok).toBe(true)
    expect(r?.output).toContain("Stopped")
    expect(r?.output).toContain("compute")
    expect(r?.output).toContain("result = 10") // 0+1+2+3+4
  }, 60_000)
})

DNODE("debug_inspect — REAL Node break-on-throw via CDP (T-01)", () => {
  test("exceptionBreakpoints stops at an UNCAUGHT throw and reports the type+message", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dap-node-exc-")))
    const prog = join(dir, "boom.mjs")
    // Uncaught TypeError thrown in user code — no line breakpoint needed.
    writeFileSync(prog, ["function go() {", "  const obj = null", "  return obj.missing() // throws TypeError", "}", "go()", ""].join("\n"))
    const tool = makeDebugInspectTool() // real CDP carrier
    const ctx = { cwd: dir, signal: new AbortController().signal } as ToolContext
    let r: ToolResult | undefined
    // Line bp on a NON-EXISTENT line (99) so it never binds/fires — the THROW is
    // the only stop, proving break-on-throw (not the line bp) caught it.
    for await (const ev of tool.execute({ program: prog, adapter: "node", breakpoints: [{ file: prog, line: 99 }], exceptionBreakpoints: true } as never, ctx) as AsyncIterable<ToolEvent>)
      if (ev.type === "result") r = ev.result
    expect(r?.ok).toBe(true)
    expect(r?.output).toContain("Stopped (exception)")
    expect(r?.output).toContain("⚠ Exception")
    expect(r?.output).toMatch(/TypeError/)
  }, 60_000)
})
