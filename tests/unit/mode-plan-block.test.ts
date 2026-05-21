/**
 * ADR-0036: dispatch-seam plan-mode block — combinatorial coverage.
 *
 * Plan × {mutating, non-mutating, unknown} × every classified tool name.
 * The cluster's hard rule is "no silent allow" — every cell must produce
 * the documented outcome.
 */

import { describe, expect, test } from "bun:test"
import { checkDispatchAllowed } from "@/agent/dispatch-seam-guard"
import {
  assertNotMutatingInPlanMode,
  type CollaborationMode,
  isMutatingTool,
  PlanModeMutatingBlockedError,
  planModeMutatingTable,
  UnknownToolError,
} from "@/agent/mode"

const PLAN: CollaborationMode = "plan"
const DEFAULT: CollaborationMode = "default"

describe("plan-mode dispatch block (ADR-0036) — combinatorial", () => {
  const table = planModeMutatingTable()
  const mutating = Object.entries(table)
    .filter(([, k]) => k !== null)
    .map(([n]) => n)
  const readOnly = Object.entries(table)
    .filter(([, k]) => k === null)
    .map(([n]) => n)

  test("baseline: table has both mutating and read-only tools", () => {
    expect(mutating.length).toBeGreaterThanOrEqual(5)
    expect(readOnly.length).toBeGreaterThanOrEqual(8)
  })

  // -------- assertNotMutatingInPlanMode ------------------------------
  for (const name of mutating) {
    test(`plan mode + mutating "${name}" ⇒ blocked`, () => {
      expect(() => assertNotMutatingInPlanMode(PLAN, name)).toThrow(PlanModeMutatingBlockedError)
    })
    test(`default mode + mutating "${name}" ⇒ allowed`, () => {
      expect(() => assertNotMutatingInPlanMode(DEFAULT, name)).not.toThrow()
    })
  }
  for (const name of readOnly) {
    test(`plan mode + read-only "${name}" ⇒ allowed`, () => {
      expect(() => assertNotMutatingInPlanMode(PLAN, name)).not.toThrow()
    })
    test(`default mode + read-only "${name}" ⇒ allowed`, () => {
      expect(() => assertNotMutatingInPlanMode(DEFAULT, name)).not.toThrow()
    })
  }

  test("plan mode + unknown tool ⇒ throws UnknownToolError (no silent allow)", () => {
    expect(() => assertNotMutatingInPlanMode(PLAN, "made_up_tool")).toThrow(UnknownToolError)
  })
  test("default mode + unknown tool ⇒ does NOT throw (default mode short-circuits)", () => {
    // Documented behavior: default mode allows everything without consulting
    // the table, so an unknown tool name passes through the assertion. The
    // *dispatch-seam guard* still surfaces UnknownToolError via the table
    // lookup path because it consults `isMutatingTool` independently — see
    // the dedicated test below for that path.
    expect(() => assertNotMutatingInPlanMode(DEFAULT, "made_up_tool")).not.toThrow()
  })

  test("isMutatingTool throws UnknownToolError for unrecognized tool (no silent allow)", () => {
    expect(() => isMutatingTool("made_up_tool")).toThrow(UnknownToolError)
  })

  test("isMutatingTool is consistent with table for known tools", () => {
    for (const [name, kind] of Object.entries(table)) {
      expect(isMutatingTool(name)).toBe(kind !== null)
    }
  })

  // -------- checkDispatchAllowed -------------------------------------
  test("dispatch guard returns ok:false with PlanModeMutatingBlockedError for write", () => {
    const r = checkDispatchAllowed({ collaborationMode: PLAN }, { name: "write" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBeInstanceOf(PlanModeMutatingBlockedError)
      expect((r.reason as PlanModeMutatingBlockedError).mutatingKind).toBe("write_filesystem")
    }
  })

  test("dispatch guard returns ok:true for read in plan mode", () => {
    const r = checkDispatchAllowed({ collaborationMode: PLAN }, { name: "read" })
    expect(r.ok).toBe(true)
  })

  test("dispatch guard returns ok:true for any mutating tool in default mode", () => {
    for (const name of mutating) {
      const r = checkDispatchAllowed({ collaborationMode: DEFAULT }, { name })
      expect(r.ok).toBe(true)
    }
  })

  test("dispatch guard returns ok:false with UnknownToolError for unrecognized tool", () => {
    const r = checkDispatchAllowed({ collaborationMode: PLAN }, { name: "unknown_x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBeInstanceOf(UnknownToolError)
  })

  test("dispatch guard surfaces tool name in deny error message", () => {
    const r = checkDispatchAllowed({ collaborationMode: PLAN }, { name: "bash" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason.message).toContain("bash")
      expect(r.reason.message).toContain("plan")
    }
  })
})
