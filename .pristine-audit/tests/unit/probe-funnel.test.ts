/**
 * Probe funnel detector — observes 3-stage localization adherence from a
 * trajectory's tool_call sequence (R-Phase8 #2). NON-authoritative: a low
 * stage is a data point, not a defect.
 */
import { describe, expect, test } from "bun:test"
import type { TrajectoryEvent } from "@/shared"
import { observeFunnel, renderFunnel } from "../../src/apps/probe/funnel"

/** Build a minimal tool_call event for a tool name. */
const call = (seq: number, name: string): TrajectoryEvent =>
  ({ seq, kind: "tool_call", data: { name } }) as unknown as TrajectoryEvent

const other = (seq: number, kind: string): TrajectoryEvent =>
  ({ seq, kind, data: {} }) as unknown as TrajectoryEvent

describe("observeFunnel — stage progression", () => {
  test("full file→function→edit funnel → followed, stage 3", () => {
    const r = observeFunnel([call(1, "localize"), call(2, "read"), call(3, "lsp_references")])
    expect(r.followed).toBe(true)
    expect(r.stagesReached).toBe(3)
    expect(r.sequence).toEqual(["localize", "read", "lsp_references"])
  })

  test("only stage 1 (localize, never read) → reached 1, not followed", () => {
    const r = observeFunnel([call(1, "localize"), call(2, "edit")])
    expect(r.followed).toBe(false)
    expect(r.stagesReached).toBe(1)
  })

  test("stage 2 before stage 1 does NOT advance (monotonic ordering)", () => {
    // lsp_references (S3) fires first with no prior S1/S2 → stays 0-then-1.
    const r = observeFunnel([
      call(1, "lsp_references"), // S3 but no S1 yet → no advance
      call(2, "localize"), // S1 → reached 1
      call(3, "read"), // S2 → reached 2
    ])
    expect(r.stagesReached).toBe(2)
    expect(r.followed).toBe(false)
    // sequence still records the out-of-order S3 call.
    expect(r.sequence).toEqual(["lsp_references", "localize", "read"])
  })

  test("no funnel tools at all → reached 0", () => {
    const r = observeFunnel([call(1, "edit"), call(2, "bash"), other(3, "assistant_text")])
    expect(r.stagesReached).toBe(0)
    expect(r.sequence).toEqual([])
    expect(r.note).toContain("no localization-funnel tools")
  })

  test("file_tree_summary + lsp_document_symbol + parse_test_failure → full funnel", () => {
    const r = observeFunnel([
      call(1, "file_tree_summary"),
      call(2, "lsp_document_symbol"),
      call(3, "parse_test_failure"),
    ])
    expect(r.followed).toBe(true)
    expect(r.stagesReached).toBe(3)
  })

  test("non-tool_call events ignored", () => {
    const r = observeFunnel([
      other(1, "turn_start"),
      call(2, "localize"),
      other(3, "assistant_text"),
      call(4, "read"),
      other(5, "tool_result"),
      call(6, "lsp_references"),
    ])
    expect(r.followed).toBe(true)
  })

  test("grep classified Stage 1 (initial candidate sweep)", () => {
    const r = observeFunnel([call(1, "grep"), call(2, "read"), call(3, "lsp_definition")])
    expect(r.stagesReached).toBe(3)
  })

  test("search_codebase classified Stage 1 (broad repo search)", () => {
    const r = observeFunnel([
      call(1, "search_codebase"),
      call(2, "read"),
      call(3, "lsp_definition"),
    ])
    expect(r.stagesReached).toBe(3)
    expect(r.sequence).toEqual(["search_codebase", "read", "lsp_definition"])
  })
})

describe("renderFunnel", () => {
  test("FOLLOWED render shows sequence + stage", () => {
    const out = renderFunnel(
      observeFunnel([call(1, "localize"), call(2, "read"), call(3, "lsp_references")]),
    )
    expect(out).toContain("FOLLOWED")
    expect(out).toContain("stage 3/3")
    expect(out).toContain("localize → read → lsp_references")
  })

  test("partial render shows hedged note (not a defect)", () => {
    const out = renderFunnel(observeFunnel([call(1, "localize")]))
    expect(out).toContain("partial")
    expect(out.toLowerCase()).toContain("not a defect")
  })

  test("empty sequence renders (none)", () => {
    const out = renderFunnel(observeFunnel([]))
    expect(out).toContain("(none)")
  })
})
