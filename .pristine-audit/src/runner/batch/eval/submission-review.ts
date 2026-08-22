/**
 * Strategy tool #6 — submission review (SWE-agent `review_on_submit` deterministic
 * check), as a PURE verdict over a final candidate patch.
 *
 * SWE-agent reviews a submission before accepting it; its deterministic core is a
 * TEST-REVERT (a patch that "passed" by editing the tests is gaming). In THIS
 * codebase the test-revert is ALREADY done unconditionally — `sourceOnlyDiff`
 * (snapshot.ts) strips every test/repro/binary section on EVERY capture path
 * (`gitStageAndDiffCached`). So this tool does NOT re-implement the strip; it is the
 * observable VERDICT layer the strip never surfaced: classify a captured patch and
 * (behind a knob) act as a defense-in-depth guard that the patch is genuinely
 * source-only — catching a regression in the strip, or a future path that bypasses
 * it, instead of silently grading a test-edited patch.
 *
 * REUSE, NOT REBUILD: `isTestFilePath` (shared SSOT) + `patchFiles` (diff→files) are
 * the existing primitives; this module only COMPOSES them into a verdict. NO-LEAK:
 * inspects only the patch text. Pure — no I/O, no clock/random.
 */

import { isTestFilePath } from "@/shared/test-path"
import { patchFiles } from "./closure-diagnostics-io"

export type SubmissionVerdict = "clean" | "empty" | "test-edits"

export interface SubmissionReview {
  /** No source edits at all (whitespace-only / empty diff) — a non-submission. */
  readonly isEmpty: boolean
  /** Test/conftest files the patch touches (should be EMPTY after the strip). */
  readonly testFilesTouched: readonly string[]
  /** Non-test files the patch touches. */
  readonly sourceFilesTouched: readonly string[]
  /** True iff the patch touches ≥1 file and none of them is a test file. */
  readonly isSourceOnly: boolean
  readonly verdict: SubmissionVerdict
}

/**
 * Review a final/candidate unified diff. `test-edits` ⇒ the patch still touches a
 * test file (a strip regression or a bypassed path — the gaming SWE-agent reverts);
 * `empty` ⇒ no files touched (a non-fix); `clean` ⇒ ≥1 source file and no test file.
 */
export const reviewSubmission = (patch: string): SubmissionReview => {
  const files = patchFiles(patch)
  const testFilesTouched = files.filter(isTestFilePath)
  const sourceFilesTouched = files.filter((f) => !isTestFilePath(f))
  const isEmpty = files.length === 0
  const verdict: SubmissionVerdict =
    testFilesTouched.length > 0 ? "test-edits" : isEmpty ? "empty" : "clean"
  return {
    isEmpty,
    testFilesTouched,
    sourceFilesTouched,
    isSourceOnly: !isEmpty && testFilesTouched.length === 0,
    verdict,
  }
}
