/**
 * Status-transition matrix hellgate (P1 plan-mode SOTA++, ADR-0095 draft).
 *
 * Pins the closed `TodoStatus` transition matrix. Adding a status MUST
 * extend the `TRANSITION_MATRIX` AND every exhaustive switch in this file
 * (TypeScript compile error if not).
 *
 * Coverage:
 *   - 5×5 exhaustive matrix (25 cells): allowed vs denied per rules:
 *       pending     → in_progress | cancelled | blocked
 *       in_progress → completed | blocked | cancelled
 *       blocked     → in_progress | cancelled
 *       completed   → (terminal — no outgoing)
 *       cancelled   → (terminal — no outgoing)
 *   - Self-transitions always allowed (treated as noop at mutations layer).
 *   - Terminal states (completed/cancelled) have empty outgoing arrays.
 *   - TRANSITION_MATRIX keys cover ALL_TODO_STATUSES (no holes, no extras).
 *   - Outgoing arrays never contain duplicates and never include self.
 *   - isValidTransition is pure (same inputs → same output, no side effects).
 */

import { describe, expect, test } from "bun:test"
import { isValidTransition, TRANSITION_MATRIX } from "../../../../src/agent/plan/transitions"
import { ALL_TODO_STATUSES, TERMINAL_TODO_STATUSES, type TodoStatus } from "../../../../src/agent/plan/types"

// ── Rule table (the canonical spec, mirrored here for exhaustive testing) ─

/** What each status can transition INTO (excluding self). */
const ALLOWED_OUTGOING: Readonly<Record<TodoStatus, readonly TodoStatus[]>> = {
  pending: ["in_progress", "cancelled", "blocked"],
  in_progress: ["completed", "blocked", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  completed: [],
  cancelled: [],
}

// ── 5x5 exhaustive matrix ─────────────────────────────────────────────────

describe("isValidTransition: 5x5 exhaustive cell matrix", () => {
  for (const from of ALL_TODO_STATUSES) {
    for (const to of ALL_TODO_STATUSES) {
      const allowedOutgoing = ALLOWED_OUTGOING[from]
      const isSelf = from === to
      const isInAllowed = allowedOutgoing.includes(to)
      const expected = isSelf || isInAllowed
      test(`${from} → ${to} is ${expected ? "allowed" : "denied"}`, () => {
        expect(isValidTransition(from, to)).toBe(expected)
      })
    }
  }
})

// ── Terminal status invariants ────────────────────────────────────────────

describe("terminal statuses: no outgoing edges (excluding self-noop)", () => {
  for (const terminal of TERMINAL_TODO_STATUSES) {
    test(`${terminal} has empty TRANSITION_MATRIX outgoing list`, () => {
      expect(TRANSITION_MATRIX[terminal]).toEqual([])
    })
    for (const to of ALL_TODO_STATUSES) {
      if (to === terminal) continue
      test(`${terminal} → ${to} is denied (terminal)`, () => {
        expect(isValidTransition(terminal, to)).toBe(false)
      })
    }
  }
})

// ── Self-transition: always allowed (mutations layer treats as noop) ──────

describe("self-transitions: always legal (mutations noop)", () => {
  for (const s of ALL_TODO_STATUSES) {
    test(`${s} → ${s} is allowed (self)`, () => {
      expect(isValidTransition(s, s)).toBe(true)
    })
  }
})

// ── TRANSITION_MATRIX shape invariants ────────────────────────────────────

describe("TRANSITION_MATRIX: closed-shape invariants", () => {
  test("has exactly the ALL_TODO_STATUSES keys (no extras, no holes)", () => {
    const keys = Object.keys(TRANSITION_MATRIX).sort()
    const expected = [...ALL_TODO_STATUSES].sort()
    expect(keys).toEqual(expected)
  })

  for (const from of ALL_TODO_STATUSES) {
    test(`${from} outgoing list has no duplicates`, () => {
      const list = TRANSITION_MATRIX[from]
      const unique = new Set(list)
      expect(unique.size).toBe(list.length)
    })
    test(`${from} outgoing list does NOT include self`, () => {
      expect(TRANSITION_MATRIX[from]).not.toContain(from)
    })
    test(`${from} outgoing entries are all valid TodoStatus values`, () => {
      for (const to of TRANSITION_MATRIX[from]) {
        expect(ALL_TODO_STATUSES).toContain(to)
      }
    })
  }

  test("matches ALLOWED_OUTGOING rule table exactly", () => {
    for (const from of ALL_TODO_STATUSES) {
      const matrixList = [...TRANSITION_MATRIX[from]].sort()
      const expectList = [...ALLOWED_OUTGOING[from]].sort()
      expect(matrixList).toEqual(expectList)
    }
  })

  test("is frozen / immutable (cannot mutate)", () => {
    expect(Object.isFrozen(TRANSITION_MATRIX)).toBe(true)
  })
})

// ── Specific illegal transitions called out by the spec ───────────────────

describe("invalid_status_transition spec cases (must be denied)", () => {
  const illegalPairs: readonly (readonly [TodoStatus, TodoStatus])[] = [
    ["completed", "pending"],
    ["completed", "in_progress"],
    ["completed", "blocked"],
    ["completed", "cancelled"],
    ["cancelled", "pending"],
    ["cancelled", "in_progress"],
    ["cancelled", "blocked"],
    ["cancelled", "completed"],
    ["blocked", "pending"],
    ["blocked", "completed"],
    ["pending", "completed"],
  ]
  for (const [from, to] of illegalPairs) {
    test(`${from} → ${to} denied`, () => {
      expect(isValidTransition(from, to)).toBe(false)
    })
  }
})

// ── Purity: same inputs → same output across calls ────────────────────────

describe("isValidTransition: pure (no hidden state)", () => {
  test("repeated calls with same args yield identical result", () => {
    for (const from of ALL_TODO_STATUSES) {
      for (const to of ALL_TODO_STATUSES) {
        const a = isValidTransition(from, to)
        const b = isValidTransition(from, to)
        const c = isValidTransition(from, to)
        expect(a).toBe(b)
        expect(b).toBe(c)
      }
    }
  })
})

// ── Exhaustive switch: adding a TodoStatus forces compile error here ──────

/**
 * If a new `TodoStatus` literal is added, the exhaustive switch below
 * will fail to compile (`never` arm receives the new literal).
 * This pins the test file itself to the closed enum.
 */
function exhaustiveSwitchPin(s: TodoStatus): string {
  switch (s) {
    case "pending":
      return "p"
    case "in_progress":
      return "i"
    case "completed":
      return "c"
    case "cancelled":
      return "x"
    case "blocked":
      return "b"
    default: {
      const _never: never = s
      return _never
    }
  }
}

describe("exhaustive switch compile pin", () => {
  test("every status maps via switch (compile-time guard)", () => {
    const out = ALL_TODO_STATUSES.map(exhaustiveSwitchPin).sort()
    expect(out).toEqual(["b", "c", "i", "p", "x"])
  })
})
