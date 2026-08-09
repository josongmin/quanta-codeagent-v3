/**
 * RFC-12 SURFACE B PRODUCER (front-door hellgate) — `git_review_diff` renders its
 * reviewer findings as anchored canvas comments.
 *
 * The daemon-side wire (`reviewFindingsToAnchors` → `CapturedToolDiff.anchors` →
 * `feedToolDiff` → `ToolDiffMessage.anchors` → the web `DiffView` overlay) was
 * fully built but PRODUCER-LESS: `parseOneFinding` never set `.anchor`, and the
 * review tool has only a UNIFIED diff (no before/after), so
 * `reviewFindingsToAnchors` returned `[]` for every real review ⇒ the overlay was
 * EMPTY end-to-end.
 *
 * This test drives a REAL `git_review_diff` over a fixture repo (via a scripted
 * `GitRunner` that serves `git diff` / `git merge-base` / `git show`) with a
 * reviewer that reports a finding at a KNOWN file:line, and asserts the producer:
 *
 *   1. synthesizes + validates the anchor from the finding's OWN file+line against
 *      the real before/after, and emits ONE `capture(...)` per reviewed file with
 *      anchors on the CORRECT new-side line (NON-VACUOUS — the overlay is real).
 *   2. drops a finding whose line is NOT on the new side of the diff (never
 *      mis-anchored).
 *   3. absent sink ⇒ ZERO captures AND ZERO `git show` I/O (byte-identical).
 *   4. red-on-injection: dropping the before/after (empty blobs) ⇒ no anchor
 *      survives ⇒ NO capture ⇒ overlay empty.
 */

import { describe, expect, test } from "bun:test"
import { createCanvasToolDiffSource } from "@/apps/web-daemon/canvas-tool-diff-source"
import { gitReviewDiffTool } from "@/tool/git/review-diff"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* Fixture: a one-file diff whose new side has 3 lines.                */
/* ------------------------------------------------------------------ */

const PATH = "src/foo.ts"
const BEFORE = "const a = 1\nconst b = 2\n"
// new side: line 1 = "const a = 1", line 2 = "const b = 3", line 3 = "const c = 4"
const AFTER = "const a = 1\nconst b = 3\nconst c = 4\n"

const UNIFIED_DIFF = [
  `diff --git a/${PATH} b/${PATH}`,
  "index e69de29..4b825dc 100644",
  `--- a/${PATH}`,
  `+++ b/${PATH}`,
  "@@ -1,2 +1,3 @@",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  "+const c = 4",
].join("\n")

const REVIEW_JSON = (line: number): string =>
  JSON.stringify({
    summary: "1 confirmed issue",
    findings: [
      {
        file: PATH,
        line,
        severity: "error",
        what: "c may be used before assignment",
        verdict: "confirmed",
        category: "null-deref",
        shortSummary: "c may be used before assignment",
      },
    ],
  })

/* ------------------------------------------------------------------ */
/* Scripted git runner: git diff / merge-base / show.                  */
/* ------------------------------------------------------------------ */

const ok = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })

class ScriptedRunner implements GitRunner {
  readonly calls: string[][] = []
  constructor(private readonly blobs: Record<string, string>) {}
  async run(args: readonly string[]): Promise<GitRunResult> {
    this.calls.push([...args])
    if (args[0] === "diff") return ok(UNIFIED_DIFF)
    if (args[0] === "merge-base") return ok("mergebasesha\n")
    if (args[0] === "show") {
      const spec = args[1] ?? ""
      const blob = this.blobs[spec]
      return blob !== undefined ? ok(blob) : { stdout: "", stderr: "no blob", exitCode: 128 }
    }
    return ok("")
  }
  showCalls(): string[] {
    return this.calls.filter((c) => c[0] === "show").map((c) => c[1] ?? "")
  }
}

const fakeReviewer =
  (finalText: string) => async (): Promise<{ ok: boolean; finalText: string; turns: number }> => ({
    ok: true,
    finalText,
    turns: 1,
  })

const collect = async (
  tool: { execute(i: never, c: ToolContext): AsyncIterable<ToolEvent> },
  ctx: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute({} as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

/* ------------------------------------------------------------------ */
/* Front-door: real review → correct-line canvas overlay.              */
/* ------------------------------------------------------------------ */

describe("git_review_diff PRODUCER — anchored canvas overlay (front-door)", () => {
  test("a finding at a real new-side line ⇒ ONE capture with the anchor on that line", async () => {
    const runner = new ScriptedRunner({
      "mergebasesha:src/foo.ts": BEFORE,
      "HEAD:src/foo.ts": AFTER,
    })
    const source = createCanvasToolDiffSource()
    const captured: unknown[] = []
    source.subscribe((d) => captured.push(d))

    const ctx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      reviewerAgent: fakeReviewer(REVIEW_JSON(3)),
      toolDiff: source.sink,
      toolCallId: "call-1",
    }
    const r = await collect(gitReviewDiffTool(runner), ctx)
    expect(r.ok).toBe(true)

    expect(captured).toHaveLength(1)
    const diff = captured[0] as {
      toolCallId: string
      before: string
      after: string
      path: string
      anchors?: { line: number; verdict?: string; category?: string; summary: string }[]
    }
    expect(diff.toolCallId).toBe("call-1")
    expect(diff.path).toBe(PATH)
    expect(diff.before).toBe(BEFORE)
    expect(diff.after).toBe(AFTER)
    // NON-VACUOUS: the overlay landed on the CORRECT new-side line (3 = "const c = 4").
    expect(diff.anchors).toEqual([
      {
        line: 3,
        verdict: "confirmed",
        category: "null-deref",
        summary: "c may be used before assignment",
        severity: "error",
      },
    ])
  })

  test("a finding whose line is NOT on the new side is DROPPED (no capture, not mis-anchored)", async () => {
    const runner = new ScriptedRunner({
      "mergebasesha:src/foo.ts": BEFORE,
      "HEAD:src/foo.ts": AFTER,
    })
    const source = createCanvasToolDiffSource()
    const captured: unknown[] = []
    source.subscribe((d) => captured.push(d))
    const ctx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      // line 1 is an UNCHANGED context line — no hunk produces it ⇒ no anchor.
      reviewerAgent: fakeReviewer(REVIEW_JSON(1)),
      toolDiff: source.sink,
      toolCallId: "call-1",
    }
    const r = await collect(gitReviewDiffTool(runner), ctx)
    expect(r.ok).toBe(true)
    expect(captured).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* Absent sink ⇒ byte-identical (no capture, no git-show I/O).         */
/* ------------------------------------------------------------------ */

describe("git_review_diff PRODUCER — absent sink is byte-identical", () => {
  test("no toolDiff seam ⇒ ZERO captures AND ZERO `git show` I/O", async () => {
    const runner = new ScriptedRunner({
      "mergebasesha:src/foo.ts": BEFORE,
      "HEAD:src/foo.ts": AFTER,
    })
    const ctx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      reviewerAgent: fakeReviewer(REVIEW_JSON(3)),
      // NO toolDiff / toolCallId — the canvas surface is OFF.
    }
    const r = await collect(gitReviewDiffTool(runner), ctx)
    // Findings still return to the model.
    expect(r.ok).toBe(true)
    expect(r.output).toContain("c may be used before assignment")
    // Byte-identical: the producer did NO git-show I/O at all.
    expect(runner.showCalls()).toEqual([])
    expect(runner.calls.some((c) => c[0] === "merge-base")).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* red-on-injection: drop the before/after ⇒ overlay empty.            */
/* ------------------------------------------------------------------ */

describe("git_review_diff PRODUCER — red-on-injection", () => {
  test("empty before/after (git show yields nothing) ⇒ NO anchor survives ⇒ NO capture", async () => {
    // The blobs are MISSING ⇒ showBlob returns "" for both sides ⇒ diffOps has no
    // hunk ⇒ the synthesized anchor cannot validate ⇒ no capture (overlay empty).
    const runner = new ScriptedRunner({}) // no blobs
    const source = createCanvasToolDiffSource()
    const captured: unknown[] = []
    source.subscribe((d) => captured.push(d))
    const ctx: ToolContext = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      reviewerAgent: fakeReviewer(REVIEW_JSON(3)),
      toolDiff: source.sink,
      toolCallId: "call-1",
    }
    const r = await collect(gitReviewDiffTool(runner), ctx)
    expect(r.ok).toBe(true)
    expect(captured).toHaveLength(0)
  })
})
