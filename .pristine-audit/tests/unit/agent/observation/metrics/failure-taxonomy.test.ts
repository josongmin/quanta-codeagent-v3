import { beforeEach, describe, expect, test } from "bun:test"
import { classifyFailure } from "@/agent/observation/metrics"
import { bash, bundle, edit, emptyBundle, owner, read, resetSeq } from "./fixtures"

beforeEach(resetSeq)

const GOLD_A = "pkg/core/a.py"
const GOLD_B = "pkg/core/b.py"
const WRONG = "pkg/other/z.py"
const UNRELATED = "pkg/misc/scratch.py"

describe("classifyFailure — matched labels (0..n)", () => {
  test("LOCALIZATION_WRONG_OWNER: edited only files absent from the success patch", () => {
    const labels = classifyFailure([edit(WRONG)], emptyBundle(), {
      passed: false,
      successPatchFiles: [GOLD_A],
    })
    expect(labels).toContain("LOCALIZATION_WRONG_OWNER")
  })

  test("HINT_OVERTRUST: followed a suggested owner WITHOUT verify and it was wrong", () => {
    const b = bundle([owner(WRONG)]) // hint points at WRONG
    const labels = classifyFailure([edit(WRONG)], b, {
      passed: false,
      successPatchFiles: [GOLD_A],
    })
    expect(labels).toContain("HINT_OVERTRUST")
  })

  test("HINT_OVERTRUST does NOT fire when the model verified the suggested owner first", () => {
    const b = bundle([owner(WRONG)])
    const labels = classifyFailure([read(WRONG), edit(WRONG)], b, {
      passed: false,
      successPatchFiles: [GOLD_A],
    })
    expect(labels).not.toContain("HINT_OVERTRUST")
  })

  test("PATCH_TOO_NARROW: failed, edited a strict subset of the multi-file patch", () => {
    const labels = classifyFailure([edit(GOLD_A)], emptyBundle(), {
      passed: false,
      successPatchFiles: [GOLD_A, GOLD_B],
    })
    expect(labels).toContain("PATCH_TOO_NARROW")
  })

  test("PATCH_TOO_WIDE: edited more distinct files than the patch touched", () => {
    const labels = classifyFailure([edit(GOLD_A), edit(WRONG), edit(UNRELATED)], emptyBundle(), {
      passed: false,
      successPatchFiles: [GOLD_A],
    })
    expect(labels).toContain("PATCH_TOO_WIDE")
  })

  test("UNRELATED_DIFF: touched a file neither suggested nor in the patch (even on pass)", () => {
    const labels = classifyFailure([edit(GOLD_A), edit(UNRELATED)], emptyBundle(), {
      passed: true,
      successPatchFiles: [GOLD_A],
    })
    expect(labels).toContain("UNRELATED_DIFF")
  })

  test("STOP_TOO_EARLY: failed with no edit at all", () => {
    const labels = classifyFailure([read(GOLD_A)], emptyBundle(), {
      passed: false,
      successPatchFiles: [GOLD_A],
    })
    expect(labels).toContain("STOP_TOO_EARLY")
  })

  test("STOP_TOO_LATE: failed while still churning verify/bash at the wall", () => {
    const events = [edit(GOLD_A), bash("pytest"), bash("pytest"), bash("pytest"), bash("pytest")]
    const labels = classifyFailure(events, emptyBundle(), {
      passed: false,
      successPatchFiles: [GOLD_A],
    })
    expect(labels).toContain("STOP_TOO_LATE")
  })

  test("clean pass with edits only in the patch ⇒ NO labels", () => {
    const labels = classifyFailure([edit(GOLD_A), edit(GOLD_B)], emptyBundle(), {
      passed: true,
      successPatchFiles: [GOLD_A, GOLD_B],
    })
    expect(labels).toEqual([])
  })

  test("multiple modes can co-occur (wrong owner + unrelated)", () => {
    const b = emptyBundle()
    const labels = classifyFailure([edit(WRONG)], b, {
      passed: false,
      successPatchFiles: [GOLD_A],
    })
    // wrong owner (no patch hit) AND that file is unrelated (not suggested, not in patch)
    expect(labels).toContain("LOCALIZATION_WRONG_OWNER")
    expect(labels).toContain("UNRELATED_DIFF")
  })

  test("unknown patch ⇒ patch-dependent labels are suppressed (no guess)", () => {
    const labels = classifyFailure([edit(WRONG)], emptyBundle(), { passed: false })
    expect(labels).not.toContain("LOCALIZATION_WRONG_OWNER")
    expect(labels).not.toContain("PATCH_TOO_NARROW")
    expect(labels).not.toContain("PATCH_TOO_WIDE")
  })
})
