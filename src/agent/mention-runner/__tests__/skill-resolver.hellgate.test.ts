/**
 * ADR-0330 / ADR-0418 — Skill-only resolver async hellgate.
 *
 *   A. Registry absent / null lookup           (2)
 *   B. Hit ⇒ first-line bodyText               (1)
 *   C. Multi-line description                  (2)
 *   D. Empty description                       (1)
 *   E. Plugin / app always-null (frozen)       (4)
 *   F. Registry throws ⇒ null (NO-THROW)       (1)
 *   G. CRLF tolerance                          (1)
 *   H. Malformed entry (non-string desc)       (1)
 *
 * Total = 13 cases (>= the required 8).
 */

import { describe, expect, test } from "bun:test"
import { createSkillOnlyResolver } from "../skill-resolver"
import type { SkillRegistryReadOnly } from "../types"

const stubRegistry = (lookup: SkillRegistryReadOnly["lookup"]): SkillRegistryReadOnly => ({
  lookup,
})

describe("createSkillOnlyResolver — ADR-0330 hellgate", () => {
  // -------- A. registry absent / null lookup -------------------------

  test("A1 — registry omitted ⇒ resolveSkill returns null", async () => {
    const port = createSkillOnlyResolver()
    expect(await port.resolveSkill("any-skill")).toBeNull()
  })

  test("A2 — registry.lookup returns null ⇒ resolveSkill returns null", async () => {
    const port = createSkillOnlyResolver(stubRegistry(() => null))
    expect(await port.resolveSkill("missing-skill")).toBeNull()
  })

  // -------- B. hit ⇒ first-line bodyText -----------------------------

  test("B1 — hit returns bodyText = description first-line (no newline)", async () => {
    const port = createSkillOnlyResolver(
      stubRegistry(() => ({
        name: "code-review",
        description: "Review the current diff for correctness bugs",
      })),
    )
    expect(await port.resolveSkill("code-review")).toEqual({
      bodyText: "Review the current diff for correctness bugs",
    })
  })

  // -------- C. multi-line description --------------------------------

  test("C1 — multi-line description ⇒ first line only", async () => {
    const port = createSkillOnlyResolver(
      stubRegistry(() => ({
        name: "x",
        description: "First line tagline.\nSecond line is body.\nThird line trailing.",
      })),
    )
    expect(await port.resolveSkill("x")).toEqual({ bodyText: "First line tagline." })
  })

  test("C2 — first line is preserved EXACTLY (no trim, no normalize)", async () => {
    const port = createSkillOnlyResolver(
      stubRegistry(() => ({
        name: "x",
        description: "  leading spaces and trailing   \nrest body",
      })),
    )
    expect(await port.resolveSkill("x")).toEqual({
      bodyText: "  leading spaces and trailing   ",
    })
  })

  // -------- D. empty description -------------------------------------

  test("D1 — empty description ⇒ bodyText = ''", async () => {
    const port = createSkillOnlyResolver(stubRegistry(() => ({ name: "x", description: "" })))
    expect(await port.resolveSkill("x")).toEqual({ bodyText: "" })
  })

  // -------- E. plugin / app always-null (frozen) ---------------------

  test("E1 — resolvePlugin returns null WITHOUT registry", async () => {
    const port = createSkillOnlyResolver()
    expect(await port.resolvePlugin("github")).toBeNull()
  })

  test("E2 — resolvePlugin returns null WITH registry (resolver ignores it)", async () => {
    const port = createSkillOnlyResolver(
      stubRegistry(() => ({ name: "github", description: "would-be plugin body" })),
    )
    expect(await port.resolvePlugin("github")).toBeNull()
  })

  test("E3 — resolveApp returns null WITHOUT registry", async () => {
    const port = createSkillOnlyResolver()
    expect(await port.resolveApp("chrome")).toBeNull()
  })

  test("E4 — resolveApp returns null WITH registry (resolver ignores it)", async () => {
    const port = createSkillOnlyResolver(
      stubRegistry(() => ({ name: "chrome", description: "would-be app body" })),
    )
    expect(await port.resolveApp("chrome")).toBeNull()
  })

  // -------- F. NO-THROW invariant ------------------------------------

  test("F1 — registry.lookup throws ⇒ null, no escape", async () => {
    const port = createSkillOnlyResolver(
      stubRegistry(() => {
        throw new Error("hostile registry")
      }),
    )
    expect(await port.resolveSkill("anything")).toBeNull()
  })

  // -------- G. CRLF tolerance ----------------------------------------

  test("G1 — CRLF description ⇒ first line strips trailing CR", async () => {
    const port = createSkillOnlyResolver(
      stubRegistry(() => ({
        name: "x",
        description: "first line\r\nsecond",
      })),
    )
    expect(await port.resolveSkill("x")).toEqual({ bodyText: "first line" })
  })

  // -------- H. malformed entry ---------------------------------------

  test("H1 — non-string description ⇒ null (defensive cast at boundary)", async () => {
    const port = createSkillOnlyResolver(
      // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile boundary shape
      stubRegistry(() => ({ name: "x", description: 42 as any })),
    )
    expect(await port.resolveSkill("x")).toBeNull()
  })
})
