/**
 * T5 — done-time patch-capture correctness (jun-24 scaffold SOTA absorption).
 *
 * `django__django-11138` graded as an EMPTY 0-byte submission even though the
 * agent's edit tools fired (M3/M5 receipts) — an infra/plumbing failure being
 * laundered into the solve-rate as a MODEL MISS, the same measurement-hole
 * confound this project fences elsewhere (throttle/empty-patch, gold-as-ours).
 *
 * This module classifies the done-time tree state from STRUCTURAL FACTS, with no
 * thresholds or heuristics. The three facts that separate the cases:
 *   - `sourcePatch`: the source-only unified diff actually captured (post
 *     `sourceOnlyDiff` stripping of test / repro-scaffold / binary / cache).
 *   - `rawDirty`: whether the worktree carries ANY staged change at all (before
 *     stripping). Obtained from git, not inferred.
 *   - `editCount`: how many SOURCE edit tool_results succeeded. Failed/denied
 *     edit attempts are excluded so a localize/apply blocker is not mislabeled
 *     as a capture desync.
 *
 * Truth table (no thresholds):
 *   sourcePatch non-empty                     ⇒ `source-captured` (normal submit)
 *   sourcePatch empty, rawDirty                ⇒ `stripped-only`   (agent touched
 *       ONLY test/repro/binary/cache paths that `sourceOnlyDiff` legitimately
 *       removes — an empty SOURCE patch is the correct outcome, not a capture bug)
 *   sourcePatch empty, clean, editCount === 0  ⇒ `empty-no-work`   (agent produced
 *       no edits — a genuine no-patch / model miss)
 *   sourcePatch empty, clean, editCount  >  0  ⇒ `lost-edits`      (at least one
 *       source edit tool_result reported success but the captured tree has ZERO
 *       staged change. This is a structural contradiction with possible causes:
 *         (a) fork-worktree capture desync (edit landed in a sibling tree the
 *             capture never read) — the original 11138 hypothesis,
 *         (b) the edit tool reported success while writing outside the captured
 *             sandbox subtree.
 *       Both are an INFRA / non-model-correctness signal for measurement safety
 *       — routed to retry, never silently submitted as a model miss — but callers
 *       must NOT brand it as confirmed capture-desync without a per-occurrence
 *       receipt (firstEditFile + apply result). See docs/handoff jun-24.)
 *
 * `stripped-only` vs `lost-edits` is the load-bearing split: it is precisely the
 * `rawDirty` fact that keeps a legitimate test-only edit from being misread as a
 * capture failure. Pure + deterministic.
 */

export type DoneTimeCaptureClass =
  | "source-captured"
  | "stripped-only"
  | "empty-no-work"
  | "lost-edits"

export interface DoneTimeCaptureFacts {
  readonly captureClass: DoneTimeCaptureClass
  readonly sourcePatchBytes: number
  readonly touchedFiles: readonly string[]
  readonly editCount: number
  readonly rawDirty: boolean
}

export const classifyDoneTimeCapture = (args: {
  readonly sourcePatch: string
  readonly rawDirty: boolean
  readonly editCount: number
  readonly touchedFiles: readonly string[]
}): DoneTimeCaptureFacts => {
  const sourceNonEmpty = args.sourcePatch.trim() !== ""
  const captureClass: DoneTimeCaptureClass = sourceNonEmpty
    ? "source-captured"
    : args.rawDirty
      ? "stripped-only"
      : args.editCount > 0
        ? "lost-edits"
        : "empty-no-work"
  return {
    captureClass,
    sourcePatchBytes: Buffer.byteLength(args.sourcePatch, "utf8"),
    touchedFiles: args.touchedFiles,
    editCount: args.editCount,
    rawDirty: args.rawDirty,
  }
}

/** A capture failure is an INFRA fault (edits made, none captured) — it must be
 *  retried, not graded as a model miss. The only class that qualifies is
 *  `lost-edits`; `empty-no-work` is a real miss and `stripped-only` is a correct
 *  empty source patch. */
export const isCaptureFailure = (captureClass: DoneTimeCaptureClass): boolean =>
  captureClass === "lost-edits"
