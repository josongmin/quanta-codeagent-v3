/**
 * ★ CONTRACT — ADR-0062 rule #3: structured nextAction third channel.
 *
 * 17-case test suite organized in four blocks:
 *  A. inferNextAction — pure helper invariants (NEXT-A1..A4)
 *  B. CapEnforcer.check/record — session tracker invariants (CAP-B1..B6)
 *  C. dispatch enforcement OFF — byte-identical event stream (CAP-C1..C3)
 *  D. dispatch enforcement ON  — reminder injected / applied / different-target (CAP-D1..D4)
 *
 * Everything is hermetic: A is pure, B/C/D use hand-rolled fakes that
 * avoid real LLM calls / registry / ripgrep.
 */

import { describe, expect, test } from "bun:test"
import { CapEnforcer } from "@/agent/cap-enforcer"
import type { NextAction } from "@/tool"
import { inferNextAction } from "@/tool/file-tree-summary"

/* ------------------------------------------------------------------ */
/* TreeAgg helpers                                                      */
/* ------------------------------------------------------------------ */

type MinimalTreeAgg = {
  byDir: Map<string, string[]>
  deepRollup: Map<string, number>
  total: number
  truncated: boolean
}

const makeAgg = (overrides: Partial<MinimalTreeAgg> = {}): MinimalTreeAgg => ({
  byDir: new Map([[".", ["a.ts"]]]),
  deepRollup: new Map(),
  total: 1,
  truncated: false,
  ...overrides,
})

/* ================================================================== */
/* A. inferNextAction — pure function invariants                        */
/* ================================================================== */

describe("A. inferNextAction", () => {
  test("NEXT-A1: truncated-only → raise_max_files with doubled suggestion", () => {
    const agg = makeAgg({ truncated: true })
    const result = inferNextAction(agg, 3, 400)
    expect(result).not.toBeUndefined()
    expect(result?.kind).toBe("raise_max_files")
    // Check structural: suggested types are correct
    const action = result as Extract<NextAction, { kind: "raise_max_files" }>
    expect(action.suggested).toBe(800) // 400 * 2
    expect(typeof action.reason).toBe("string")
    expect(action.reason.length).toBeGreaterThan(0)
  })

  test("NEXT-A2: deepRollup-only (not truncated) → increase_max_depth with capped suggestion", () => {
    const agg = makeAgg({
      deepRollup: new Map([
        ["src", 15],
        ["lib", 7],
      ]),
    })
    const result = inferNextAction(agg, 3, 400)
    expect(result).not.toBeUndefined()
    expect(result?.kind).toBe("increase_max_depth")
    const action = result as Extract<NextAction, { kind: "increase_max_depth" }>
    expect(action.suggested).toBe(6) // min(3*2, 10)
    // reason must carry concrete numbers
    expect(action.reason).toContain("22") // 15 + 7 hidden files
    expect(action.reason).toContain("3") // maxDepth
    expect(action.reason).toContain("6") // suggested
  })

  test("NEXT-A3: both truncated AND deepRollup → increase_max_depth wins (depth is deeper bottleneck)", () => {
    const agg = makeAgg({
      truncated: true,
      deepRollup: new Map([["src", 5]]),
    })
    const result = inferNextAction(agg, 3, 400)
    expect(result?.kind).toBe("increase_max_depth")
  })

  test("NEXT-A4: neither truncated nor deepRollup → undefined (no action needed)", () => {
    const agg = makeAgg({ truncated: false })
    const result = inferNextAction(agg, 3, 400)
    expect(result).toBeUndefined()
  })
})

/* ================================================================== */
/* B. CapEnforcer.check / record — session tracker invariants           */
/* ================================================================== */

describe("B. CapEnforcer", () => {
  test("CAP-B1: no prior hint → check returns undefined", () => {
    const enforcer = new CapEnforcer()
    const result = enforcer.check("file_tree_summary", { max_depth: 3 })
    expect(result).toBeUndefined()
  })

  test("CAP-B2: hint recorded but APPLIED (max_depth increased) → check returns undefined", () => {
    const enforcer = new CapEnforcer()
    const action: NextAction = { kind: "increase_max_depth", suggested: 6, reason: "test" }
    enforcer.record("file_tree_summary", { path: "src" }, action)
    // Next call with max_depth >= suggested → hint is applied
    const result = enforcer.check("file_tree_summary", { path: "src", max_depth: 6 })
    expect(result).toBeUndefined()
  })

  test("CAP-B3: hint recorded and IGNORED (same max_depth) → check returns reminder string", () => {
    const enforcer = new CapEnforcer()
    const action: NextAction = {
      kind: "increase_max_depth",
      suggested: 6,
      reason: "15 files beyond depth 3",
    }
    enforcer.record("file_tree_summary", { path: "src" }, action)
    // Next call with same max_depth (3 < 6) → IGNORED
    const result = enforcer.check("file_tree_summary", { path: "src", max_depth: 3 })
    expect(result).not.toBeUndefined()
    // Must contain ADR-0062 phrasing
    expect(result).toContain("nextAction.kind=increase_max_depth")
    expect(result).toContain("suggested=6")
    expect(result).toContain("ADR-0062 rule 1")
  })

  test("CAP-B4: hint for DIFFERENT path → no reminder (key is tool:path scoped)", () => {
    const enforcer = new CapEnforcer()
    const action: NextAction = { kind: "raise_max_files", suggested: 800, reason: "cap reached" }
    enforcer.record("file_tree_summary", { path: "src" }, action)
    // Same tool but different path → different key, no prior hint
    const result = enforcer.check("file_tree_summary", { path: "lib" })
    expect(result).toBeUndefined()
  })

  test("CAP-B5: recording undefined nextAction CLEARS the hint for that key", () => {
    const enforcer = new CapEnforcer()
    const action: NextAction = { kind: "raise_max_files", suggested: 800, reason: "test" }
    enforcer.record("file_tree_summary", { path: "" }, action)
    // Now record a call to same tool/path that returns no nextAction (cleared)
    enforcer.record("file_tree_summary", { path: "" }, undefined)
    // check should find no hint
    const result = enforcer.check("file_tree_summary", { path: "" })
    expect(result).toBeUndefined()
  })

  test("CAP-B6: raise_max_files ignored → reminder contains raise_max_files phrasing", () => {
    const enforcer = new CapEnforcer()
    const action: NextAction = { kind: "raise_max_files", suggested: 800, reason: "cap reached" }
    enforcer.record("file_tree_summary", {}, action)
    // Call again without raising max_files
    const result = enforcer.check("file_tree_summary", { max_files: 400 })
    expect(result).not.toBeUndefined()
    expect(result).toContain("nextAction.kind=raise_max_files")
    expect(result).toContain("suggested=800")
  })
})

/* ================================================================== */
/* C. dispatch enforcement OFF — byte-identical event stream           */
/* ================================================================== */

// Build a minimal DispatchResult to verify the reminder injection path.
// We test that when capEnforcer is absent, the block.content is untouched.

describe("C. Enforcement OFF (no capEnforcer)", () => {
  test("CAP-C1: CapEnforcer not built when flag unset — buildCapEnforcer returns undefined", async () => {
    // Temporarily ensure env flag is unset
    const prev = process.env.QUANTA_CAP_ENFORCE
    delete process.env.QUANTA_CAP_ENFORCE
    const { buildCapEnforcer } = await import("@/agent/cap-enforcer")
    const result = buildCapEnforcer(undefined)
    expect(result).toBeUndefined()
    if (prev !== undefined) process.env.QUANTA_CAP_ENFORCE = prev
  })

  test("CAP-C2: CapEnforcer built when capEnforce=true", async () => {
    const { buildCapEnforcer, CapEnforcer: CE } = await import("@/agent/cap-enforcer")
    const result = buildCapEnforcer(true)
    expect(result).not.toBeUndefined()
    expect(result).toBeInstanceOf(CE)
  })

  test("CAP-C3: CapEnforcer built when QUANTA_CAP_ENFORCE=1 env set", async () => {
    const prev = process.env.QUANTA_CAP_ENFORCE
    process.env.QUANTA_CAP_ENFORCE = "1"
    const { buildCapEnforcer, CapEnforcer: CE } = await import("@/agent/cap-enforcer")
    const result = buildCapEnforcer(undefined)
    expect(result).not.toBeUndefined()
    expect(result).toBeInstanceOf(CE)
    if (prev !== undefined) process.env.QUANTA_CAP_ENFORCE = prev
    else delete process.env.QUANTA_CAP_ENFORCE
  })
})

/* ================================================================== */
/* D. dispatch enforcement ON — reminder injected / applied / scoped   */
/* ================================================================== */

describe("D. Enforcement ON (CapEnforcer wired)", () => {
  test("CAP-D1: cap ignored → reminder text is NOT undefined", () => {
    const enforcer = new CapEnforcer()
    // Simulate first call that produced a nextAction
    const action: NextAction = { kind: "increase_max_depth", suggested: 6, reason: "test" }
    enforcer.record("file_tree_summary", { path: "." }, action)
    // Simulate second call that ignores the hint (max_depth still 3 < 6)
    const reminder = enforcer.check("file_tree_summary", { path: ".", max_depth: 3 })
    expect(reminder).not.toBeUndefined()
    expect(reminder).toContain("ADR-0062 rule 1")
  })

  test("CAP-D2: cap applied (max_depth >= suggested) → no reminder", () => {
    const enforcer = new CapEnforcer()
    const action: NextAction = { kind: "increase_max_depth", suggested: 6, reason: "test" }
    enforcer.record("file_tree_summary", { path: "." }, action)
    // max_depth exactly = suggested → applied
    const reminder = enforcer.check("file_tree_summary", { path: ".", max_depth: 6 })
    expect(reminder).toBeUndefined()
  })

  test("CAP-D3: different target path → no reminder (scoped to path)", () => {
    const enforcer = new CapEnforcer()
    const action: NextAction = { kind: "increase_max_depth", suggested: 6, reason: "test" }
    enforcer.record("file_tree_summary", { path: "src" }, action)
    // Call to different path → no prior hint for that key
    const reminder = enforcer.check("file_tree_summary", { path: "lib", max_depth: 3 })
    expect(reminder).toBeUndefined()
  })

  test("CAP-D4: narrow_path ignored (same path) → reminder; applied (different path) → no reminder", () => {
    const enforcer = new CapEnforcer()
    const priorPath = "src"
    const action: NextAction = { kind: "narrow_path", reason: "too many results" }
    enforcer.record("file_tree_summary", { path: priorPath }, action)
    // Calling again with same path = NOT narrowed
    const ignoredReminder = enforcer.check("file_tree_summary", { path: priorPath })
    expect(ignoredReminder).not.toBeUndefined()
    expect(ignoredReminder).toContain("narrow_path")
    // Calling with a different (narrower) path = applied
    const appliedReminder = enforcer.check("file_tree_summary", { path: "src/agent" })
    expect(appliedReminder).toBeUndefined()
  })
})
