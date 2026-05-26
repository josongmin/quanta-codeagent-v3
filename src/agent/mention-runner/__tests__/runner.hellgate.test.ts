/**
 * ADR-0330 — `createMentionInjector` hellgate.
 *
 *   A. Empty / no-mention input                 (2)
 *   B. Known skill ⇒ single message             (1)
 *   C. Unknown skill ⇒ no message               (1)
 *   D. Mixed known + unknown                    (1)
 *   E. plugin:// ⇒ no message (frozen null)     (1)
 *   F. @@app ⇒ no message (frozen null)         (1)
 *   G. Registry throws ⇒ no message (NO-THROW)  (1)
 *   H. Dedup (same @skill twice ⇒ 1 message)    (1)
 *   I. Order preservation (first-occurrence)    (1)
 *   J. Description first-line shows in body     (1)
 *
 * Total = 11 cases (>= the required 10).
 */

import { describe, expect, test } from "bun:test"
import { createMentionInjector } from "../runner"
import type { SkillRegistryReadOnly } from "../types"

const fakeSkills = (table: Readonly<Record<string, string>>): SkillRegistryReadOnly => ({
  lookup(name: string) {
    const desc = table[name]
    return desc === undefined ? null : { name, description: desc }
  },
})

/** Pull the first text block's text out of a message (defensive). */
const textOf = (msg: { content: ReadonlyArray<unknown> } | undefined): string => {
  const block = msg?.content[0] as { type: string; text?: string } | undefined
  return typeof block?.text === "string" ? block.text : ""
}

describe("createMentionInjector — ADR-0330 hellgate", () => {
  // -------- A. empty / no-mention ------------------------------------

  test("A1 — empty input ⇒ []", () => {
    const inject = createMentionInjector({ skills: fakeSkills({}) })
    expect(inject("")).toEqual([])
  })

  test("A2 — input with no mentions ⇒ []", () => {
    const inject = createMentionInjector({ skills: fakeSkills({ x: "X tagline" }) })
    expect(inject("just some text, no sigils")).toEqual([])
  })

  // -------- B. known skill -------------------------------------------

  test("B1 — known @skill ⇒ 1 <mention> message", () => {
    const inject = createMentionInjector({
      skills: fakeSkills({ "code-review": "Review the diff for correctness bugs" }),
    })
    const out = inject("please run @code-review now")
    expect(out).toHaveLength(1)
    const t = textOf(out[0])
    expect(t.startsWith("<mention>")).toBe(true)
    expect(t.endsWith("</mention>")).toBe(true)
    expect(t).toContain("kind: skill")
    expect(t).toContain("target: code-review")
    expect(t).toContain("Review the diff for correctness bugs")
  })

  // -------- C. unknown skill -----------------------------------------

  test("C1 — unknown @skill ⇒ resolver returns null ⇒ no message", () => {
    const inject = createMentionInjector({ skills: fakeSkills({}) })
    expect(inject("@unknown-skill go")).toEqual([])
  })

  // -------- D. mixed known + unknown ---------------------------------

  test("D1 — mixed known + unknown ⇒ only known appears", () => {
    const inject = createMentionInjector({
      skills: fakeSkills({ "code-review": "known tagline" }),
    })
    const out = inject("@code-review then @missing-one")
    expect(out).toHaveLength(1)
    expect(textOf(out[0])).toContain("target: code-review")
  })

  // -------- E. plugin frozen-null ------------------------------------

  test("E1 — plugin://gh ⇒ no message (plugin resolver always null)", () => {
    const inject = createMentionInjector({
      // Even if a "gh" skill existed, plugin resolver does not touch the
      // skill registry — frozen by ADR-0330.
      skills: fakeSkills({ gh: "would-be body" }),
    })
    expect(inject("use plugin://gh now")).toEqual([])
  })

  // -------- F. app frozen-null ---------------------------------------

  test("F1 — @@app-x ⇒ no message (app resolver always null)", () => {
    const inject = createMentionInjector({
      skills: fakeSkills({ "app-x": "would-be body" }),
    })
    expect(inject("open @@app-x please")).toEqual([])
  })

  // -------- G. NO-THROW (hostile registry) ---------------------------

  test("G1 — registry.lookup throws ⇒ unknown-treated, no message, no escape", () => {
    const hostile: SkillRegistryReadOnly = {
      lookup() {
        throw new Error("boom")
      },
    }
    const inject = createMentionInjector({ skills: hostile })
    expect(inject("@anything go")).toEqual([])
  })

  // -------- H. dedup -------------------------------------------------

  test("H1 — same @skill mentioned twice ⇒ exactly 1 message (parser dedup)", () => {
    const inject = createMentionInjector({
      skills: fakeSkills({ x: "X tagline" }),
    })
    const out = inject("first @x and then @x again")
    expect(out).toHaveLength(1)
  })

  // -------- I. order preservation ------------------------------------

  test("I1 — multiple known skills preserve first-occurrence order", () => {
    const inject = createMentionInjector({
      skills: fakeSkills({ alpha: "A", beta: "B", gamma: "C" }),
    })
    const out = inject("@gamma then @alpha then @beta")
    expect(out).toHaveLength(3)
    expect(textOf(out[0])).toContain("target: gamma")
    expect(textOf(out[1])).toContain("target: alpha")
    expect(textOf(out[2])).toContain("target: beta")
  })

  // -------- J. first-line semantics ----------------------------------

  test("J1 — multi-line description ⇒ only first line shows in body", () => {
    const inject = createMentionInjector({
      skills: fakeSkills({ x: "Tagline only.\nSecret body must NOT leak." }),
    })
    const out = inject("@x")
    expect(out).toHaveLength(1)
    const t = textOf(out[0])
    expect(t).toContain("Tagline only.")
    expect(t).not.toContain("Secret body must NOT leak.")
  })
})
