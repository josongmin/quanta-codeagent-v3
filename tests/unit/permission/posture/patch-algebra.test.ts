/**
 * RFC-05 E1 hellgate — LOSSLESS PATCH ALGEBRA.
 *
 * RED rails pinned here:
 *   (a) applying a partial preset/patch drops unspecified sandbox/reviewer/
 *       question fields;
 *   (b) the custom roundtrip is lossy.
 *
 * The property tests iterate EVERY offered preset over ALL 64 complete records
 * and assert every unmentioned field survives (non-vacuous: the naive
 * implementation that drops unmentioned fields fails these).
 */

import { describe, expect, test } from "bun:test"
import { APPROVAL_LADDER } from "../../../../src/permission/approval-ladder"
import {
  applyPatch,
  applyPreset,
  OFFERED_PRESETS,
  presetPatch,
  serializePosture,
  toCustomPatch,
} from "../../../../src/permission/posture/presets"
import type { PosturePatch } from "../../../../src/permission/posture/types"
import { allCompleteRecords, DISTINCT_BASE, nthCompleteRecord } from "./fixtures"

const RECORDS = allCompleteRecords()

describe("applyPreset — lossless over ALL complete records (RED rail a)", () => {
  test("preserves the unmentioned question knob (askOutsidePlan) for every preset", () => {
    for (const record of RECORDS) {
      for (const preset of OFFERED_PRESETS) {
        const next = applyPreset(record, preset)
        // The question knob is NEVER named by a preset -> must survive verbatim.
        expect(next.askOutsidePlan).toBe(record.askOutsidePlan)
      }
    }
  })

  test("sets exactly the three ThreadPermission fields the preset governs", () => {
    for (const record of RECORDS) {
      for (const preset of OFFERED_PRESETS) {
        const next = applyPreset(record, preset)
        // The three governed fields equal the SSOT rung; the patch is exactly
        // that rung's ThreadPermission fields (askOutsidePlan omitted).
        expect(next.threadPermission).toEqual(APPROVAL_LADDER[preset])
        expect(presetPatch(preset)).toEqual({
          approvalPolicy: APPROVAL_LADDER[preset].approvalPolicy,
          approvalsReviewer: APPROVAL_LADDER[preset].approvalsReviewer,
          sandboxPolicy: APPROVAL_LADDER[preset].sandboxPolicy,
        })
      }
    }
  })

  test("produces a COMPLETE record (no field left undefined)", () => {
    for (const record of RECORDS) {
      for (const preset of OFFERED_PRESETS) {
        const next = applyPreset(record, preset)
        expect(next.threadPermission.approvalPolicy).toBeDefined()
        expect(next.threadPermission.approvalsReviewer).toBeDefined()
        expect(next.threadPermission.sandboxPolicy).toBeDefined()
        expect(typeof next.askOutsidePlan).toBe("boolean")
        // The mode axis is a first-class complete-record field (preset-agnostic).
        expect(next.mode).toBeDefined()
      }
    }
  })
})

describe("applyPatch — arbitrary partial patches preserve omitted fields (RED rail a)", () => {
  // A patch that omits each field in turn; every omitted field must be
  // preserved from the base record.
  const partialPatches: ReadonlyArray<{ label: string; patch: PosturePatch }> = [
    { label: "approvalPolicy only", patch: { approvalPolicy: "always" } },
    { label: "approvalsReviewer only", patch: { approvalsReviewer: "agent" } },
    { label: "sandbox only", patch: { sandboxPolicy: { type: "read-only" } } },
    { label: "askOutsidePlan=false only", patch: { askOutsidePlan: false } },
    { label: "askOutsidePlan=true only", patch: { askOutsidePlan: true } },
    // RFC-05 E2b — mode-only patches: setting mode must not touch other fields,
    // and every OTHER partial patch must PRESERVE the base's mode.
    { label: "mode=bypass only", patch: { mode: "bypass" } },
    { label: "mode=acceptEdits only", patch: { mode: "acceptEdits" } },
    { label: "mode=default only", patch: { mode: "default" } },
    { label: "mode=auto only", patch: { mode: "auto" } },
    { label: "empty patch (identity)", patch: {} },
  ]

  test("every field the patch omits equals the base record's field", () => {
    for (const record of RECORDS) {
      for (const { patch } of partialPatches) {
        const next = applyPatch(record, patch)
        expect(next.threadPermission.approvalPolicy).toBe(
          patch.approvalPolicy ?? record.threadPermission.approvalPolicy,
        )
        expect(next.threadPermission.approvalsReviewer).toBe(
          patch.approvalsReviewer ?? record.threadPermission.approvalsReviewer,
        )
        expect(next.threadPermission.sandboxPolicy).toEqual(
          patch.sandboxPolicy ?? record.threadPermission.sandboxPolicy,
        )
        expect(next.askOutsidePlan).toBe(patch.askOutsidePlan ?? record.askOutsidePlan)
        // The mode axis obeys the SAME lossless rule: an omitted mode is
        // preserved from the base; a named mode wins.
        expect(next.mode).toBe(patch.mode ?? record.mode)
      }
    }
  })

  test("the empty patch is the identity (roundtrip-equal to the base)", () => {
    for (const record of RECORDS) {
      expect(serializePosture(applyPatch(record, {}))).toBe(serializePosture(record))
    }
  })

  test("a patched askOutsidePlan:false wins over a base of true (?? not ||)", () => {
    const base = { ...nthCompleteRecord(0), askOutsidePlan: true }
    expect(applyPatch(base, { askOutsidePlan: false }).askOutsidePlan).toBe(false)
  })
})

describe("custom roundtrip is lossless (RED rail b)", () => {
  test("applyPatch(anyOtherBase, toCustomPatch(r)) reproduces r exactly", () => {
    for (const record of RECORDS) {
      // Apply the captured custom patch over a DISTINCT base: if the roundtrip
      // were lossy, the base's fields would leak through and the serialization
      // would differ.
      const roundTripped = applyPatch(DISTINCT_BASE, toCustomPatch(record))
      expect(serializePosture(roundTripped)).toBe(serializePosture(record))
    }
  })
})
