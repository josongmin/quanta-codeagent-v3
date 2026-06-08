/**
 * `buildSkillGate` tool-scope matching (jun-8 fix).
 *
 * Two real bugs surfaced in the live web session ("스코프 존나 막히네" — every
 * tool denied `skill-scoped`):
 *   1. EMPTY `allowed-tools: []` (a tool-less / briefing skill like
 *      "Read-only repo onboarding") set `active` to an EMPTY Set, denying
 *      EVERY tool — a briefing skill jailed the agent to nothing.
 *   2. Claude-style CAPITALIZED allowlist names ("Read", "Bash") never matched
 *      quanta's lowercase dispatch names ("read", "bash") under exact-string
 *      `Set.has`, so even legitimately-permitted tools were denied.
 *
 * A non-empty allowlist MUST still restrict out-of-scope tools (security).
 */

import { describe, expect, test } from "bun:test"
import { buildSkillGate } from "@/agent/loop/skill-gate"
import type { SkillGate } from "@/agent/turn-context"

const mkGate = (allowlists: Record<string, readonly string[]>): SkillGate => {
  const g = buildSkillGate(
    new Map(Object.entries(allowlists).map(([k, v]) => [k, [...v]])),
    undefined,
  )
  if (g === undefined) throw new Error("expected a gate")
  return g
}

describe("buildSkillGate — tool-scope matching", () => {
  test("inactive gate (no Skill invoked yet) allows everything", () => {
    const g = mkGate({ explorer: ["Read"] })
    expect(g.allow("bash")).toBe(true)
    expect(g.allow("read")).toBe(true)
    expect(g.allow("agent")).toBe(true)
  })

  test("empty allowed-tools (briefing skill) must NOT jail the agent", () => {
    const g = mkGate({ "repo-onboarding": [] })
    g.observe("Skill", { name: "repo-onboarding" }, true)
    // A tool-less/briefing skill adds guidance, not a zero-tool jail.
    expect(g.allow("read")).toBe(true)
    expect(g.allow("bash")).toBe(true)
    expect(g.allow("agent")).toBe(true)
    expect(g.allow("file_tree_summary")).toBe(true)
  })

  test("Claude-style capitalized allowed-tools match quanta lowercase names", () => {
    const g = mkGate({ explorer: ["Read", "Bash"] })
    g.observe("Skill", { name: "explorer" }, true)
    expect(g.allow("read")).toBe(true) // "Read" ⇒ quanta "read"
    expect(g.allow("bash")).toBe(true)
    expect(g.allow("Read")).toBe(true) // case-insensitive either direction
  })

  test("a non-empty allowlist STILL restricts out-of-scope tools (security preserved)", () => {
    const g = mkGate({ reader: ["Read"] })
    g.observe("Skill", { name: "reader" }, true)
    expect(g.allow("read")).toBe(true)
    expect(g.allow("write")).toBe(false) // not in scope ⇒ denied
    expect(g.allow("bash")).toBe(false)
    expect(g.allow("Skill")).toBe(true) // meta tool always allowed
    expect(g.allow("ToolSearch")).toBe(true)
  })

  test("observe normalizes a leading-slash skill name", () => {
    const g = mkGate({ explorer: ["Read"] })
    g.observe("Skill", { name: "/explorer" }, true)
    expect(g.allow("read")).toBe(true)
  })

  test("a failed Skill invocation does NOT arm the scope", () => {
    const g = mkGate({ reader: ["Read"] })
    g.observe("Skill", { name: "reader" }, false) // ok=false
    expect(g.allow("bash")).toBe(true) // still unscoped
  })
})
