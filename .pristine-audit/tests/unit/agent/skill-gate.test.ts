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
import { buildSkillGate, filterSpecsByScope } from "@/agent/loop/skill-gate"
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

  test("ADR-0512: empty allowed-tools SEALS to nav-base (read-only), not a zero-tool jail", () => {
    const g = mkGate({ "repo-onboarding": [] })
    g.observe("Skill", { name: "repo-onboarding" }, true)
    // A briefing/onboarding skill can still ORIENT and READ (nav-base) — it is
    // NOT jailed to nothing (jun-8 bug). But ordinary/mutating tools ARE denied.
    expect(g.allow("read")).toBe(true) // nav-base
    expect(g.allow("file_tree_summary")).toBe(true) // nav-base
    expect(g.allow("grep")).toBe(true) // nav-base
    expect(g.allow("bash")).toBe(false) // ordinary ⇒ denied by the seal
    expect(g.allow("agent")).toBe(false) // ordinary ⇒ denied by the seal
    expect(g.allow("write")).toBe(false) // mutating ⇒ denied by the seal
    expect(g.allow("Skill")).toBe(true) // meta always allowed
  })

  test("ADR-0512: ABSENT allowed-tools (skill not in map) arms no scope — everything allowed", () => {
    // Distinct from declared-empty `[]`: a skill with NO `allowed-tools:` key
    // contributes no allowlist entry, so observing it arms nothing.
    const g = mkGate({ reader: ["Read"] })
    g.observe("Skill", { name: "briefing-no-decl" }, true) // not in the map
    expect(g.allow("bash")).toBe(true)
    expect(g.allow("write")).toBe(true)
    expect(g.allow("agent")).toBe(true)
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

  test("ADR-0512 L2: nav-base (exploration ladder + grep) is ALWAYS in scope", () => {
    // A skill scoped to ONLY "Read" must still permit the prompt-mandated
    // read-only exploration ladder — otherwise the `✕ file_tree_summary
    // skill-scoped` bug recurs (prompt tells the model to orient with it first).
    const g = mkGate({ reader: ["Read"] })
    g.observe("Skill", { name: "reader" }, true)
    for (const t of ["file_tree_summary", "glob", "ls", "read", "grep"]) {
      expect(g.allow(t)).toBe(true)
    }
    // …but the carve-out is read-only ONLY: mutating/exec tools stay denied.
    expect(g.allow("write")).toBe(false)
    expect(g.allow("edit")).toBe(false)
    expect(g.allow("bash")).toBe(false)
  })

  test("ADR-0512 L2: nav-base survives even an allowlist that lists NONE of it", () => {
    const g = mkGate({ committer: ["git_commit"] })
    g.observe("Skill", { name: "committer" }, true)
    expect(g.allow("file_tree_summary")).toBe(true)
    expect(g.allow("git_commit")).toBe(true) // in allowlist
    expect(g.allow("bash")).toBe(false) // out of scope, not nav-base
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

describe("ADR-0512 L3: activeSkillName + widenScope", () => {
  test("activeSkillName is undefined until a scoping skill is observed, then its id", () => {
    const g = mkGate({ reader: ["Read"] })
    expect(g.activeSkillName()).toBeUndefined()
    g.observe("Skill", { name: "reader" }, true)
    expect(g.activeSkillName()).toBe("reader")
  })

  test("widenScope admits a previously out-of-scope tool (escalation approve)", () => {
    const g = mkGate({ reader: ["Read"] })
    g.observe("Skill", { name: "reader" }, true)
    expect(g.allow("edit")).toBe(false)
    g.widenScope("edit")
    expect(g.allow("edit")).toBe(true) // not re-asked next time
    expect(g.allow("write")).toBe(false) // only the widened tool
  })

  test("widenScope is a no-op when no scope is armed (no crash, stays open)", () => {
    const g = mkGate({ reader: ["Read"] })
    g.widenScope("edit") // never observed a skill
    expect(g.allow("edit")).toBe(true) // unscoped ⇒ everything allowed anyway
  })

  test("widened scope SURVIVES a re-observe of the SAME skill (approval not revoked)", () => {
    // Audit finding: re-observe rebuilds `active` from the allowlist; a separate
    // `widened` set must keep the user-approved tool admitted.
    const g = mkGate({ reader: ["Read"] })
    g.observe("Skill", { name: "reader" }, true)
    g.widenScope("edit")
    expect(g.allow("edit")).toBe(true)
    g.observe("Skill", { name: "reader" }, true) // re-invoke SAME skill
    expect(g.allow("edit")).toBe(true) // still approved — not wiped
  })

  test("widened scope is RESET when a DIFFERENT skill is observed (fresh scope)", () => {
    const g = mkGate({ reader: ["Read"], writer: ["Write"] })
    g.observe("Skill", { name: "reader" }, true)
    g.widenScope("edit")
    expect(g.allow("edit")).toBe(true)
    g.observe("Skill", { name: "writer" }, true) // switch skills
    expect(g.allow("edit")).toBe(false) // widening did NOT leak across skills
    expect(g.allow("write")).toBe(true) // new skill's allowlist
    expect(g.activeSkillName()).toBe("writer")
  })
})

describe("ADR-0512 L1: filterSpecsByScope (availability filter)", () => {
  const specs = [
    { name: "read" },
    { name: "write" },
    { name: "bash" },
    { name: "file_tree_summary" },
    { name: "git_commit" },
  ]
  const names = (s: readonly { name: string }[]): string[] => s.map((x) => x.name)

  test("undefined gate ⇒ SAME reference (byte-identical, no allocation)", () => {
    expect(filterSpecsByScope(specs, undefined)).toBe(specs)
  })

  test("gate with NO active skill ⇒ SAME reference (nothing filtered)", () => {
    const g = mkGate({ reader: ["Read"] }) // built but Skill never observed
    expect(filterSpecsByScope(specs, g)).toBe(specs)
  })

  test("active scope ⇒ removes out-of-scope tools, keeps nav-base + allowlist", () => {
    const g = mkGate({ committer: ["git_commit"] })
    g.observe("Skill", { name: "committer" }, true)
    const out = names(filterSpecsByScope(specs, g))
    expect(out).toContain("git_commit") // allowlist
    expect(out).toContain("read") // nav-base
    expect(out).toContain("file_tree_summary") // nav-base
    expect(out).not.toContain("write") // out of scope
    expect(out).not.toContain("bash") // out of scope
  })

  test("filtered set == dispatchable set (invariant #2: same predicate)", () => {
    const g = mkGate({ reader: ["Read"] })
    g.observe("Skill", { name: "reader" }, true)
    const visible = filterSpecsByScope(specs, g)
    // Every visible tool dispatches; every filtered-out tool would be denied.
    for (const s of specs) {
      expect(g.allow(s.name)).toBe(visible.some((v) => v.name === s.name))
    }
  })
})
