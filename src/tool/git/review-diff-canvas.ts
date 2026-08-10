/**
 * `@/tool/git/review-diff-canvas` — RFC-12 SURFACE B PRODUCER (Piece 2).
 *
 * `git_review_diff` hands the reviewer a UNIFIED diff (`git diff base...HEAD`) and
 * gets back `ReviewFinding[]`. To render those findings as an anchored overlay in
 * the web canvas, the daemon needs the per-file BEFORE/AFTER TEXT (the render
 * computes `diffOps(before, after)` and maps `anchor.line` → a new-side row). A
 * unified diff alone does NOT carry full before/after, so this module obtains it
 * with honest per-file git I/O:
 *
 *   before = `git show <mergeBase>:<path>`   (the three-dot diff's old side —
 *             merge-base(base, head), the exact snapshot the reviewer's line
 *             numbers were computed against)
 *   after  = `git show <head>:<path>`        (the new side)
 *
 * A new file (no old blob) ⇒ before = "" ; a deleted file (no new blob) ⇒ after =
 * "". Then it synthesizes + validates the anchors against THAT before/after
 * (`synthesizeAnchoredFindings`) and emits ONE `capture(...)` per reviewed file
 * that has at least one anchored finding.
 *
 * Gated on the sink: absent `ctx.toolDiff` / `ctx.toolCallId` (the canvas surface
 * is OFF) ⇒ this is a single guard + early return, ZERO git I/O, ZERO capture —
 * `git_review_diff` is byte-identical (the findings still return to the model).
 */

import { errMessage, logger } from "@/shared"
import type { ToolContext } from "../types"
import { safeRun } from "./_shared"
import { synthesizeAnchoredFindings } from "./review-anchor-synth"
import type { ReviewFinding } from "./review-diff"
import type { GitRunner } from "./types"

/** Extract the NEW-side file paths a unified diff touches from its `+++ b/<path>`
 *  headers (skipping `/dev/null` for a deletion). These are the render paths the
 *  reviewer reported findings against. */
export const reviewedPathsFromDiff = (unifiedDiff: string): string[] => {
  const paths: string[] = []
  for (const line of unifiedDiff.split("\n")) {
    if (!line.startsWith("+++ ")) continue
    const raw = line.slice(4).trim()
    if (raw === "/dev/null") continue
    // Strip the conventional `b/` prefix `git diff` emits on the new side.
    paths.push(raw.startsWith("b/") ? raw.slice(2) : raw)
  }
  return paths
}

/** `git show <rev>:<path>` → the blob text, or `""` when the blob does not exist
 *  at that rev (a new file on the before side, a deleted file on the after side).
 *  Any non-zero exit / spawn error ⇒ `""` (best-effort: a canvas render must never
 *  break the review; the findings already returned to the model). */
const showBlob = async (
  runner: GitRunner,
  rev: string,
  path: string,
  ctx: ToolContext,
): Promise<string> => {
  const out = await safeRun(runner, ["show", `${rev}:${path}`], ctx.cwd, "git show", ctx.signal)
  if (out.kind === "spawn-error" || out.result.exitCode !== 0) return ""
  return out.result.stdout
}

/** Resolve the three-dot diff's OLD side: `merge-base(base, head)`. Falls back to
 *  `base` itself when the merge-base cannot be computed (unrelated histories /
 *  detached state) — `git show <base>:<path>` is still an honest old-side blob. */
const resolveMergeBase = async (
  runner: GitRunner,
  base: string,
  head: string,
  ctx: ToolContext,
): Promise<string> => {
  const out = await safeRun(
    runner,
    ["merge-base", base, head],
    ctx.cwd,
    "git merge-base",
    ctx.signal,
  )
  if (out.kind === "spawn-error" || out.result.exitCode !== 0) return base
  const sha = out.result.stdout.trim()
  return sha.length > 0 ? sha : base
}

/** Findings whose `file` matches `path` (the per-file group the reviewer reported
 *  against THIS reviewed file). */
const findingsForPath = (findings: readonly ReviewFinding[], path: string): ReviewFinding[] =>
  findings.filter((f) => f.file === path)

/**
 * Emit ONE canvas `tool.diff` capture per reviewed file that has an anchored
 * finding. NO-OP (zero git I/O) when the canvas sink is not wired. The reviewer's
 * `findings` are grouped by file; for each file the before/after is fetched and
 * the anchors are synthesized + validated against it, so a finding whose line is
 * not on the new side is DROPPED (never mis-anchored). A file with zero surviving
 * anchors emits NO capture (no empty overlay).
 */
export const emitReviewCanvasDiffs = async (args: {
  readonly runner: GitRunner
  readonly ctx: ToolContext
  readonly unifiedDiff: string
  readonly findings: readonly ReviewFinding[]
  readonly base: string
  readonly head: string
}): Promise<void> => {
  const { runner, ctx, unifiedDiff, findings, base, head } = args
  const sink = ctx.toolDiff
  const toolCallId = ctx.toolCallId
  // Canvas OFF (no sink / no call correlation) ⇒ byte-identical: no git I/O, no
  // capture. The findings already went back to the model in the tool result.
  if (sink === undefined || toolCallId === undefined) return
  if (findings.length === 0) return

  const mergeBase = await resolveMergeBase(runner, base, head, ctx)
  const reviewedPaths = new Set(reviewedPathsFromDiff(unifiedDiff))

  for (const path of reviewedPaths) {
    const fileFindings = findingsForPath(findings, path)
    if (fileFindings.length === 0) continue
    const before = await showBlob(runner, mergeBase, path, ctx)
    const after = await showBlob(runner, head, path, ctx)
    const anchored = synthesizeAnchoredFindings(fileFindings, { path, before, after })
    if (anchored.length === 0) continue
    try {
      sink.capture({ toolCallId, before, after, path, findings: anchored })
    } catch (e) {
      // The review already returned to the model; a throwing observation sink
      // must never surface as a tool failure (belt-and-braces — the daemon sink
      // is no-throw by contract). Attribute so a contract breach is not lost.
      logger.warn(`review-canvas: sink.capture failed for ${path}: ${errMessage(e)}`)
    }
  }
}
