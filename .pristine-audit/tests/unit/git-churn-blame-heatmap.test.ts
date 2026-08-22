import { describe, expect, test } from "bun:test"
import { gitBlameHeatmapTool, gitChurnTool, rankBlame, rankChurn } from "@/tool/git"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })

class FakeRunner implements GitRunner {
  readonly calls: { args: string[]; cwd: string }[] = []
  constructor(
    private readonly result: GitRunResult | ((args: readonly string[]) => GitRunResult),
  ) {}
  async run(args: readonly string[], cwd: string): Promise<GitRunResult> {
    this.calls.push({ args: [...args], cwd })
    return typeof this.result === "function" ? this.result(args) : this.result
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

const collect = async (tool: ExecutableTool, input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const ok = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })

// ============================================================================
// rankChurn — pure aggregation
// ============================================================================

describe("rankChurn (pure)", () => {
  test("counts file occurrences and ranks by frequency", () => {
    const stdout = ["a.ts", "b.ts", "", "a.ts", "c.ts", "", "a.ts", "b.ts"].join("\n")
    const ranked = rankChurn(stdout, 10)
    expect(ranked).toEqual([
      { file: "a.ts", count: 3 },
      { file: "b.ts", count: 2 },
      { file: "c.ts", count: 1 },
    ])
  })

  test("ties broken by path for determinism", () => {
    const stdout = ["z.ts", "a.ts", "z.ts", "a.ts"].join("\n")
    const ranked = rankChurn(stdout, 10)
    // both count 2; a.ts sorts before z.ts
    expect(ranked.map((r) => r.file)).toEqual(["a.ts", "z.ts"])
  })

  test("respects top-N cap", () => {
    const stdout = ["a", "b", "c", "d", "e"].join("\n")
    expect(rankChurn(stdout, 2)).toHaveLength(2)
  })

  test("empty / whitespace-only → []", () => {
    expect(rankChurn("", 10)).toEqual([])
    expect(rankChurn("\n\n  \n", 10)).toEqual([])
  })
})

// ============================================================================
// gitChurnTool
// ============================================================================

describe("gitChurnTool", () => {
  test("default window uses -n 200 (no --since)", async () => {
    const runner = new FakeRunner(ok("a.ts\nb.ts\na.ts\n"))
    const r = await collect(gitChurnTool(runner), {})
    expect(r.ok).toBe(true)
    expect(r.output).toContain("a.ts")
    const args = runner.calls[0]?.args ?? []
    expect(args).toContain("--name-only")
    expect(args).toContain("-n")
    expect(args).toContain("200")
    expect(args.some((a) => a.startsWith("--since="))).toBe(false)
  })

  test("since passed through as --since=<value>", async () => {
    const runner = new FakeRunner(ok("x.ts\n"))
    await collect(gitChurnTool(runner), { since: "30.days" })
    expect(runner.calls[0]?.args).toContain("--since=30.days")
  })

  test("path restricts via -- <path>", async () => {
    const runner = new FakeRunner(ok("src/x.ts\n"))
    await collect(gitChurnTool(runner), { path: "src" })
    const args = runner.calls[0]?.args ?? []
    expect(args).toContain("--")
    expect(args).toContain("src")
  })

  test("ranked output is count-padded `NNNN  file`", async () => {
    const runner = new FakeRunner(ok("a.ts\nb.ts\na.ts\n"))
    const r = await collect(gitChurnTool(runner), {})
    expect(r.output.split("\n")[0]).toMatch(/^\s+2\s+a\.ts$/)
  })

  test("empty churn → (no churn in window)", async () => {
    const r = await collect(gitChurnTool(new FakeRunner(ok(""))), {})
    expect(r.output).toBe("(no churn in window)")
  })

  test("non-zero exit → ok:false with stderr reason", async () => {
    const r = await collect(
      gitChurnTool(new FakeRunner({ stdout: "", stderr: "not a git repository", exitCode: 128 })),
      {},
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("not a git repository")
  })

  test("spawn error → ok:false (no throw out of execute)", async () => {
    const r = await collect(gitChurnTool(new ThrowingRunner()), {})
    expect(r.ok).toBe(false)
    expect(r.output).toContain("git churn failed")
  })
})

// ============================================================================
// rankBlame — pure aggregation
// ============================================================================

describe("rankBlame (pure)", () => {
  const porcelain = (authors: string[]): string =>
    authors
      .map(
        (a, i) =>
          `${"0".repeat(40)} ${i + 1} ${i + 1} 1\nauthor ${a}\nauthor-mail <x@y.z>\nauthor-time 1\n\tcode line ${i}`,
      )
      .join("\n")

  test("counts per-author lines + percentages", () => {
    const out = porcelain(["Jane", "Jane", "Bob", "Jane"])
    const ranked = rankBlame(out, 10)
    expect(ranked).toEqual([
      { author: "Jane", lines: 3, pct: 75 },
      { author: "Bob", lines: 1, pct: 25 },
    ])
  })

  test("ignores author-mail / author-time headers (only `author ` lines)", () => {
    // The porcelain has author-mail + author-time lines; they must NOT count.
    const out = porcelain(["Solo", "Solo"])
    const ranked = rankBlame(out, 10)
    expect(ranked).toEqual([{ author: "Solo", lines: 2, pct: 100 }])
  })

  test("ties broken by author name", () => {
    const out = porcelain(["Zed", "Amy"])
    const ranked = rankBlame(out, 10)
    expect(ranked.map((r) => r.author)).toEqual(["Amy", "Zed"]) // 1 each, Amy first
  })

  test("top-N cap", () => {
    const out = porcelain(["A", "B", "C", "D"])
    expect(rankBlame(out, 2)).toHaveLength(2)
  })

  test("no author headers → []", () => {
    expect(rankBlame("just some text\nno headers", 10)).toEqual([])
  })
})

// ============================================================================
// gitBlameHeatmapTool
// ============================================================================

describe("gitBlameHeatmapTool", () => {
  const porcelain = (authors: string[]): string =>
    authors.map((a) => `sha 1 1 1\nauthor ${a}\nauthor-time 1\n\tcode`).join("\n")

  test("uses --line-porcelain and -- <file>", async () => {
    const runner = new FakeRunner(ok(porcelain(["Jane"])))
    await collect(gitBlameHeatmapTool(runner), { file: "src/x.ts" })
    const args = runner.calls[0]?.args ?? []
    expect(args).toContain("--line-porcelain")
    expect(args).toContain("--")
    expect(args).toContain("src/x.ts")
    // No -L when no range given.
    expect(args).not.toContain("-L")
  })

  test("line range → git blame -L <start>,<end> (R-Phase8 #4)", async () => {
    const runner = new FakeRunner(ok(porcelain(["Jane"])))
    await collect(gitBlameHeatmapTool(runner), { file: "src/x.ts", start_line: 10, end_line: 40 })
    const args = runner.calls[0]?.args ?? []
    const li = args.indexOf("-L")
    expect(li).toBeGreaterThanOrEqual(0)
    expect(args[li + 1]).toBe("10,40")
  })

  test("start_line without end_line → invalid input (must be paired)", async () => {
    const r = await collect(gitBlameHeatmapTool(new FakeRunner(ok(""))), {
      file: "x.ts",
      start_line: 5,
    })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })

  test("end_line < start_line → invalid input", async () => {
    const r = await collect(gitBlameHeatmapTool(new FakeRunner(ok(""))), {
      file: "x.ts",
      start_line: 40,
      end_line: 10,
    })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })

  test("renders pct-padded ownership rows", async () => {
    const runner = new FakeRunner(ok(porcelain(["Jane", "Jane", "Bob"])))
    const r = await collect(gitBlameHeatmapTool(runner), { file: "x.ts" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Jane")
    expect(r.output).toMatch(/67%|66%/) // 2/3 rounds to 67
  })

  test("empty blame → ok:true with sentinel", async () => {
    const r = await collect(gitBlameHeatmapTool(new FakeRunner(ok(""))), { file: "x.ts" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("no blame data")
  })

  test("missing file arg → ok:false invalid input", async () => {
    const r = await collect(gitBlameHeatmapTool(new FakeRunner(ok(""))), {})
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })

  test("non-zero exit → ok:false stderr reason", async () => {
    const r = await collect(
      gitBlameHeatmapTool(new FakeRunner({ stdout: "", stderr: "no such path", exitCode: 128 })),
      { file: "nope.ts" },
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("no such path")
  })

  test("spawn error → ok:false (no throw)", async () => {
    const r = await collect(gitBlameHeatmapTool(new ThrowingRunner()), { file: "x.ts" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("git blame failed")
  })
})
