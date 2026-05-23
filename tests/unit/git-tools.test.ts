import { describe, expect, test } from "bun:test"
import { gitBlameTool, gitDiffTool, gitLogTool, gitStatusTool } from "@/tool/git"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
})

class FakeRunner implements GitRunner {
  readonly calls: { args: string[]; cwd: string }[] = []
  constructor(
    private readonly result: GitRunResult | ((args: readonly string[]) => GitRunResult),
  ) {}
  async run(args: readonly string[], cwd: string): Promise<GitRunResult> {
    this.calls.push({ args: [...args], cwd })
    const r = typeof this.result === "function" ? this.result(args) : this.result
    return r
  }
}

class ThrowingRunner implements GitRunner {
  async run(): Promise<GitRunResult> {
    throw new Error("spawn ENOENT")
  }
}

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (
  tool: ExecutableTool,
  input: unknown,
): Promise<{ result: ToolResult; progress: string[] }> => {
  const progress: string[] = []
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx())) {
    if (ev.type === "progress") progress.push(ev.message)
    else result = ev.result
  }
  if (!result) throw new Error("no result")
  return { result, progress }
}

const okResult = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const errResult = (stderr: string, exitCode = 128): GitRunResult => ({
  stdout: "",
  stderr,
  exitCode,
})

// ============================================================================
// git_diff
// ============================================================================

describe("gitDiffTool", () => {
  test("metadata: read-only, concurrency-safe", () => {
    const t = gitDiffTool(new FakeRunner(okResult("")))
    expect(t.name).toBe("git_diff")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({})).toBe(true)
    expect(t.description).toMatch(/diff/i)
  })

  test("golden: working tree diff (exit 0, has content)", async () => {
    const diffOut =
      "diff --git a/foo.ts b/foo.ts\nindex abc..def 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n"
    const runner = new FakeRunner(okResult(diffOut))
    const t = gitDiffTool(runner)
    const { result } = await collect(t, {})
    expect(result.ok).toBe(true)
    expect(result.output).toContain("diff --git a/foo.ts")
    expect(runner.calls[0]?.args).toEqual(["diff"])
  })

  test("exit 1 with diff output is OK (diff exits 1 when differences exist)", async () => {
    const runner = new FakeRunner({
      stdout: "diff --git a/x b/x\n+added\n",
      stderr: "",
      exitCode: 1,
    })
    const { result } = await collect(gitDiffTool(runner), {})
    expect(result.ok).toBe(true)
    expect(result.output).toContain("+added")
  })

  test("empty diff (exit 0, no output)", async () => {
    const { result } = await collect(gitDiffTool(new FakeRunner(okResult(""))), {})
    expect(result.ok).toBe(true)
    expect(result.output).toContain("no diff")
  })

  test("staged + base + paths build the correct argv", async () => {
    const runner = new FakeRunner(okResult(""))
    await collect(gitDiffTool(runner), {
      staged: true,
      base: "HEAD~1",
      paths: ["a.ts", "b.ts"],
    })
    expect(runner.calls[0]?.args).toEqual(["diff", "--staged", "HEAD~1", "--", "a.ts", "b.ts"])
  })

  test("not a git repository → ok:false with stderr", async () => {
    const runner = new FakeRunner(
      errResult("fatal: not a git repository (or any of the parent directories): .git"),
    )
    const { result } = await collect(gitDiffTool(runner), {})
    expect(result.ok).toBe(false)
    expect(result.output).toContain("not a git repository")
  })

  test("exit 2 with stderr → ok:false", async () => {
    const runner = new FakeRunner({ stdout: "", stderr: "fatal: bad object xyz", exitCode: 128 })
    const { result } = await collect(gitDiffTool(runner), { base: "xyz" })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("bad object")
  })

  test("runner spawn failure → ok:false with the error message", async () => {
    const { result } = await collect(gitDiffTool(new ThrowingRunner()), {})
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/spawn|ENOENT/i)
  })

  test("very large diff is truncated to 50_000 chars with marker", async () => {
    const huge = "x".repeat(60_000)
    const { result } = await collect(gitDiffTool(new FakeRunner(okResult(huge))), {})
    expect(result.ok).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(50_000 + 200)
    expect(result.output).toMatch(/truncated/i)
  })

  test("schema rejects non-array paths", () => {
    const t = gitDiffTool(new FakeRunner(okResult("")))
    expect(t.inputSchema.safeParse({ paths: "a.ts" }).success).toBe(false)
  })

  // SECURITY: a leading-dash `base` is a bare positional that git parses as an
  // OPTION (`--output=` is an arbitrary-file write; `--ext-diff` runs a command),
  // escaping the read-only contract. It must be rejected before reaching argv.
  test("leading-dash base is rejected (no option injection), runner never called", async () => {
    for (const base of ["--output=/tmp/pwn", "-G.", "--ext-diff"]) {
      const runner = new FakeRunner(okResult(""))
      const { result } = await collect(gitDiffTool(runner), { base })
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/must not begin with '-'/)
      // The dangerous argv must never have been handed to git.
      expect(runner.calls.length).toBe(0)
    }
  })

  test("a normal revision is still passed through verbatim", async () => {
    const runner = new FakeRunner(okResult(""))
    await collect(gitDiffTool(runner), { base: "HEAD~3" })
    expect(runner.calls[0]?.args).toEqual(["diff", "HEAD~3"])
  })
})

// ============================================================================
// git_status
// ============================================================================

describe("gitStatusTool", () => {
  test("metadata", () => {
    const t = gitStatusTool(new FakeRunner(okResult("")))
    expect(t.name).toBe("git_status")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({})).toBe(true)
  })

  test("argv: porcelain v2 + branch", async () => {
    const runner = new FakeRunner(okResult("# branch.head main\n"))
    await collect(gitStatusTool(runner), {})
    expect(runner.calls[0]?.args).toEqual(["status", "--porcelain=v2", "--branch"])
  })

  test("clean working tree", async () => {
    const out = "# branch.oid abc\n# branch.head main\n"
    const { result } = await collect(gitStatusTool(new FakeRunner(okResult(out))), {})
    expect(result.ok).toBe(true)
    expect(result.output).toContain("Branch: main")
    expect(result.output).toContain("working tree clean")
  })

  test("parses porcelain v2: branch + ahead/behind + modified/untracked", async () => {
    const out = [
      "# branch.oid abc",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -0",
      "1 M. N... 100644 100644 100644 a1 a2 src/foo.ts",
      "1 .M N... 100644 100644 100644 b1 b2 src/bar.ts",
      "? new.txt",
      "",
    ].join("\n")
    const { result } = await collect(gitStatusTool(new FakeRunner(okResult(out))), {})
    expect(result.ok).toBe(true)
    expect(result.output).toContain("Branch: main")
    expect(result.output).toContain("ahead 2")
    expect(result.output).toContain("src/foo.ts")
    expect(result.output).toContain("src/bar.ts")
    expect(result.output).toContain("new.txt")
    expect(result.output).toMatch(/modified/)
    expect(result.output).toMatch(/untracked/)
  })

  test("not a git repository → ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: not a git repository"))
    const { result } = await collect(gitStatusTool(runner), {})
    expect(result.ok).toBe(false)
    expect(result.output).toContain("not a git repository")
  })

  test("runner spawn failure → ok:false", async () => {
    const { result } = await collect(gitStatusTool(new ThrowingRunner()), {})
    expect(result.ok).toBe(false)
  })
})

// ============================================================================
// git_log
// ============================================================================

describe("gitLogTool", () => {
  test("metadata", () => {
    const t = gitLogTool(new FakeRunner(okResult("")))
    expect(t.name).toBe("git_log")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({})).toBe(true)
  })

  test("default argv uses n=10", async () => {
    const runner = new FakeRunner(okResult(""))
    await collect(gitLogTool(runner), {})
    // ADR-0105 (Codex §18.7): US-separator format + --no-textconv/--no-ext-diff
    // for deterministic machine-parseable output. See src/tool/git/log.ts.
    expect(runner.calls[0]?.args).toEqual([
      "log",
      "--no-textconv",
      "--no-ext-diff",
      "--format=%H%x1f%an%x1f%ai%x1f%s",
      "-n",
      "10",
    ])
  })

  test("respects n + adds --follow for file", async () => {
    const runner = new FakeRunner(okResult(""))
    await collect(gitLogTool(runner), { n: 3, file: "src/foo.ts" })
    expect(runner.calls[0]?.args).toEqual([
      "log",
      "--no-textconv",
      "--no-ext-diff",
      "--format=%H%x1f%an%x1f%ai%x1f%s",
      "-n",
      "3",
      "--follow",
      "--",
      "src/foo.ts",
    ])
  })

  test("formats commits as hash8 (author, date) subject", async () => {
    // ADR-0105: stdout fields delimited by US (0x1f) instead of TAB.
    const US = "\x1f"
    const stdout = [
      `0123456789abcdef0123456789abcdef01234567${US}Alice${US}2024-01-02 03:04:05 +0000${US}initial`,
      `fedcba9876543210fedcba9876543210fedcba98${US}Bob${US}2024-02-03 04:05:06 +0000${US}fix bug`,
      "",
    ].join("\n")
    const { result } = await collect(gitLogTool(new FakeRunner(okResult(stdout))), {})
    expect(result.ok).toBe(true)
    expect(result.output).toContain("01234567")
    expect(result.output).toContain("Alice")
    expect(result.output).toContain("2024-01-02")
    expect(result.output).toContain("initial")
    expect(result.output).toContain("fedcba98")
    expect(result.output).toContain("fix bug")
  })

  test("empty log → (no commits)", async () => {
    const { result } = await collect(gitLogTool(new FakeRunner(okResult(""))), {})
    expect(result.ok).toBe(true)
    expect(result.output).toContain("(no commits)")
  })

  test("not a git repository → ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: not a git repository"))
    const { result } = await collect(gitLogTool(runner), {})
    expect(result.ok).toBe(false)
    expect(result.output).toContain("not a git repository")
  })

  test("schema rejects n=0 and n>200", () => {
    const t = gitLogTool(new FakeRunner(okResult("")))
    expect(t.inputSchema.safeParse({ n: 0 }).success).toBe(false)
    expect(t.inputSchema.safeParse({ n: 201 }).success).toBe(false)
    expect(t.inputSchema.safeParse({ n: 10 }).success).toBe(true)
  })

  test("runner spawn failure → ok:false", async () => {
    const { result } = await collect(gitLogTool(new ThrowingRunner()), {})
    expect(result.ok).toBe(false)
  })
})

// ============================================================================
// git_blame
// ============================================================================

describe("gitBlameTool", () => {
  test("metadata", () => {
    const t = gitBlameTool(new FakeRunner(okResult("")))
    expect(t.name).toBe("git_blame")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({ file: "x.ts", line: 1 })).toBe(true)
  })

  test("argv: -L line,line --porcelain -- file", async () => {
    const runner = new FakeRunner(okResult(""))
    // Provide a passing porcelain so the parser doesn't reject; but we only inspect calls here.
    runner.calls.length = 0
    const t = gitBlameTool(runner)
    try {
      await collect(t, { file: "src/foo.ts", line: 5 })
    } catch {
      // ok, the parser may fail with empty stdout — argv is the assertion
    }
    expect(runner.calls[0]?.args).toEqual(["blame", "-L", "5,5", "--porcelain", "--", "src/foo.ts"])
  })

  test("parses porcelain output: hash + author + date + summary + content", async () => {
    const stdout = [
      "1234567890abcdef1234567890abcdef12345678 7 7 1",
      "author Alice Example",
      "author-mail <alice@example.com>",
      "author-time 1700000000",
      "author-tz +0000",
      "committer Bob",
      "committer-mail <bob@example.com>",
      "committer-time 1700000000",
      "committer-tz +0000",
      "summary fix the thing",
      "previous abcdef1234 src/foo.ts",
      "filename src/foo.ts",
      "\tconst x = 42",
      "",
    ].join("\n")
    const { result } = await collect(gitBlameTool(new FakeRunner(okResult(stdout))), {
      file: "src/foo.ts",
      line: 7,
    })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("src/foo.ts:7")
    expect(result.output).toContain("12345678")
    expect(result.output).toContain("Alice Example")
    expect(result.output).toMatch(/2023-\d{2}-\d{2}/) // 1700000000 → 2023
    expect(result.output).toContain("fix the thing")
    expect(result.output).toContain("const x = 42")
  })

  test("no such file → ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: no such path 'missing.ts' in HEAD"))
    const { result } = await collect(gitBlameTool(runner), { file: "missing.ts", line: 1 })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/no such/i)
  })

  test("line out of range → ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: file src/foo.ts has only 3 lines"))
    const { result } = await collect(gitBlameTool(runner), { file: "src/foo.ts", line: 999 })
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/only \d+ lines|out of range/i)
  })

  test("not a git repository → ok:false", async () => {
    const runner = new FakeRunner(errResult("fatal: not a git repository"))
    const { result } = await collect(gitBlameTool(runner), { file: "x.ts", line: 1 })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("not a git repository")
  })

  test("schema rejects missing line", () => {
    const t = gitBlameTool(new FakeRunner(okResult("")))
    expect(t.inputSchema.safeParse({ file: "x.ts" }).success).toBe(false)
    expect(t.inputSchema.safeParse({ file: "x.ts", line: 0 }).success).toBe(false)
    expect(t.inputSchema.safeParse({ file: "x.ts", line: -1 }).success).toBe(false)
    expect(t.inputSchema.safeParse({ line: 1 }).success).toBe(false)
  })

  test("runner spawn failure → ok:false", async () => {
    const { result } = await collect(gitBlameTool(new ThrowingRunner()), {
      file: "x.ts",
      line: 1,
    })
    expect(result.ok).toBe(false)
  })
})

// ============================================================================
// barrel + default runner
// ============================================================================

describe("git tools barrel", () => {
  test("default runner module exports run()", async () => {
    const { defaultGitRunner } = await import("@/tool/git")
    expect(typeof defaultGitRunner.run).toBe("function")
  })

  test("gitTools() with no arg returns all nine tools (7 read-only + 2 mutating)", async () => {
    const { gitTools } = await import("@/tool/git")
    const tools = gitTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      "git_blame",
      "git_blame_heatmap",
      "git_branch_switch",
      "git_churn",
      "git_commit",
      "git_diff",
      "git_log",
      "git_status",
      "git_upstream_check",
    ])
    // Read-only tools: 7 (diff/status/log/blame + churn/blame_heatmap fault-
    // localization signals + upstream_check divergence probe). Mutating tools:
    // 2 (git_commit, git_branch_switch).
    const readOnlyCount = tools.filter((t) => t.isReadOnly()).length
    expect(readOnlyCount).toBe(7)
    const mutatingCount = tools.filter((t) => !t.isReadOnly()).length
    expect(mutatingCount).toBe(2)
  })

  test("gitTools(runner) injects the runner across all nine", async () => {
    const { gitTools } = await import("@/tool/git")
    const runner = new FakeRunner(okResult(""))
    const tools = gitTools(runner)
    expect(tools).toHaveLength(9)
    // We can't introspect; just ensure each tool is callable and the runner observes a call.
    const statusTool = tools.find((x) => x.name === "git_status")
    if (!statusTool) throw new Error("git_status missing")
    await collect(statusTool, {})
    expect(runner.calls.length).toBeGreaterThan(0)
  })
})
