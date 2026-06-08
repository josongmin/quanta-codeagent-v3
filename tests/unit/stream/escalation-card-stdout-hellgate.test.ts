/**
 * ADR-0512 P3 hellgate — the CLI surface renders `permission_escalation_requested`
 * as an interactive APPROVAL CARD, NOT a red `✕ skill-scoped` error.
 *
 * The ADR's headline goal: "스코프 밖"을 빨간 에러로 그리지 말고, 인터랙티브 승인 카드로.
 * The card carries: which tool / risk (read-only vs mutating) / why / the model's
 * justification / the 4 options. A hand-off-required HARD lock renders a
 * DISTINCT (gray lock, no escalate buttons) shape — visually different from the
 * yellow ask card.
 */

import { describe, expect, test } from "bun:test"
import { StdoutStream } from "../../../src/stream/adapters/stdout"
import type { AgentEvent } from "../../../src/stream/types"

const ask: Extract<AgentEvent, { type: "permission_escalation_requested" }> = {
  type: "permission_escalation_requested",
  id: "esc-1",
  tool: "edit",
  risk: "mutating",
  activeSkill: "localize-fault",
  reason: 'Tool "edit" is outside the active skill "localize-fault".',
  justification: "fix the bug at src/foo.ts:42",
  options: ["allow_once", "allow_session", "deny", "deny_and_steer"],
}

describe("ADR-0512 P3 — escalation card on stdout (NOT a red error)", () => {
  test("requested renders the tool / risk / reason / justification / options as a card", () => {
    const out: string[] = []
    const s = new StdoutStream({ write: (chunk) => out.push(chunk) })
    s.emit(ask)
    const text = out.join("")
    // It is NOT the red tool-error mark.
    expect(text).not.toContain("✗")
    expect(text).not.toContain("\x1b[31m") // RED — a scope ask is not an error
    // The card content the ADR mandates.
    expect(text).toContain("edit")
    expect(text).toContain("localize-fault")
    expect(text).toContain("mutating")
    expect(text).toContain("fix the bug at src/foo.ts:42")
    // The 4 decision verbs are offered.
    expect(text).toContain("allow_once")
    expect(text).toContain("allow_session")
    expect(text).toContain("deny")
  })

  test("read-only risk renders 'read-only', not 'mutating'", () => {
    const out: string[] = []
    const s = new StdoutStream({ write: (chunk) => out.push(chunk) })
    s.emit({ ...ask, risk: "read-only" })
    const text = out.join("")
    expect(text).toContain("read-only")
  })

  test("resolved renders the chosen decision (a follow-up line, not an error)", () => {
    const out: string[] = []
    const s = new StdoutStream({ write: (chunk) => out.push(chunk) })
    s.emit({ type: "permission_escalation_resolved", id: "esc-1", decision: "allow_session" })
    const text = out.join("")
    expect(text).not.toContain("\x1b[31m")
    expect(text).toContain("allow_session")
  })
})
