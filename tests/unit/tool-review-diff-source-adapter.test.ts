/** RFC-02 B2 — one review-tool adapter (RED rail first).
 *
 *  Two concerns, one invocation path:
 *    1. `@/tool/git/review-source-adapter` converts a resolved `GitDiffOperation`
 *       to `git diff` argv — the ONLY place that mapping exists — and binds the
 *       existing `GitRunner` as the `GitReadPort` (rev-parse peel).
 *    2. `git_review_diff` gains an OPTIONAL `source` field:
 *         • default (no source) is BYTE-IDENTICAL to today: `git diff origin/main...HEAD`;
 *         • `source` + legacy `base`/`head` is a typed MIXED error (no precedence);
 *         • each source arm reaches the SAME reviewer consumer.
 *
 *  Anti-vacuity: argv is asserted through the REAL tool `execute` against a fake
 *  runner that records every `git` call — not a hand-built argv.
 */

import { describe, expect, test } from "bun:test"
import type { GitDiffOperation } from "@/git"
import { gitReviewDiffTool } from "@/tool/git/review-diff"
import {
  gitRunnerReadPort,
  operationToArgs,
  workingTreeArgs,
} from "@/tool/git/review-source-adapter"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

// --- fakes -------------------------------------------------------------------

class FakeRunner implements GitRunner {
  readonly calls: { args: string[]; cwd: string }[] = []
  constructor(private readonly resolver: (args: readonly string[]) => GitRunResult) {}
  async run(args: readonly string[], cwd: string): Promise<GitRunResult> {
    this.calls.push({ args: [...args], cwd })
    return this.resolver(args)
  }
}

const ok = (stdout = ""): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const diffText = "diff --git a/x b/x\n@@ -0,0 +1 @@\n+x\n"

const reviewerStub = () => {
  const calls: { prompt: string }[] = []
  return {
    runner: async (req: { prompt: string }) => {
      calls.push({ prompt: req.prompt })
      return { ok: true, finalText: JSON.stringify({ summary: "ok", findings: [] }), turns: 1 }
    },
    calls,
  }
}

const ctx = (reviewer?: ReturnType<typeof reviewerStub>): ToolContext => ({
  cwd: "/repo",
  signal: new AbortController().signal,
  ...(reviewer !== undefined ? { reviewerAgent: reviewer.runner } : {}),
})

const collect = async (input: unknown, runner: GitRunner, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of (
    gitReviewDiffTool(runner) as {
      execute(i: never, cc: ToolContext): AsyncIterable<ToolEvent>
    }
  ).execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// --- operationToArgs (the single argv mapping) -------------------------------

describe("operationToArgs — resolved operation ⇒ git diff argv", () => {
  test("branch-merge-base ⇒ three-dot, refs kept symbolic", () => {
    const op: GitDiffOperation = { kind: "branch-merge-base", base: "origin/main", head: "HEAD" }
    expect(operationToArgs(op)).toEqual(["diff", "origin/main...HEAD"])
  })

  test("commit-first-parent ⇒ two-dot base..commit", () => {
    const op: GitDiffOperation = { kind: "commit-first-parent", base: "p1", commit: "c1" }
    expect(operationToArgs(op)).toEqual(["diff", "p1..c1"])
  })

  test("tree-range ⇒ two-dot from..to", () => {
    const op: GitDiffOperation = { kind: "tree-range", from: "a", to: "b" }
    expect(operationToArgs(op)).toEqual(["diff", "a..b"])
  })
})

// --- workingTreeArgs (RFC-02 B4 front-door argv) -----------------------------

describe("workingTreeArgs — working-tree ⇒ git diff <against>", () => {
  test("default HEAD ⇒ diff HEAD (uncommitted vs HEAD)", () => {
    expect(workingTreeArgs("HEAD")).toEqual(["diff", "HEAD"])
  })
  test("explicit against ⇒ diff <against>", () => {
    expect(workingTreeArgs("origin/main")).toEqual(["diff", "origin/main"])
  })
})

// --- gitRunnerReadPort (rev-parse peel) --------------------------------------

describe("gitRunnerReadPort — resolveCommit via rev-parse", () => {
  test("exit 0 ⇒ trimmed oid; peel form used", async () => {
    const runner = new FakeRunner(() => ok("abc123\n"))
    const port = gitRunnerReadPort(runner, "/repo")
    expect(await port.resolveCommit("HEAD")).toBe("abc123")
    expect(runner.calls[0]?.args).toEqual(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
  })

  test("non-zero exit ⇒ null (unresolvable)", async () => {
    const runner = new FakeRunner(() => ({ stdout: "", stderr: "", exitCode: 1 }))
    const port = gitRunnerReadPort(runner, "/repo")
    expect(await port.resolveCommit("nope")).toBeNull()
  })
})

// --- byte-identical default (the load-bearing gate) --------------------------

describe("git_review_diff — default source unset is byte-identical", () => {
  test("no source, no base/head ⇒ git diff origin/main...HEAD (unchanged)", async () => {
    const runner = new FakeRunner(() => ok(diffText))
    await collect({}, runner, ctx(reviewerStub()))
    // EXACTLY one git call, EXACTLY today's argv.
    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0]?.args).toEqual(["diff", "origin/main...HEAD"])
  })

  test("legacy base/head still works unchanged", async () => {
    const runner = new FakeRunner(() => ok(diffText))
    await collect({ base: "a", head: "b" }, runner, ctx(reviewerStub()))
    expect(runner.calls[0]?.args).toEqual(["diff", "a...b"])
  })
})

// --- source arm through the real tool ----------------------------------------

describe("git_review_diff — source field", () => {
  test("branch-base source ⇒ origin/main...HEAD, reviewer invoked", async () => {
    const runner = new FakeRunner(() => ok(diffText))
    const rv = reviewerStub()
    await collect({ source: { kind: "branch-base" } }, runner, ctx(rv))
    expect(runner.calls.at(-1)?.args).toEqual(["diff", "origin/main...HEAD"])
    expect(rv.calls.length).toBe(1)
  })

  test("commit source ⇒ rev-parse peel THEN diff base..commit", async () => {
    // rev-parse returns a distinct oid per arg so we can assert the peel + argv.
    const runner = new FakeRunner((args) => {
      if (args[0] === "rev-parse") {
        const rev = args[3] ?? ""
        if (rev.startsWith("feat")) return ok("c1\n")
        if (rev.startsWith("c1~1")) return ok("p1\n")
        return { stdout: "", stderr: "", exitCode: 1 }
      }
      return ok(diffText)
    })
    const rv = reviewerStub()
    await collect({ source: { kind: "commit", oid: "feat" } }, runner, ctx(rv))
    expect(runner.calls.at(-1)?.args).toEqual(["diff", "p1..c1"])
    expect(rv.calls.length).toBe(1)
  })

  test("range source ⇒ two peels THEN diff from..to", async () => {
    const runner = new FakeRunner((args) => {
      if (args[0] === "rev-parse") {
        const rev = args[3] ?? ""
        if (rev.startsWith("v1")) return ok("o1\n")
        if (rev.startsWith("v2")) return ok("o2\n")
        return { stdout: "", stderr: "", exitCode: 1 }
      }
      return ok(diffText)
    })
    await collect({ source: { kind: "range", from: "v1", to: "v2" } }, runner, ctx(reviewerStub()))
    expect(runner.calls.at(-1)?.args).toEqual(["diff", "o1..o2"])
  })

  test("MIXED source + base ⇒ typed error, NO git call, NO reviewer call", async () => {
    const runner = new FakeRunner(() => ok(diffText))
    const rv = reviewerStub()
    const r = await collect({ source: { kind: "branch-base" }, base: "main" }, runner, ctx(rv))
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/mutually exclusive|mixed|source/i)
    expect(runner.calls.length).toBe(0)
    expect(rv.calls.length).toBe(0)
  })

  test("unresolvable commit source ⇒ fail-closed deny, NO diff run", async () => {
    const runner = new FakeRunner((args) =>
      args[0] === "rev-parse" ? { stdout: "", stderr: "", exitCode: 1 } : ok(diffText),
    )
    const r = await collect(
      { source: { kind: "commit", oid: "nope" } },
      runner,
      ctx(reviewerStub()),
    )
    expect(r.ok).toBe(false)
    // Only the rev-parse peel ran; the diff was NEVER attempted (fail-closed).
    expect(runner.calls.every((c) => c.args[0] === "rev-parse")).toBe(true)
  })
})

// --- RFC-02 B4 front-door arms (working-tree / last-turn) --------------------

describe("git_review_diff — B4 working-tree source", () => {
  test("working-tree default ⇒ git diff HEAD (no rev-parse peel), reviewer invoked", async () => {
    const runner = new FakeRunner(() => ok(diffText))
    const rv = reviewerStub()
    await collect({ source: { kind: "working-tree" } }, runner, ctx(rv))
    // Symbolic like branch-base: NO peel; exactly the working-tree diff argv.
    expect(runner.calls.every((c) => c.args[0] !== "rev-parse")).toBe(true)
    expect(runner.calls.at(-1)?.args).toEqual(["diff", "HEAD"])
    expect(rv.calls.length).toBe(1)
  })

  test("working-tree against an explicit rev ⇒ git diff <against>", async () => {
    const runner = new FakeRunner(() => ok(diffText))
    await collect(
      { source: { kind: "working-tree", against: "origin/main" } },
      runner,
      ctx(reviewerStub()),
    )
    expect(runner.calls.at(-1)?.args).toEqual(["diff", "origin/main"])
  })

  test("working-tree leading-dash against ⇒ typed deny, NO git call, NO reviewer", async () => {
    const runner = new FakeRunner(() => ok(diffText))
    const rv = reviewerStub()
    const r = await collect(
      { source: { kind: "working-tree", against: "--output=/tmp/x" } },
      runner,
      ctx(rv),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("must not begin with '-'")
    expect(runner.calls.length).toBe(0)
    expect(rv.calls.length).toBe(0)
  })
})

describe("git_review_diff — B4 last-turn parked arm", () => {
  test("last-turn ⇒ STABLE prerequisite deny, NO git call, NO reviewer", async () => {
    const runner = new FakeRunner(() => ok(diffText))
    const rv = reviewerStub()
    const r = await collect({ source: { kind: "last-turn", turnId: "t1" } }, runner, ctx(rv))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("last-turn")
    expect(r.output.toLowerCase()).toContain("boundary")
    // Stable + terminal: never runs a diff, never silently falls back.
    expect(runner.calls.length).toBe(0)
    expect(rv.calls.length).toBe(0)
  })
})
