import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import type { TurnContextInput } from "@/agent/prompt"
import { buildTurnContext } from "@/agent/prompt"
import { todayDateLine } from "@/agent/prompt-reminders"

// ─────────────────────────────────────────────────────────────────────────────
// HELLGATE — `today-date-line-clock-port` (L4)
//
// Feature reason-to-exist: the per-turn `Today's date is YYYY-MM-DD.` line is a
// determinism LEAK (ADR-0078) — it drifts day-by-day and breaks byte-identical
// replay. The fix is an INJECTED clock port (`TurnContextInput.now?: () => number`,
// threaded to `todayDateLine(now)` via `(now ?? Date.now)()`). So the load-bearing
// invariant is: **an injected clock deterministically pins the date line to that
// clock's instant — NOT the wall clock**.
//
// The pre-existing assertion (tests/unit/prompt-dynamic.test.ts:70) re-derives the
// expected value from the SAME real wall clock the production code reads
// (`new Date().toISOString().slice(0,10)`) — a tautology that passes whether or
// not the port is wired. This hellgate instead pins FIXED epochs to FIXED literal
// strings (fresh-readback), proves values FLOW from the port (paired-control), and
// confirms the `Date.now` fallback branch still exists.
//
// FIXED_EPOCH = 2020-01-02T03:04:05Z (a moment that is NOT "today"), so the literal
// expectation can never accidentally coincide with the current wall clock.
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_EPOCH = Date.UTC(2020, 0, 2, 3, 4, 5) // 2020-01-02
const OTHER_EPOCH = Date.UTC(2031, 5, 13, 23, 59, 59) // 2031-06-13

const reminderText = (m: Message): string => {
  const block = m.content[0]
  return block?.type === "text" ? block.text : ""
}

const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
  cwd: "/repo",
  planMode: false,
  ...over,
})

describe("today-date clock port — determinism invariant", () => {
  test("injected fixed epoch pins the date line to a FIXED literal (not wall clock)", () => {
    // fresh-readback: the expectation is a hard-coded literal, never re-derived
    // from `new Date()`. If the port is ignored (reads Date.now), this fails.
    expect(todayDateLine(() => FIXED_EPOCH)).toBe("Today's date is 2020-01-02.")
  })

  test("paired-control: a DIFFERENT injected epoch yields a DIFFERENT fixed line", () => {
    const a = todayDateLine(() => FIXED_EPOCH)
    const b = todayDateLine(() => OTHER_EPOCH)
    expect(a).toBe("Today's date is 2020-01-02.")
    expect(b).toBe("Today's date is 2031-06-13.")
    // proves the rendered value actually FLOWS from the injected port, rather than
    // both branches collapsing onto a shared constant / the wall clock.
    expect(a).not.toBe(b)
  })

  test("fallback branch: absent clock uses Date.now (today) — port is optional", () => {
    // fallback re-derivation is permitted HERE — its only job is to witness that
    // the `now ?? Date.now` default branch exists and produces a real date line.
    expect(todayDateLine()).toBe(`Today's date is ${new Date().toISOString().slice(0, 10)}.`)
  })
})

describe("today-date clock port — flows through buildTurnContext assembly", () => {
  const dateLineFromReminder = (input: TurnContextInput): string => {
    const { messages } = buildTurnContext(input)
    return reminderText(messages[messages.length - 1] as Message)
  }

  test("injected epoch reaches the rendered per-turn reminder verbatim", () => {
    const text = dateLineFromReminder(base({ now: () => FIXED_EPOCH }))
    expect(text).toContain("Today's date is 2020-01-02.")
    // negative pin: the wall-clock date must NOT leak in when a clock is injected.
    expect(text).not.toContain(`Today's date is ${new Date().toISOString().slice(0, 10)}.`)
  })

  test("paired-control through the assembler: different epoch → different reminder line", () => {
    const a = dateLineFromReminder(base({ now: () => FIXED_EPOCH }))
    const b = dateLineFromReminder(base({ now: () => OTHER_EPOCH }))
    expect(a).toContain("Today's date is 2020-01-02.")
    expect(b).toContain("Today's date is 2031-06-13.")
  })
})
