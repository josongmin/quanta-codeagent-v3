/**
 * ADR-0339 — `unionActiveSkills` hellgate.
 *
 * Coverage (≥8):
 *   A. both empty                                          → []
 *   B. existing empty + plugin one                         → plugin one
 *   C. existing one + plugin empty                         → existing one
 *   D. single name collision                               → caller (existing) wins
 *   E. multiple collisions + multiple new                  → existing first then new
 *   F. different description, same name                    → existing description kept
 *   G. order — existing first then plugin (chronological)  → ordering invariant
 *   H. undefined existing                                  → handled, returns plugin
 */

import { describe, expect, test } from "bun:test"
import { unionActiveSkills } from "../extender"
import type { ActiveSkillDescriptor } from "../types"

describe("unionActiveSkills — ADR-0339 hellgate", () => {
  test("A. both empty ⇒ []", () => {
    expect(unionActiveSkills([], [])).toEqual([])
  })

  test("B. existing empty + plugin one ⇒ plugin one returned", () => {
    const plugin: ActiveSkillDescriptor[] = [{ name: "x", description: "X" }]
    expect(unionActiveSkills([], plugin)).toEqual([{ name: "x", description: "X" }])
  })

  test("C. existing one + plugin empty ⇒ existing one returned", () => {
    const existing: ActiveSkillDescriptor[] = [{ name: "e", description: "E" }]
    expect(unionActiveSkills(existing, [])).toEqual([{ name: "e", description: "E" }])
  })

  test("D. single name collision ⇒ caller (existing) wins", () => {
    const existing: ActiveSkillDescriptor[] = [{ name: "shared", description: "caller-version" }]
    const plugin: ActiveSkillDescriptor[] = [{ name: "shared", description: "plugin-version" }]
    const out = unionActiveSkills(existing, plugin)
    expect(out).toEqual([{ name: "shared", description: "caller-version" }])
  })

  test("E. multiple collisions + multiple new ⇒ existing first then new", () => {
    const existing: ActiveSkillDescriptor[] = [
      { name: "a", description: "caller-A" },
      { name: "b", description: "caller-B" },
    ]
    const plugin: ActiveSkillDescriptor[] = [
      { name: "a", description: "plugin-A" }, // collision (dropped)
      { name: "c", description: "plugin-C" }, // new (kept)
      { name: "b", description: "plugin-B" }, // collision (dropped)
      { name: "d", description: "plugin-D" }, // new (kept)
    ]
    const out = unionActiveSkills(existing, plugin)
    expect(out).toEqual([
      { name: "a", description: "caller-A" },
      { name: "b", description: "caller-B" },
      { name: "c", description: "plugin-C" },
      { name: "d", description: "plugin-D" },
    ])
  })

  test("F. different description, same name ⇒ existing description kept", () => {
    const existing: ActiveSkillDescriptor[] = [{ name: "k", description: "ORIGINAL" }]
    const plugin: ActiveSkillDescriptor[] = [{ name: "k", description: "OVERRIDE-ATTEMPT" }]
    const out = unionActiveSkills(existing, plugin)
    expect(out[0]?.description).toBe("ORIGINAL")
  })

  test("G. order: existing first, then plugin in input order (chronological)", () => {
    const existing: ActiveSkillDescriptor[] = [
      { name: "first", description: "F" },
      { name: "second", description: "S" },
    ]
    const plugin: ActiveSkillDescriptor[] = [
      { name: "third", description: "T" },
      { name: "fourth", description: "Fo" },
    ]
    const out = unionActiveSkills(existing, plugin)
    expect(out.map((d) => d.name)).toEqual(["first", "second", "third", "fourth"])
  })

  test("H. undefined existing ⇒ handled, returns plugin entries", () => {
    const plugin: ActiveSkillDescriptor[] = [{ name: "p", description: "P" }]
    const out = unionActiveSkills(undefined, plugin)
    expect(out).toEqual([{ name: "p", description: "P" }])
  })
})
