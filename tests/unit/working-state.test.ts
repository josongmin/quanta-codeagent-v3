import { describe, expect, test } from "bun:test"
import {
  createWorkingStateSession,
  emptyWorkingState,
  renderWorkingStateBlock,
  type WorkingState,
} from "@/agent"

describe("emptyWorkingState", () => {
  test("returns a state with all fields empty", () => {
    const s = emptyWorkingState()
    expect(s.ownerShortlist).toEqual([])
    expect(s.hypothesis).toBeUndefined()
    expect(s.blockers).toEqual([])
    expect(s.nextStepQueue).toEqual([])
    expect(s.deferredValidation).toEqual([])
  })

  test("each call returns a fresh instance (no shared arrays)", () => {
    const a = emptyWorkingState()
    const b = emptyWorkingState()
    a.ownerShortlist.push({ file: "x.ts", reason: "test" })
    expect(b.ownerShortlist).toEqual([])
  })
})

describe("renderWorkingStateBlock", () => {
  test("empty state returns undefined (no clutter when nothing to carry)", () => {
    expect(renderWorkingStateBlock(emptyWorkingState())).toBeUndefined()
  })

  test("hypothesis containing only whitespace is treated as empty", () => {
    const s: WorkingState = { ...emptyWorkingState(), hypothesis: "   " }
    expect(renderWorkingStateBlock(s)).toBeUndefined()
  })

  test("renders owner shortlist with file and reason", () => {
    const s: WorkingState = {
      ...emptyWorkingState(),
      ownerShortlist: [{ file: "a.ts", reason: "primary" }],
    }
    const out = renderWorkingStateBlock(s)
    expect(out).toBeDefined()
    expect(out).toContain("## Working state")
    expect(out).toContain("### Owner shortlist")
    expect(out).toContain("a.ts")
    expect(out).toContain("primary")
  })

  test("renders hypothesis as its own sub-section", () => {
    const s: WorkingState = {
      ...emptyWorkingState(),
      hypothesis: "the bug is in the dispatcher",
    }
    const out = renderWorkingStateBlock(s)
    expect(out).toBeDefined()
    expect(out).toContain("## Working state")
    expect(out).toContain("### Hypothesis")
    expect(out).toContain("the bug is in the dispatcher")
    // Sub-sections for OTHER fields must not appear when those fields are empty.
    expect(out).not.toContain("### Owner shortlist")
    expect(out).not.toContain("### Blockers")
    expect(out).not.toContain("### Next steps")
    expect(out).not.toContain("### Deferred validation")
  })

  test("renders blockers with surface tag", () => {
    const s: WorkingState = {
      ...emptyWorkingState(),
      blockers: [{ what: "type error in dispatch.ts", surface: "type" }],
    }
    const out = renderWorkingStateBlock(s)
    expect(out).toContain("### Blockers")
    expect(out).toContain("[type] type error in dispatch.ts")
  })

  test("renders next-step queue marking deferred steps", () => {
    const s: WorkingState = {
      ...emptyWorkingState(),
      nextStepQueue: [
        { what: "wire the meta-tool" },
        { what: "polish edge cases", deferred: true },
      ],
    }
    const out = renderWorkingStateBlock(s)
    expect(out).toContain("### Next steps")
    expect(out).toContain("- wire the meta-tool")
    expect(out).toContain("- polish edge cases (deferred)")
  })

  test("renders deferred validation with rail and reason", () => {
    const s: WorkingState = {
      ...emptyWorkingState(),
      deferredValidation: [{ rail: "pytest", reason: "host has no python yet" }],
    }
    const out = renderWorkingStateBlock(s)
    expect(out).toContain("### Deferred validation")
    expect(out).toContain("pytest: host has no python yet")
  })

  test("starts with the canonical heading", () => {
    const s: WorkingState = {
      ...emptyWorkingState(),
      ownerShortlist: [{ file: "a.ts", reason: "p" }],
    }
    expect(renderWorkingStateBlock(s)?.startsWith("## Working state")).toBe(true)
  })

  test("uses sub-headers for each non-empty field", () => {
    const s: WorkingState = {
      ownerShortlist: [{ file: "a.ts", reason: "p" }],
      hypothesis: "h",
      blockers: [{ what: "b", surface: "wire" }],
      nextStepQueue: [{ what: "n" }],
      deferredValidation: [{ rail: "tsc", reason: "later" }],
    }
    const out = renderWorkingStateBlock(s) ?? ""
    expect(out).toContain("### Owner shortlist")
    expect(out).toContain("### Hypothesis")
    expect(out).toContain("### Blockers")
    expect(out).toContain("### Next steps")
    expect(out).toContain("### Deferred validation")
  })
})

describe("createWorkingStateSession", () => {
  test("initial snapshot is empty", () => {
    const s = createWorkingStateSession()
    expect(s.snapshot()).toEqual(emptyWorkingState())
  })

  test("mutate replaces ownerShortlist (not appends)", () => {
    const s = createWorkingStateSession()
    s.mutate({ ownerShortlist: [{ file: "a.ts", reason: "first" }] })
    s.mutate({ ownerShortlist: [{ file: "b.ts", reason: "second" }] })
    expect(s.snapshot().ownerShortlist).toEqual([{ file: "b.ts", reason: "second" }])
  })

  test("absent fields preserve existing state", () => {
    const s = createWorkingStateSession()
    s.mutate({
      ownerShortlist: [{ file: "a.ts", reason: "p" }],
      hypothesis: "h",
    })
    s.mutate({ blockers: [{ what: "b", surface: "wire" }] })
    const snap = s.snapshot()
    expect(snap.ownerShortlist).toHaveLength(1)
    expect(snap.hypothesis).toBe("h")
    expect(snap.blockers).toHaveLength(1)
  })

  test("hypothesis: null clears the field", () => {
    const s = createWorkingStateSession()
    s.mutate({ hypothesis: "the cause is X" })
    expect(s.snapshot().hypothesis).toBe("the cause is X")
    s.mutate({ hypothesis: null })
    expect(s.snapshot().hypothesis).toBeUndefined()
  })

  test("empty patch leaves state unchanged", () => {
    const s = createWorkingStateSession()
    s.mutate({ ownerShortlist: [{ file: "a.ts", reason: "p" }] })
    const before = JSON.stringify(s.snapshot())
    s.mutate({})
    expect(JSON.stringify(s.snapshot())).toBe(before)
  })

  // V3-F2 fix: snapshot() returns a DEEP COPY, not a live alias. The R3 fix
  // explicitly clones inner entries (`o => ({...o})`) so a caller can hold a
  // snapshot across a `mutate(...)` without race. Reverting to `return state`
  // (the pre-R3 shape) would silently re-introduce a concurrent-reader race.
  // These two tests pin the deep-copy contract.
  test("snapshot is decoupled from later mutations (outer-array alias check)", () => {
    const s = createWorkingStateSession()
    s.mutate({ ownerShortlist: [{ file: "a.ts", reason: "first" }] })
    const snap = s.snapshot()
    expect(snap.ownerShortlist).toHaveLength(1)
    // Mutate AFTER snapshot — the snapshot must NOT see the new state.
    s.mutate({ ownerShortlist: [{ file: "b.ts", reason: "later" }] })
    expect(snap.ownerShortlist).toHaveLength(1)
    expect(snap.ownerShortlist[0]?.file).toBe("a.ts")
  })

  test("snapshot is decoupled from later mutations (inner-object alias check)", () => {
    const s = createWorkingStateSession()
    s.mutate({ blockers: [{ what: "race", surface: "runtime" }] })
    const snap = s.snapshot()
    // Mutate the snapshot's inner object directly — session state must NOT
    // observe it (caller mutating a "read-only snapshot" cannot tamper).
    if (snap.blockers[0]) snap.blockers[0].what = "tampered"
    expect(s.snapshot().blockers[0]?.what).toBe("race")
  })

  test("snapshot is decoupled from later mutations (inner-array push check)", () => {
    const s = createWorkingStateSession()
    s.mutate({ ownerShortlist: [{ file: "a.ts", reason: "first" }] })
    const snap = s.snapshot()
    // External push into the snapshot's array — session state must NOT grow.
    snap.ownerShortlist.push({ file: "evil.ts", reason: "appended" })
    expect(s.snapshot().ownerShortlist).toHaveLength(1)
  })
})
