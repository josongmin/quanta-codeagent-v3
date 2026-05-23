/** Unit tests for `git_review_diff` — Claude Desktop `reviewDiff` pattern
 *  absorption (ADR-0111). Asserts:
 *
 *    • schema validation (all fields optional, types are arrays/strings)
 *    • metadata (name, isReadOnly = true, isConcurrencySafe = true, hitlTier "none")
 *    • argv: `git diff base...head` when both rev given; default base/head
 *      fall back to `origin/main` and `HEAD`; staged-style invocation when
 *      base/head both absent should yield `git diff HEAD` (working vs HEAD)
 *    • paths are appended after `--`
 *    • leading-`-` base/head rejected at the schema OR pre-argv layer (no
 *      `git diff --output=...` smuggling — same posture as `git_diff`)
 *    • empty diff ⇒ ok:true with `findings: []`
 *    • Subagent runner is invoked with depth+1, taskKind:"review", a
 *      read-only toolFilter, AND the diff text + focus injected into the
 *      prompt seed
 *    • runner failure ⇒ ok:false
 *    • spawn-error (git not found) ⇒ ok:false
 *    • absent ctx.reviewerAgent ⇒ deterministic ok:false (no throw)
 *    • signal threaded into git runner
 */

import { describe, expect, test } from "bun:test"
import { gitReviewDiffTool } from "@/tool/git/review-diff"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

interface ReviewerCall {
  prompt: string
  depth: number
  taskKind?: string
  toolFilter?: readonly string[]
  signal?: AbortSignal
}

interface ReviewerHandle {
  calls: ReviewerCall[]
  // Resolver may return undefined to use the default ok-result.
  setResolver(fn: (req: ReviewerCall) => { ok: boolean; finalText: string; turns?: number }): void
}

interface FakeReviewer {
  runner: (req: {
    prompt: string
    depth: number
    taskKind?: string
    toolFilter?: readonly string[]
    signal?: AbortSignal
  }) => Promise<{ ok: boolean; finalText: string; turns: number; messages?: unknown[] }>
  handle: ReviewerHandle
}

const fakeReviewer = (
  defaultFinalText = JSON.stringify({
    summary: "No issues found.",
    findings: [],
  }),
): FakeReviewer => {
  let resolver:
    | ((req: ReviewerCall) => { ok: boolean; finalText: string; turns?: number })
    | undefined
  const calls: ReviewerCall[] = []
  const runner = async (req: ReviewerCall) => {
    calls.push({
      prompt: req.prompt,
      depth: req.depth,
      ...(req.taskKind !== undefined ? { taskKind: req.taskKind } : {}),
      ...(req.toolFilter !== undefined ? { toolFilter: req.toolFilter } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    })
    const out = resolver?.(req) ?? { ok: true, finalText: defaultFinalText, turns: 1 }
    return { ok: out.ok, finalText: out.finalText, turns: out.turns ?? 1 }
  }
  return {
    runner,
    handle: {
      calls,
      setResolver: (fn) => {
        resolver = fn
      },
    },
  }
}

const ctx = (reviewer?: FakeReviewer): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  // Duck-typed seam — mirrors SubagentRunner without importing @/subagent.
  ...(reviewer !== undefined ? { reviewerAgent: reviewer.runner } : {}),
})

class FakeRunner implements GitRunner {
  readonly calls: { args: string[]; cwd: string; signal?: AbortSignal }[] = []
  constructor(
    private readonly resolver: GitRunResult | ((args: readonly string[]) => GitRunResult),
  ) {}
  async run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult> {
    this.calls.push({ args: [...args], cwd, ...(signal !== undefined ? { signal } : {}) })
    return typeof this.resolver === "function" ? this.resolver(args) : this.resolver
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
  c: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const ok = (stdout = ""): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const okWithDiff = (): GitRunResult =>
  ok(
    [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index e69de29..4b825dc 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -0,0 +1,3 @@",
      "+export const foo = () => 1",
      "+// TODO: validate",
      "+",
    ].join("\n"),
  )
const err = (stderr: string, exitCode = 128): GitRunResult => ({ stdout: "", stderr, exitCode })

describe("gitReviewDiffTool — metadata", () => {
  test("name + read-only + concurrency-safe + hitlTier none", () => {
    const t = gitReviewDiffTool(new FakeRunner(ok()))
    expect(t.name).toBe("git_review_diff")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({})).toBe(true)
    expect(t.hitlTier?.({})).toBe("none")
    expect(t.description).toMatch(/review|diff/i)
  })
})

describe("gitReviewDiffTool — schema", () => {
  test("schema accepts empty object (all fields optional)", () => {
    const t = gitReviewDiffTool(new FakeRunner(ok()))
    expect(t.inputSchema.safeParse({}).success).toBe(true)
  })

  test("schema accepts {base, head, paths, focus}", () => {
    const t = gitReviewDiffTool(new FakeRunner(ok()))
    const parsed = t.inputSchema.safeParse({
      base: "main",
      head: "HEAD",
      paths: ["src/foo.ts"],
      focus: "look for null dereferences",
    })
    expect(parsed.success).toBe(true)
  })

  test("schema rejects wrong types", () => {
    const t = gitReviewDiffTool(new FakeRunner(ok()))
    expect(t.inputSchema.safeParse({ paths: "not-an-array" }).success).toBe(false)
    expect(t.inputSchema.safeParse({ focus: 12 }).success).toBe(false)
  })
})

describe("gitReviewDiffTool — argv composition", () => {
  test("default revs: git diff origin/main...HEAD", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer()
    await collect(gitReviewDiffTool(runner), {}, ctx(rv))
    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0]?.args).toEqual(["diff", "origin/main...HEAD"])
  })

  test("explicit base+head: git diff <base>...<head>", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer()
    await collect(gitReviewDiffTool(runner), { base: "feature/x", head: "feature/y" }, ctx(rv))
    expect(runner.calls[0]?.args).toEqual(["diff", "feature/x...feature/y"])
  })

  test("paths appended after --", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer()
    await collect(gitReviewDiffTool(runner), { paths: ["src/foo.ts", "src/bar.ts"] }, ctx(rv))
    expect(runner.calls[0]?.args).toEqual([
      "diff",
      "origin/main...HEAD",
      "--",
      "src/foo.ts",
      "src/bar.ts",
    ])
  })

  test("rejects leading-'-' base (no `git diff --output=...` smuggling)", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer()
    const r = await collect(gitReviewDiffTool(runner), { base: "--output=/etc/x" }, ctx(rv))
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/invalid|base/i)
    // Did not even reach git.
    expect(runner.calls.length).toBe(0)
  })

  test("rejects leading-'-' head", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer()
    const r = await collect(gitReviewDiffTool(runner), { head: "-G<re>" }, ctx(rv))
    expect(r.ok).toBe(false)
    expect(runner.calls.length).toBe(0)
  })

  test("signal forwarded to git runner", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer()
    const c = new AbortController()
    const customCtx: ToolContext = {
      cwd: "/tmp",
      signal: c.signal,
      reviewerAgent: rv.runner,
    }
    await collect(gitReviewDiffTool(runner), {}, customCtx)
    expect(runner.calls[0]?.signal).toBe(c.signal)
  })
})

describe("gitReviewDiffTool — empty diff path", () => {
  test("empty diff ⇒ ok:true with no findings + no reviewer call", async () => {
    const runner = new FakeRunner(ok("")) // no diff
    const rv = fakeReviewer()
    const r = await collect(gitReviewDiffTool(runner), {}, ctx(rv))
    expect(r.ok).toBe(true)
    // No reviewer should have been invoked — saves model tokens for empty PRs.
    expect(rv.handle.calls.length).toBe(0)
    expect(r.output).toMatch(/no diff|empty/i)
    // structured payload (if surfaced) carries findings: []
    const struct = r.structured as { findings?: unknown[] } | undefined
    if (struct) expect(struct.findings).toEqual([])
  })
})

describe("gitReviewDiffTool — subagent reviewer", () => {
  test("invokes reviewer with depth+1 + taskKind:'review' + filtered toolFilter", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer()
    const customCtx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      reviewerAgent: rv.runner,
      depth: 2,
    }
    await collect(gitReviewDiffTool(runner), { focus: "null derefs" }, customCtx)
    expect(rv.handle.calls.length).toBe(1)
    const call = rv.handle.calls[0]
    expect(call?.depth).toBe(3) // parent depth (2) + 1
    expect(call?.taskKind).toBe("review")
    // Filtered registry: only read-only inspection tools.
    expect(call?.toolFilter).toEqual(["read", "grep", "glob"])
    // Diff text injected into prompt seed.
    expect(call?.prompt).toContain("diff --git a/src/foo.ts")
    // Focus injected verbatim.
    expect(call?.prompt).toContain("null derefs")
    // REVIEW notice mirrored — assert one stable phrase from REVIEW_NOTICE.
    expect(call?.prompt.toLowerCase()).toMatch(/review|findings/)
  })

  test("returns parsed findings + summary from reviewer JSON", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer(
      JSON.stringify({
        summary: "1 minor issue",
        findings: [
          {
            file: "src/foo.ts",
            line: 2,
            severity: "warning",
            what: "TODO comment retained",
            why: "Indicates incomplete validation",
            impact: "May ship unverified input handling",
          },
        ],
      }),
    )
    const r = await collect(gitReviewDiffTool(runner), {}, ctx(rv))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("TODO comment retained")
    const struct = r.structured as
      | {
          summary?: string
          findings?: { severity: string; what: string }[]
        }
      | undefined
    if (struct) {
      expect(struct.summary).toBe("1 minor issue")
      expect(struct.findings?.length).toBe(1)
      expect(struct.findings?.[0]?.severity).toBe("warning")
    }
  })

  test("reviewer failure ⇒ ok:false (surfaced to model)", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer()
    rv.handle.setResolver(() => ({ ok: false, finalText: "reviewer aborted: budget", turns: 1 }))
    const r = await collect(gitReviewDiffTool(runner), {}, ctx(rv))
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/reviewer|review/i)
  })

  test("non-JSON reviewer output ⇒ ok:true with raw text as summary", async () => {
    const runner = new FakeRunner(okWithDiff())
    const rv = fakeReviewer("LGTM — minor TODO at src/foo.ts:2 but not blocking.")
    const r = await collect(gitReviewDiffTool(runner), {}, ctx(rv))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("LGTM")
  })
})

describe("gitReviewDiffTool — error paths", () => {
  test("spawn failure ⇒ ok:false", async () => {
    const rv = fakeReviewer()
    const r = await collect(gitReviewDiffTool(new ThrowingRunner()), {}, ctx(rv))
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/spawn|ENOENT/i)
  })

  test("git diff non-zero (>1) ⇒ ok:false", async () => {
    // exit 0 (no diff) and 1 (has diff) are both OK; >1 is failure.
    const runner = new FakeRunner(err("fatal: bad revision 'main'", 128))
    const rv = fakeReviewer()
    const r = await collect(gitReviewDiffTool(runner), { base: "main" }, ctx(rv))
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/bad revision|fatal/i)
  })

  test("missing ctx.reviewerAgent ⇒ ok:false (deterministic, no throw)", async () => {
    const runner = new FakeRunner(okWithDiff())
    // No reviewer attached.
    const r = await collect(gitReviewDiffTool(runner), {}, ctx())
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/reviewer|not.*attached|disabled/i)
  })
})
