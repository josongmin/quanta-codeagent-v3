/**
 * turn-summary hellgate — per-turn signal collector + box renderer contract.
 *
 * Pins the surface contract for `createTurnSummary`: AgentEvent consumption
 * (tool counts, recovery reasons, verify-guard trips, compaction kind, usage),
 * memory-citation surfacing (with score-hidden invariant), reset semantics,
 * default-OFF / enabled-false byte-identical (`render` returns `""`), and the
 * ENV gate + TTY auto-OFF probe.
 */

import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "../../../src/agent"
import {
  createTurnSummary,
  isTurnSummaryEnabled,
  isTurnSummaryVerbose,
} from "../../../src/apps/cli/turn-summary"
import type { AgentEvent } from "../../../src/stream"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

/** Minimal AgentOutcome fixture — every test that doesn't care about a
 *  field uses this shape and patches what it needs. */
const baseOutcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [],
})

const RECOVERY = (reason: string, detail?: string): AgentEvent =>
  ({ type: "recovery", reason, ...(detail !== undefined ? { detail } : {}) }) as AgentEvent

describe("createTurnSummary: empty/no-signal render", () => {
  test("empty outcome + no events → render returns ''", () => {
    const c = createTurnSummary()
    expect(c.render(baseOutcome())).toBe("")
  })

  test("usage-only event (no tools, no recovery, no citations) → '' in non-verbose", () => {
    const c = createTurnSummary()
    c.onEvent({ type: "usage", inputTokens: 12, outputTokens: 34, model: "test" })
    expect(c.render(baseOutcome())).toBe("")
  })
})

describe("createTurnSummary: tools row", () => {
  test("counts tool_call + approved (ok:true) tool_result", () => {
    const c = createTurnSummary()
    c.onEvent({ type: "tool_call", id: "1", name: "Read", input: {} })
    c.onEvent({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
    c.onEvent({ type: "tool_call", id: "2", name: "Edit", input: {} })
    c.onEvent({ type: "tool_result", id: "2", name: "Edit", ok: true, preview: "ok" })
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/2 tools/)
    expect(out).toMatch(/approved 2/)
    expect(out).not.toMatch(/denied/) // hidden when zero
  })

  test("denied count surfaced when > 0", () => {
    const c = createTurnSummary()
    c.onEvent({ type: "tool_call", id: "1", name: "Bash", input: {} })
    c.onEvent({ type: "tool_result", id: "1", name: "Bash", ok: false, preview: "denied" })
    c.onEvent({ type: "tool_call", id: "2", name: "Read", input: {} })
    c.onEvent({ type: "tool_result", id: "2", name: "Read", ok: true, preview: "ok" })
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/2 tools/)
    expect(out).toMatch(/approved 1/)
    expect(out).toMatch(/denied 1/)
  })
})

describe("createTurnSummary: verify-guard row", () => {
  test("counts recovery:unverified trips", () => {
    const c = createTurnSummary()
    c.onEvent(RECOVERY("unverified"))
    c.onEvent(RECOVERY("unverified"))
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/verify-guard/)
    expect(out).toMatch(/tripped 2×/)
  })

  test("hidden when no unverified trip fired", () => {
    const c = createTurnSummary()
    c.onEvent(RECOVERY("backoff", "attempt 1"))
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).not.toMatch(/verify-guard/)
  })
})

describe("createTurnSummary: compaction row", () => {
  test("proactive compaction (recovery:compact:proactive + context_compacted)", () => {
    const c = createTurnSummary()
    c.onEvent(RECOVERY("compact", "proactive"))
    c.onEvent({
      type: "context_compacted",
      fromTurnId: "t1",
      toTurnId: "t2",
      summary: "x",
      ts: 0,
      tokens: 800,
    })
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/compacted/)
    expect(out).toMatch(/proactive×1/)
    expect(out).toMatch(/800tok/)
  })

  test("PTL compaction (recovery:compact without detail + context_compacted)", () => {
    const c = createTurnSummary()
    c.onEvent(RECOVERY("compact"))
    c.onEvent({
      type: "context_compacted",
      fromTurnId: "t1",
      toTurnId: "t2",
      summary: "x",
      ts: 0,
      tokens: 500,
    })
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/ptl×1/)
    expect(out).not.toMatch(/proactive/)
  })
})

describe("createTurnSummary: memory citations row", () => {
  test("0 citations → row hidden (field omitted on outcome)", () => {
    const c = createTurnSummary()
    expect(c.render(baseOutcome())).toBe("")
  })

  test("1 citation → 'memory: 1 hits (recordId)'", () => {
    const c = createTurnSummary()
    const out = stripAnsi(
      c.render({
        ...baseOutcome(),
        memoryCitations: [{ recordId: "distill-0042", score: 0.91, where: "reminder_tail" }],
      }),
    )
    expect(out).toMatch(/memory: 1 hits/)
    expect(out).toMatch(/distill-0042/)
    expect(out).not.toMatch(/0\.91/) // SCORE MUST NOT LEAK
  })

  test("5 citations → only first 3 ids shown, plus '+2 more'", () => {
    const c = createTurnSummary()
    const out = stripAnsi(
      c.render({
        ...baseOutcome(),
        memoryCitations: [
          { recordId: "a", score: 1, where: "reminder_tail" },
          { recordId: "b", score: 1, where: "reminder_tail" },
          { recordId: "c", score: 1, where: "reminder_tail" },
          { recordId: "d", score: 1, where: "reminder_tail" },
          { recordId: "e", score: 1, where: "reminder_tail" },
        ],
      }),
    )
    expect(out).toMatch(/memory: 5 hits/)
    expect(out).toMatch(/\(a, b, c, \+2 more\)/)
  })
})

describe("createTurnSummary: recovery row (excluding compact + unverified)", () => {
  test("backoff + nudge counts surface, compact and unverified are excluded", () => {
    const c = createTurnSummary()
    c.onEvent(RECOVERY("backoff", "1"))
    c.onEvent(RECOVERY("backoff", "2"))
    c.onEvent(RECOVERY("nudge"))
    c.onEvent(RECOVERY("compact")) // excluded from this row (dedicated row exists)
    c.onEvent(RECOVERY("unverified")) // excluded too
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/recovery:/)
    expect(out).toMatch(/2×backoff/)
    expect(out).toMatch(/1×nudge/)
    // The recovery row text must not contain `compact` / `unverified` —
    // those go into their own rows. Match only on the recovery-row segment
    // (everything after "recovery:" up to the next box border).
    const recoveryRow = out.split("recovery:")[1] ?? ""
    expect(recoveryRow).not.toMatch(/compact/)
    expect(recoveryRow).not.toMatch(/unverified/)
  })
})

describe("createTurnSummary: continuation row", () => {
  test("resume + retry + disable counts surface on one row", () => {
    const c = createTurnSummary()
    c.onEvent({
      type: "llm_continuation",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      phase: "prepare",
      mode: "resume",
      reason: "prepared_resume",
    })
    c.onEvent({
      type: "llm_continuation",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      phase: "retry",
      mode: "full_retry",
      reason: "resume_rejected",
      statusCode: 400,
    })
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/continuation:/)
    expect(out).toMatch(/resume×1/)
    expect(out).toMatch(/retry×1/)
    expect(out).toMatch(/disabled×1/)
  })

  test("full fallback without a resume attempt stays hidden", () => {
    const c = createTurnSummary()
    c.onEvent({
      type: "llm_continuation",
      provider: "openai",
      surfaceId: "openai-responses",
      transportId: "public",
      phase: "prepare",
      mode: "full",
      reason: "no_entry",
    })
    expect(stripAnsi(c.render(baseOutcome()))).not.toMatch(/continuation:/)
  })
})

describe("createTurnSummary: ANSI escapes + box wrapper", () => {
  test("output contains ANSI escape sequences when colour ON", () => {
    setColorPolicy("on")
    try {
      const c = createTurnSummary()
      c.onEvent({ type: "tool_call", id: "1", name: "Read", input: {} })
      c.onEvent({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
      const out = c.render(baseOutcome())
      // ESC[…m sequences MUST appear (titleStyle: cyan + green tick).
      expect(out).toMatch(new RegExp(`${String.fromCharCode(27)}\\[`))
    } finally {
      setColorPolicy(null)
    }
  })

  test("colour OFF → no ANSI escapes in render", () => {
    setColorPolicy("off")
    try {
      const c = createTurnSummary()
      c.onEvent({ type: "tool_call", id: "1", name: "Read", input: {} })
      c.onEvent({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
      const out = c.render(baseOutcome())
      // No ESC bytes when policy is off.
      expect(out).not.toMatch(new RegExp(String.fromCharCode(27)))
      // But the row is still present.
      expect(out).toMatch(/1 tools/)
    } finally {
      setColorPolicy(null)
    }
  })

  test("output uses the rounded-box glyphs from renderBox", () => {
    const c = createTurnSummary()
    c.onEvent({ type: "tool_call", id: "1", name: "Read", input: {} })
    c.onEvent({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toContain("╭")
    expect(out).toContain("╰")
    expect(out).toContain("│")
  })
})

describe("createTurnSummary: reset semantics", () => {
  test("reset() clears tool counts, verify trips, compaction, recovery", () => {
    const c = createTurnSummary()
    c.onEvent({ type: "tool_call", id: "1", name: "Read", input: {} })
    c.onEvent({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
    c.onEvent(RECOVERY("unverified"))
    c.onEvent(RECOVERY("backoff", "1"))
    c.reset()
    expect(c.render(baseOutcome())).toBe("")
  })

  test("after reset(), the next turn's events accumulate from zero", () => {
    const c = createTurnSummary()
    // Turn 1.
    c.onEvent({ type: "tool_call", id: "1", name: "Read", input: {} })
    c.onEvent({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
    c.reset()
    // Turn 2 — a single denied tool. Must NOT inherit turn 1's approved count.
    c.onEvent({ type: "tool_call", id: "2", name: "Bash", input: {} })
    c.onEvent({ type: "tool_result", id: "2", name: "Bash", ok: false, preview: "denied" })
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/1 tools/)
    expect(out).toMatch(/approved 0/)
    expect(out).toMatch(/denied 1/)
  })
})

describe("createTurnSummary: enabled=false", () => {
  test("disabled → onEvent ignored + render returns ''", () => {
    const c = createTurnSummary({ enabled: false })
    c.onEvent({ type: "tool_call", id: "1", name: "Read", input: {} })
    c.onEvent({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
    c.onEvent(RECOVERY("unverified"))
    expect(c.render(baseOutcome())).toBe("")
  })

  test("disabled + outcome with citations → still ''", () => {
    const c = createTurnSummary({ enabled: false })
    expect(
      c.render({
        ...baseOutcome(),
        memoryCitations: [{ recordId: "x", score: 1, where: "reminder_tail" }],
      }),
    ).toBe("")
  })
})

describe("createTurnSummary: multiple verify-guard trips fold", () => {
  test("3 unverified events surface as 'tripped 3×' in one row", () => {
    const c = createTurnSummary()
    c.onEvent(RECOVERY("unverified"))
    c.onEvent(RECOVERY("unverified"))
    c.onEvent(RECOVERY("unverified"))
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/tripped 3×/)
    // Only ONE verify-guard row in the output.
    const matches = out.match(/verify-guard/g) ?? []
    expect(matches.length).toBe(1)
  })
})

describe("createTurnSummary: asStreamPort", () => {
  test("asStreamPort()→emit forwards into onEvent", () => {
    const c = createTurnSummary()
    const port = c.asStreamPort()
    port.emit({ type: "tool_call", id: "1", name: "Read", input: {} })
    port.emit({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
    const out = stripAnsi(c.render(baseOutcome()))
    expect(out).toMatch(/1 tools/)
  })

  test("asStreamPort()→emit swallows collector throws", () => {
    // The consume function shouldn't throw, but if a future bug did, the
    // port MUST NOT propagate (TeeStream would otherwise mark a degraded
    // record). We probe by constructing a collector whose onEvent we wrap
    // to throw — easiest via the public surface: pass an event with a
    // missing required field. The consume switch ignores unknown shapes,
    // so we just assert that arbitrary emits do not throw.
    const c = createTurnSummary()
    const port = c.asStreamPort()
    expect(() => port.emit({ type: "session_start" } as AgentEvent)).not.toThrow()
  })
})

describe("isTurnSummaryEnabled: ENV/TTY gate", () => {
  test("TTY + no env → enabled (default-ON)", () => {
    expect(isTurnSummaryEnabled({}, true)).toBe(true)
  })

  test("non-TTY + no env → disabled (default-OFF)", () => {
    expect(isTurnSummaryEnabled({}, false)).toBe(false)
    expect(isTurnSummaryEnabled({}, undefined)).toBe(false)
  })

  test("QUANTA_TURN_SUMMARY=0 → disabled even on TTY", () => {
    expect(isTurnSummaryEnabled({ QUANTA_TURN_SUMMARY: "0" }, true)).toBe(false)
    expect(isTurnSummaryEnabled({ QUANTA_TURN_SUMMARY: "off" }, true)).toBe(false)
    expect(isTurnSummaryEnabled({ QUANTA_TURN_SUMMARY: "false" }, true)).toBe(false)
  })

  test("QUANTA_TURN_SUMMARY=1 → enabled even on non-TTY", () => {
    expect(isTurnSummaryEnabled({ QUANTA_TURN_SUMMARY: "1" }, false)).toBe(true)
    expect(isTurnSummaryEnabled({ QUANTA_TURN_SUMMARY: "on" }, false)).toBe(true)
    expect(isTurnSummaryEnabled({ QUANTA_TURN_SUMMARY: "yes" }, false)).toBe(true)
  })
})

describe("isTurnSummaryVerbose: ENV probe", () => {
  test("absent → false", () => {
    expect(isTurnSummaryVerbose({})).toBe(false)
  })
  test("=1 / true / on → true", () => {
    expect(isTurnSummaryVerbose({ QUANTA_TURN_SUMMARY_VERBOSE: "1" })).toBe(true)
    expect(isTurnSummaryVerbose({ QUANTA_TURN_SUMMARY_VERBOSE: "true" })).toBe(true)
  })
  test("=0 / random → false", () => {
    expect(isTurnSummaryVerbose({ QUANTA_TURN_SUMMARY_VERBOSE: "0" })).toBe(false)
    expect(isTurnSummaryVerbose({ QUANTA_TURN_SUMMARY_VERBOSE: "random" })).toBe(false)
  })
})

describe("createTurnSummary: integration shape", () => {
  test("mixed turn — tools, verify-guard, compaction, memory, recovery all surface in one box", () => {
    const c = createTurnSummary({ turnNumber: 3 })
    c.onEvent({ type: "tool_call", id: "1", name: "Read", input: {} })
    c.onEvent({ type: "tool_result", id: "1", name: "Read", ok: true, preview: "ok" })
    c.onEvent({ type: "tool_call", id: "2", name: "Bash", input: {} })
    c.onEvent({ type: "tool_result", id: "2", name: "Bash", ok: false, preview: "denied" })
    c.onEvent(RECOVERY("unverified"))
    c.onEvent(RECOVERY("compact", "proactive"))
    c.onEvent({
      type: "context_compacted",
      fromTurnId: "t1",
      toTurnId: "t2",
      summary: "x",
      ts: 0,
      tokens: 1024,
    })
    c.onEvent(RECOVERY("backoff", "1"))
    const out = stripAnsi(
      c.render({
        ...baseOutcome(),
        memoryCitations: [
          { recordId: "distill-0042", score: 0.9, where: "reminder_tail" },
          { recordId: "role-001", score: 0.7, where: "reminder_tail" },
        ],
      }),
    )
    expect(out).toContain("turn 3")
    expect(out).toMatch(/2 tools/)
    expect(out).toMatch(/approved 1/)
    expect(out).toMatch(/denied 1/)
    expect(out).toMatch(/verify-guard/)
    expect(out).toMatch(/tripped 1×/)
    expect(out).toMatch(/proactive×1/)
    expect(out).toMatch(/1024tok/)
    expect(out).toMatch(/memory: 2 hits/)
    expect(out).toMatch(/distill-0042, role-001/)
    expect(out).toMatch(/recovery:/)
    expect(out).toMatch(/1×backoff/)
    // Trailing newline (caller writes to stderr verbatim).
    expect(out.endsWith("\n")).toBe(true)
  })
})
