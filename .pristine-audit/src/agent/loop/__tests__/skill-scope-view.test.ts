/**
 * ADR-0512 P3 — `/state` visible-tools accessor (read-only).
 *
 * `buildSkillScopeView(gate, specs)` is the pure read-only projection a surface
 * (`/state`) renders to answer "왜 이 도구가 없지?": which tools the active skill
 * has scoped IN (visible) vs OUT (hidden). It REUSES the stable skill-gate
 * exports (`filterSpecsByScope` for visible, `activeSkillName` for the label) so
 * the panel can never disagree with the L1 availability filter the model sees.
 *
 *   §V-1  active skill ⇒ visible = navBase ∪ allowlist; hidden = the rest;
 *         activeSkill = the skill name.
 *   §V-2  gate present but NO skill armed ⇒ activeSkill null + ALL visible +
 *         hidden empty (byte-identical "nothing scoped").
 *   §V-3  no gate at all (v2 OFF / skill-less session) ⇒ activeSkill null +
 *         ALL visible + hidden empty.
 *   §V-4  nav-base (the prompt-mandated exploration ladder) is ALWAYS visible
 *         even when the allowlist omits it (the file_tree_summary bug).
 *   §V-5  order is preserved (visible/hidden are spec-order subsequences).
 */

import { describe, expect, test } from "bun:test"
import { buildSkillGate } from "../skill-gate"
import { buildSkillScopeView } from "../skill-scope-view"

type Spec = { name: string }
const specsOf = (...names: string[]): Spec[] => names.map((name) => ({ name }))

/** Build a gate armed for `skill` with `allow` tools, then return it.
 *  Mirrors how the loop arms scope: a successful `Skill` dispatch observes
 *  `{ name: skill }`. */
const armedGate = (skill: string, allow: string[]) => {
  const gate = buildSkillGate(new Map([[skill, allow]]), undefined)
  if (gate === undefined) throw new Error("expected a gate")
  gate.observe("Skill", { name: skill }, true)
  return gate
}

describe("buildSkillScopeView", () => {
  test("§V-1 active skill ⇒ visible = navBase ∪ allowlist, hidden = the rest", () => {
    const specs = specsOf("read", "edit", "bash", "grep", "write")
    // allowlist declares `edit` only; nav-base (read/grep/glob/ls/file_tree_summary)
    // is always in scope, so bash/write are the out-of-scope set.
    const gate = armedGate("localize-fault", ["edit"])
    const view = buildSkillScopeView(gate, specs)

    expect(view.activeSkill).toBe("localize-fault")
    expect(view.visibleTools).toContain("edit") // allowlist
    expect(view.visibleTools).toContain("read") // nav-base
    expect(view.visibleTools).toContain("grep") // nav-base
    expect(view.hiddenTools).toEqual(["bash", "write"])
    // partition is total + disjoint
    expect([...view.visibleTools, ...view.hiddenTools].sort()).toEqual(
      [...specs.map((s) => s.name)].sort(),
    )
  })

  test("§V-2 gate present but NO skill armed ⇒ null + all visible + hidden empty", () => {
    const specs = specsOf("read", "edit", "bash")
    // A declared-but-not-yet-invoked skill: gate exists, no scope armed.
    const gate = buildSkillGate(new Map([["s", ["edit"]]]), undefined)
    if (gate === undefined) throw new Error("expected a gate")
    const view = buildSkillScopeView(gate, specs)

    expect(view.activeSkill).toBeNull()
    expect(view.visibleTools).toEqual(["read", "edit", "bash"])
    expect(view.hiddenTools).toEqual([])
  })

  test("§V-3 no gate (v2 OFF / skill-less) ⇒ null + all visible + hidden empty", () => {
    const specs = specsOf("read", "edit", "bash")
    const view = buildSkillScopeView(undefined, specs)

    expect(view.activeSkill).toBeNull()
    expect(view.visibleTools).toEqual(["read", "edit", "bash"])
    expect(view.hiddenTools).toEqual([])
  })

  test("§V-4 nav-base stays visible even when the allowlist omits it", () => {
    const specs = specsOf("file_tree_summary", "glob", "ls", "read", "grep", "bash")
    // allowlist declares NOTHING relevant — yet the exploration ladder is visible.
    const gate = armedGate("read-only-brief", [])
    const view = buildSkillScopeView(gate, specs)

    expect(view.visibleTools).toEqual(["file_tree_summary", "glob", "ls", "read", "grep"])
    expect(view.hiddenTools).toEqual(["bash"])
  })

  test("§V-5 visible/hidden preserve spec order", () => {
    const specs = specsOf("read", "bash", "edit", "write", "grep")
    // allowlist = write; nav-base = read/grep (among these). edit + bash are OUT.
    const gate = armedGate("s", ["write"])
    const view = buildSkillScopeView(gate, specs)

    // visible keeps the order they appear in `specs`
    expect(view.visibleTools).toEqual(["read", "write", "grep"])
    expect(view.hiddenTools).toEqual(["bash", "edit"])
  })
})
