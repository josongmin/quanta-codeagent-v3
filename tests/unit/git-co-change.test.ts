// §7.2 long-tail — git_co_change co-occurrence / related-files tool.
//
// Pure-ranking unit coverage (parseCommitGroups / rankCoChange / rankCoChangePairs)
// + the tool's spawn-wrapper behaviour over an injected GitRunner. The e2e
// hellgate (real `git init` + real registry dispatch) lives in
// tests/integration/longtail-new-tools-e2e.test.ts.

import { describe, expect, test } from "bun:test"
import {
  gitCoChangeTool,
  gitTools,
  parseCommitGroups,
  rankCoChange,
  rankCoChangePairs,
} from "@/tool"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent } from "@/tool/types"

const fakeRunner = (stdout: string, exitCode = 0, stderr = ""): GitRunner => ({
  run: async (): Promise<GitRunResult> => ({ stdout, stderr, exitCode }),
})

const ctx = (): ToolContext =>
  ({ cwd: "/repo", signal: new AbortController().signal }) as unknown as ToolContext

const runTool = async (
  tool: ReturnType<typeof gitCoChangeTool>,
  input: Parameters<typeof tool.execute>[0],
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } = { ok: false, output: "(no result)" }
  for await (const ev of tool.execute(input, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  return last
}

// `git log --name-only --format=%x1e` shape: each commit is `<RS>\n\n<files>`.
const RS = "\x1e"
// Two commits: [A,B,C] then [A,B]. A&B co-change twice; A&C once.
const LOG = `${RS}\n\nA\nB\nC\n${RS}\n\nA\nB\n`

describe("git_co_change — pure parsing", () => {
  test("parseCommitGroups splits on the Record-Separator commit marker", () => {
    expect(parseCommitGroups(LOG)).toEqual([
      ["A", "B", "C"],
      ["A", "B"],
    ])
  })

  test("parseCommitGroups drops empty blocks (no empty group from the leading RS)", () => {
    expect(parseCommitGroups(`${RS}\n\nX\n${RS}\n\nY\n`)).toEqual([["X"], ["Y"]])
  })
})

describe("git_co_change — rankCoChange (target file)", () => {
  test("ranks co-changing files by co-count with Jaccard affinity", () => {
    const groups = parseCommitGroups(LOG)
    const { targetCommits, rows } = rankCoChange(groups, "A", 20)
    expect(targetCommits).toBe(2) // A in both commits
    // B co-changes with A twice (affinity 2/2=1); C once (affinity 1/2=0.5).
    expect(rows[0]).toEqual({ file: "B", coCount: 2, affinity: 1 })
    expect(rows[1]).toEqual({ file: "C", coCount: 1, affinity: 0.5 })
  })

  test("a file that never co-changes with the target is omitted", () => {
    const groups = parseCommitGroups(`${RS}\n\nA\n${RS}\n\nB\n`) // A and B never share a commit
    const { rows } = rankCoChange(groups, "A", 20)
    expect(rows).toEqual([])
  })

  test("ties break deterministically by path (byteCompare)", () => {
    // A with both Z and B exactly once each → same coCount + affinity; B < Z.
    const groups = parseCommitGroups("A\nZ\nB\n")
    const { rows } = rankCoChange(groups, "A", 20)
    expect(rows.map((r) => r.file)).toEqual(["B", "Z"])
  })

  test("topN caps the result", () => {
    const groups = parseCommitGroups("A\nB\nC\nD\n")
    expect(rankCoChange(groups, "A", 2).rows).toHaveLength(2)
  })
})

describe("git_co_change — rankCoChangePairs (no target)", () => {
  test("counts unordered pairs, densest first", () => {
    const pairs = rankCoChangePairs(parseCommitGroups(LOG), 20)
    // A+B appears twice (most coupled); A+C, B+C once each.
    expect(pairs[0]).toEqual({ a: "A", b: "B", coCount: 2 })
    expect(pairs.some((p) => p.a === "A" && p.b === "C" && p.coCount === 1)).toBe(true)
  })
})

describe("git_co_change — tool wrapper", () => {
  test("target mode renders co-change rows", async () => {
    const tool = gitCoChangeTool(fakeRunner(LOG))
    const r = await runTool(tool, { file: "A" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("co-change with A")
    expect(r.output).toContain("B")
  })

  test("pairs mode (no file) renders top pairs", async () => {
    const tool = gitCoChangeTool(fakeRunner(LOG))
    const r = await runTool(tool, {})
    expect(r.ok).toBe(true)
    expect(r.output).toContain("top co-change pairs")
    expect(r.output).toContain("A  +  B")
  })

  test("non-zero git exit collapses to ok:false (no throw)", async () => {
    const tool = gitCoChangeTool(fakeRunner("", 128, "fatal: not a git repository"))
    const r = await runTool(tool, { file: "A" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("not a git repository")
  })

  test("is read-only + concurrency-safe", () => {
    const tool = gitCoChangeTool(fakeRunner(""))
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe({})).toBe(true)
    expect(tool.name).toBe("git_co_change")
  })
})

describe("git_co_change — DEFAULT-OFF byte-identity", () => {
  test("gitTools() (no opts) does NOT include git_co_change (byte-identical legacy)", () => {
    const names = gitTools().map((t) => t.name)
    expect(names).not.toContain("git_co_change")
    expect(names).toHaveLength(12) // legacy 10 read-only + 2 mutating
  })

  test("gitTools(undefined, {}) is byte-identical to gitTools() (no flag ⇒ no tool)", () => {
    expect(gitTools(undefined, {}).map((t) => t.name)).toEqual(gitTools().map((t) => t.name))
  })

  test("gitTools(runner, {coChange:true}) appends git_co_change (gate ON)", () => {
    const names = gitTools(fakeRunner(""), { coChange: true }).map((t) => t.name)
    expect(names).toContain("git_co_change")
    expect(names).toHaveLength(13)
    // appended LAST — legacy ordering untouched.
    expect(names[names.length - 1]).toBe("git_co_change")
  })
})
