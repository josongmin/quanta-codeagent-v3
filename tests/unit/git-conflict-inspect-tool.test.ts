/**
 * ★ HELLGATE — `git_conflict_inspect` (ADR-0111 wiring): surface the pure
 * conflict parser as a typed first-class git Tool.
 *
 * The parser itself is sealed by `tests/unit/git/conflict-parser.test.ts`
 * (31 cases); THIS battery seals the SHELL the tool wraps it in — explicit-path
 * validation, auto-discovery via `git status --porcelain=v1`, per-file
 * read-and-parse, length-cap, error containment, signal forwarding.
 *
 * Hellgate cases (mirror the build prompt):
 *
 *   1. Explicit paths happy — one file with a two-way conflict → parsed.
 *   2. Auto-discover via git status — runner returns `UU foo.ts` → file inspected.
 *   3. Auto-discover, no conflicts → ok:true "(no conflicts)".
 *   4. Explicit clean file → 0 conflict block(s).
 *   5. Three-way + trailing unterminated → first block three-way, second
 *      diagnostic listed.
 *   6. `maxFiles` cap — 10 conflicts, cap=3 → message + only 3 read.
 *   7. One file missing on disk + one present → present file inspected,
 *      missing surfaces per-file error, overall ok:true.
 *   8. Absolute path → ok:false; runner NOT called.
 *   9. `..` traversal → ok:false; runner NOT called.
 *  10. Spawn error on git status → ok:false.
 *  11. git status non-zero exit → ok:false carrying stderr.
 *  12. Signal forwarding to runner.
 *  13. Length-8 markers + CRLF → tool delegates to the hardened parser
 *      (proves the tool is NOT reimplementing scan logic).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitConflictInspectTool } from "@/tool/git/conflict-inspect"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  args: string[]
  cwd: string
  signal: AbortSignal | undefined
}

class FakeRunner implements GitRunner {
  readonly calls: RecordedCall[] = []
  constructor(
    private readonly result: GitRunResult | ((args: readonly string[]) => GitRunResult),
  ) {}
  async run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult> {
    this.calls.push({ args: [...args], cwd, signal })
    return typeof this.result === "function" ? this.result(args) : this.result
  }
}

class ThrowingRunner implements GitRunner {
  async run(): Promise<GitRunResult> {
    throw new Error("spawn ENOENT")
  }
}

/** A runner that fails the test if it is ever invoked (used to assert
 *  pre-shell rejection paths NEVER reach git). */
class ForbiddenRunner implements GitRunner {
  async run(): Promise<GitRunResult> {
    throw new Error("forbidden: runner.run must NOT have been called")
  }
}

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (
  tool: ExecutableTool,
  input: unknown,
  ctx: ToolContext,
): Promise<{ result: ToolResult; progress: string[] }> => {
  const progress: string[] = []
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "progress") progress.push(ev.message)
    else result = ev.result
  }
  if (!result) throw new Error("no result emitted")
  return { result, progress }
}

const ok = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const err = (stderr: string, exitCode = 128): GitRunResult => ({
  stdout: "",
  stderr,
  exitCode,
})

// Helpers to build conflict file content.
const twoWay = (oursLabel = "HEAD", theirsLabel = "feature"): string =>
  `<<<<<<< ${oursLabel}\nO\n=======\nT\n>>>>>>> ${theirsLabel}\n`

const threeWay = (): string =>
  "<<<<<<< HEAD\n" + "O\n" + "||||||| anc\n" + "B\n" + "=======\n" + "T\n" + ">>>>>>> feature\n"

// ─────────────────────────────────────────────────────────────────────────────
// Tmpdir + file fixture setup
// ─────────────────────────────────────────────────────────────────────────────

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "conflict-inspect-"))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const ctxIn = (signal?: AbortSignal): ToolContext => ({
  cwd,
  signal: signal ?? new AbortController().signal,
})

const writeFile = (rel: string, content: string): void => {
  writeFileSync(join(cwd, rel), content, "utf8")
}

// ─────────────────────────────────────────────────────────────────────────────
// Hellgate cases
// ─────────────────────────────────────────────────────────────────────────────

describe("git_conflict_inspect tool hellgate", () => {
  test("1: explicit paths happy — single two-way conflict parsed", async () => {
    writeFile("foo.ts", twoWay())
    const runner = new ForbiddenRunner() // explicit paths ⇒ no git status
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, { paths: ["foo.ts"] }, ctxIn())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("foo.ts: 1 conflict block(s)")
    expect(result.output).toContain("two-way")
    expect(result.output).toContain("(ours=HEAD, theirs=feature)")
  })

  test("2: auto-discover via git status — UU foo.ts → file inspected", async () => {
    writeFile("foo.ts", twoWay())
    const runner = new FakeRunner(ok("UU foo.ts\n"))
    const tool = gitConflictInspectTool(runner)
    const { result, progress } = await collect(tool, {}, ctxIn())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("foo.ts: 1 conflict block(s)")
    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0]?.args).toEqual(["status", "--porcelain=v1"])
    expect(progress.some((p) => p.includes("git status"))).toBe(true)
  })

  test("3: auto-discover, no conflicts → (no conflicts)", async () => {
    const runner = new FakeRunner(ok(" M src/foo.ts\n?? new.ts\n"))
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, {}, ctxIn())
    expect(result.ok).toBe(true)
    expect(result.output).toBe("(no conflicts)")
  })

  test("4: explicit clean file → 0 conflict block(s)", async () => {
    writeFile("clean.ts", "no conflicts here\njust prose\n")
    const runner = new ForbiddenRunner()
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, { paths: ["clean.ts"] }, ctxIn())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("clean.ts: 0 conflict block(s)")
  })

  test("5: three-way + trailing unterminated → block three-way + diagnostic listed", async () => {
    const content = `${threeWay()}<<<<<<< HEAD2\nopen\nbut never closed\n`
    writeFile("mix.ts", content)
    const runner = new ForbiddenRunner()
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, { paths: ["mix.ts"] }, ctxIn())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("three-way")
    expect(result.output).toContain("unterminated")
  })

  test("6: maxFiles cap — 10 conflicts, cap=3 → message + only 3 read", async () => {
    // Discover 10 UU files; cap to 3.
    const porcelain = `${Array.from({ length: 10 }, (_, i) => `UU f${i}.ts`).join("\n")}\n`
    for (let i = 0; i < 10; i += 1) writeFile(`f${i}.ts`, twoWay())
    const runner = new FakeRunner(ok(porcelain))
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, { maxFiles: 3 }, ctxIn())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("Found 10 conflicts; inspecting first 3")
    // Only files 0/1/2 are referenced — files 3..9 should NOT appear.
    expect(result.output).toContain("f0.ts: 1 conflict block(s)")
    expect(result.output).toContain("f2.ts: 1 conflict block(s)")
    expect(result.output).not.toContain("f5.ts")
    expect(result.output).not.toContain("f9.ts")
  })

  test("7: one missing on disk + one present — present parsed, missing surfaces per-file error, ok:true overall", async () => {
    writeFile("present.ts", twoWay())
    const runner = new ForbiddenRunner()
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, { paths: ["present.ts", "missing.ts"] }, ctxIn())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("present.ts: 1 conflict block(s)")
    expect(result.output).toContain("missing.ts: read error")
  })

  test("8: absolute path → ok:false; runner NOT called", async () => {
    const runner = new ForbiddenRunner()
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, { paths: ["/etc/passwd"] }, ctxIn())
    expect(result.ok).toBe(false)
    expect(result.output).toContain("absolute path rejected")
    expect(result.output).toContain("/etc/passwd")
    // ForbiddenRunner throws if invoked — its absence of throw IS the assertion.
  })

  test("9: '..' traversal → ok:false; runner NOT called", async () => {
    const runner = new ForbiddenRunner()
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, { paths: ["foo/../../etc/passwd"] }, ctxIn())
    expect(result.ok).toBe(false)
    expect(result.output).toContain("path traversal rejected")
  })

  test("10: spawn error on git status → ok:false", async () => {
    const runner = new ThrowingRunner()
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, {}, ctxIn())
    expect(result.ok).toBe(false)
    expect(result.output).toContain("git status failed")
    expect(result.output).toContain("spawn ENOENT")
  })

  test("11: git status non-zero exit → ok:false carrying stderr", async () => {
    const runner = new FakeRunner(err("fatal: not a git repository", 128))
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, {}, ctxIn())
    expect(result.ok).toBe(false)
    expect(result.output).toContain("not a git repository")
  })

  test("12: signal forwarding to runner — exact ctx.signal passed through", async () => {
    const runner = new FakeRunner(ok(""))
    const tool = gitConflictInspectTool(runner)
    const ctrl = new AbortController()
    await collect(tool, {}, ctxIn(ctrl.signal))
    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0]?.signal).toBe(ctrl.signal)
  })

  test("13: length-8 markers + CRLF → tool delegates to the hardened parser", async () => {
    // The parser supports length-8 markers (B7) and CRLF mix (C10/C11). This
    // case proves the tool doesn't have a parallel marker scanner.
    const content = "<<<<<<<< HEAD\r\nO\r\n========\r\nT\r\n>>>>>>>> b\r\n"
    writeFile("crlf.ts", content)
    const runner = new ForbiddenRunner()
    const tool = gitConflictInspectTool(runner)
    const { result } = await collect(tool, { paths: ["crlf.ts"] }, ctxIn())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("crlf.ts: 1 conflict block(s)")
    expect(result.output).toContain("two-way")
    expect(result.output).toContain("(ours=HEAD, theirs=b)")
  })
})
