/**
 * Context-change detector hellgate — ADR-0319.
 *
 * Seals the pure diff surface that converts two {@link TurnStateSnapshot}
 * captures into a {@link ContextEvent[]}. 10 cases covering:
 *
 *   A. Identity / equality short-circuit            (2)
 *   B. Single-field detection                       (4)
 *   C. Multi-field aggregation                      (1)
 *   D. Skill-activation contract                    (2)
 *   E. Metadata propagation                         (1)
 */

import { describe, expect, test } from "bun:test"
import { captureSnapshot, detectContextChanges } from ".."
import type { ContextEvent } from "../types"

const AT = 1_700_000_000_000
const TURN_ID = "turn-7"

describe("detectContextChanges — ADR-0319 hellgate", () => {
  // -------- A. identity / equality -------------------------------------

  test("A1 — same reference ⇒ empty array (hot path short-circuit)", () => {
    const snap = captureSnapshot({ cwd: "/a", mode: "default" })
    expect(detectContextChanges(snap, snap, AT)).toEqual([])
  })

  test("A2 — distinct references but value-equal ⇒ empty array (deep-ish eq)", () => {
    const a = captureSnapshot({
      cwd: "/x",
      mode: "default",
      model: "gpt-5",
      repoRulesPaths: ["AGENTS.md"],
      activeSkills: ["s1"],
    })
    const b = captureSnapshot({
      cwd: "/x",
      mode: "default",
      model: "gpt-5",
      repoRulesPaths: ["AGENTS.md"],
      activeSkills: ["s1"],
    })
    expect(a).not.toBe(b) // distinct references
    expect(detectContextChanges(a, b, AT)).toEqual([])
  })

  // -------- B. single-field detection ----------------------------------

  test("B1 — cwd change ⇒ exactly one context_update{field:'cwd'}", () => {
    const prev = captureSnapshot({ cwd: "/old" })
    const next = captureSnapshot({ cwd: "/new" })
    const events = detectContextChanges(prev, next, AT)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: "context_update",
      field: "cwd",
      prev: "/old",
      next: "/new",
      at: AT,
    })
  })

  test("B2 — mode change ⇒ ONE mode_change event (NOT a duplicate context_update)", () => {
    const prev = captureSnapshot({ mode: "default" })
    const next = captureSnapshot({ mode: "plan" })
    const events = detectContextChanges(prev, next, AT, { modeChangeReason: "user requested" })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: "mode_change",
      prev: "default",
      next: "plan",
      reason: "user requested",
      at: AT,
    })
  })

  test("B3 — repo_rules path diff ⇒ repo_rules_change with added/removed sets", () => {
    const prev = captureSnapshot({ repoRulesPaths: ["AGENTS.md", "x.mdc"] })
    const next = captureSnapshot({ repoRulesPaths: ["AGENTS.md", "y.mdc", "z.mdc"] })
    const events = detectContextChanges(prev, next, AT)
    expect(events).toHaveLength(1)
    const ev = events[0] as Extract<ContextEvent, { kind: "repo_rules_change" }>
    expect(ev.kind).toBe("repo_rules_change")
    expect(ev.addedPaths).toEqual(["y.mdc", "z.mdc"])
    expect(ev.removedPaths).toEqual(["x.mdc"])
  })

  test("B4 — model change ⇒ context_update{field:'model'}", () => {
    const prev = captureSnapshot({ model: "gpt-5" })
    const next = captureSnapshot({ model: "claude-opus-4-7" })
    const events = detectContextChanges(prev, next, AT)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: "context_update",
      field: "model",
      prev: "gpt-5",
      next: "claude-opus-4-7",
      at: AT,
    })
  })

  // -------- C. multi-field aggregation ---------------------------------

  test("C1 — 5 fields change simultaneously ⇒ 5 events (one mode_change, one per other field, one per added skill)", () => {
    const prev = captureSnapshot({
      cwd: "/a",
      mode: "default",
      model: "gpt-5",
      repoRulesPaths: [],
      activeSkills: [],
    })
    const next = captureSnapshot({
      cwd: "/b",
      mode: "plan",
      model: "claude",
      repoRulesPaths: ["AGENTS.md"],
      activeSkills: ["s1"],
    })
    const events = detectContextChanges(prev, next, AT)
    // 1 cwd + 1 mode_change + 1 model + 1 repo_rules_change + 1 skill_activation
    expect(events).toHaveLength(5)
    const kinds = events.map((e) => e.kind).sort()
    expect(kinds).toEqual([
      "context_update",
      "context_update",
      "mode_change",
      "repo_rules_change",
      "skill_activation",
    ])
  })

  // -------- D. skill_activation contract -------------------------------

  test("D1 — activeSkills ['a'] → ['a','b'] ⇒ ONE skill_activation for 'b' (added-only)", () => {
    const prev = captureSnapshot({ activeSkills: ["a"] })
    const next = captureSnapshot({ activeSkills: ["a", "b"] })
    const events = detectContextChanges(prev, next, AT)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: "skill_activation",
      skillId: "b",
      trigger: "system",
      at: AT,
    })
  })

  test("D2 — activeSkills ['a','b'] → ['a'] ⇒ NO skill_activation (removal is out of scope, negative invariant)", () => {
    const prev = captureSnapshot({ activeSkills: ["a", "b"] })
    const next = captureSnapshot({ activeSkills: ["a"] })
    const events = detectContextChanges(prev, next, AT)
    // The detector MUST NOT emit a `skill_deactivation` (no such variant) and
    // MUST NOT emit a context_update{field:"active_skills"} fallback either —
    // this slice's ADR explicitly scopes activation-only.
    expect(events).toEqual([])
  })

  // -------- E. metadata propagation ------------------------------------

  test("E1 — turnId AND `at` AND modeChangeReason are propagated to every event", () => {
    const prev = captureSnapshot({ cwd: "/a", mode: "default" })
    const next = captureSnapshot({ cwd: "/b", mode: "plan" })
    const events = detectContextChanges(prev, next, AT, {
      turnId: TURN_ID,
      modeChangeReason: "/plan slash",
    })
    expect(events).toHaveLength(2)
    for (const ev of events) {
      expect(ev.at).toBe(AT)
      expect(ev.turnId).toBe(TURN_ID)
    }
    const modeEv = events.find((e) => e.kind === "mode_change")
    expect(modeEv).toBeDefined()
    if (modeEv?.kind === "mode_change") {
      expect(modeEv.reason).toBe("/plan slash")
    }
  })
})
