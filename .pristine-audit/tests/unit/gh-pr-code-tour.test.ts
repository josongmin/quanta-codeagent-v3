// §5.4 long-tail — gh_pr_code_tour guided PR-diff walkthrough tool.
//
// Pure unified-diff parser coverage + the tool's spawn-wrapper (injected
// GhRunner) including the ref-injection guard. The e2e hellgate (real registry
// dispatch) lives in tests/integration/longtail-new-tools-e2e.test.ts.

import { describe, expect, test } from "bun:test"
import type { GhRunner, GhRunResult } from "@/tool/gh"
import { ghPrCodeTourTool, ghTools, parseDiffToTour } from "@/tool/gh"
import type { ToolContext, ToolEvent } from "@/tool/types"

const fakeRunner =
  (stdout: string, code = 0, stderr = ""): GhRunner =>
  async (): Promise<GhRunResult> => ({ code, stdout, stderr })

const ctx = (): ToolContext =>
  ({ cwd: "/repo", signal: new AbortController().signal }) as unknown as ToolContext

const runTool = async (
  tool: ReturnType<typeof ghPrCodeTourTool>,
  input: Parameters<typeof tool.execute>[0],
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } = { ok: false, output: "(no result)" }
  for await (const ev of tool.execute(input, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  return last
}

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,4 @@ export function foo() {
 const x = 1
+const y = 2
 return x
-return x + 1
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +5,2 @@ class Bar {
-old
+new
`

describe("gh_pr_code_tour — parseDiffToTour", () => {
  test("one stop per hunk, with file + new-side line range + context", () => {
    const stops = parseDiffToTour(SAMPLE_DIFF)
    expect(stops).toHaveLength(2)
    expect(stops[0]).toEqual({
      file: "src/foo.ts",
      newStart: 10,
      newLines: 4,
      context: "export function foo() {",
      added: 1,
      removed: 1,
    })
    expect(stops[1]).toEqual({
      file: "src/bar.ts",
      newStart: 5,
      newLines: 2,
      context: "class Bar {",
      added: 1,
      removed: 1,
    })
  })

  test("a hunk header without an explicit count defaults newLines=1", () => {
    const stops = parseDiffToTour("+++ b/x.ts\n@@ -3 +7 @@\n+a\n")
    expect(stops[0]?.newStart).toBe(7)
    expect(stops[0]?.newLines).toBe(1)
  })

  test("a pure deletion (+++ /dev/null) uses the old-side path", () => {
    const stops = parseDiffToTour("--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n")
    expect(stops[0]?.file).toBe("gone.ts")
    expect(stops[0]?.removed).toBe(2)
  })

  test("empty / no-hunk diff parses to zero stops (no throw)", () => {
    expect(parseDiffToTour("")).toEqual([])
    expect(parseDiffToTour("just some noise\nno hunks here")).toEqual([])
  })
})

describe("gh_pr_code_tour — tool wrapper", () => {
  test("renders a numbered itinerary", async () => {
    const r = await runTool(ghPrCodeTourTool(fakeRunner(SAMPLE_DIFF)), { pr: 42 })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("PR code tour — 2 stop(s)")
    expect(r.output).toContain("1. src/foo.ts:10-13")
    expect(r.output).toContain("2. src/bar.ts:5-6")
  })

  test("maxStops caps the itinerary + reports the total", async () => {
    const r = await runTool(ghPrCodeTourTool(fakeRunner(SAMPLE_DIFF)), { pr: 42, maxStops: 1 })
    expect(r.output).toContain("showing first 1")
    expect(r.output).toContain("1. src/foo.ts")
    expect(r.output).not.toContain("2. src/bar.ts")
  })

  test("ref-injection: a leading-dash PR id is rejected before spawn (red-on-injection)", async () => {
    let spawned = false
    const runner: GhRunner = async () => {
      spawned = true
      return { code: 0, stdout: "", stderr: "" }
    }
    const r = await runTool(ghPrCodeTourTool(runner), { pr: "--web" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid PR identifier")
    expect(spawned).toBe(false) // never reached argv
  })

  test("gh failure collapses to ok:false (no throw)", async () => {
    const r = await runTool(ghPrCodeTourTool(fakeRunner("", 1, "gh: not found")), { pr: 7 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("gh pr diff failed")
  })

  test("is read-only + hitlTier none", () => {
    const tool = ghPrCodeTourTool(fakeRunner(""))
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.hitlTier?.({ pr: 1 })).toBe("none")
    expect(tool.name).toBe("gh_pr_code_tour")
  })
})

describe("gh_pr_code_tour — DEFAULT-OFF byte-identity", () => {
  const names = (opts?: Parameters<typeof ghTools>[1]) =>
    ghTools(undefined, opts).map((t) => t.name)

  test("ghTools() (no opts) does NOT include gh_pr_code_tour", () => {
    expect(names()).not.toContain("gh_pr_code_tour")
  })

  test("ghTools(undefined, {}) byte-identical to ghTools()", () => {
    expect(names({})).toEqual(names())
  })

  test("ghTools(runner, {codeTour:true}) appends gh_pr_code_tour", () => {
    expect(names({ codeTour: true })).toContain("gh_pr_code_tour")
  })
})
