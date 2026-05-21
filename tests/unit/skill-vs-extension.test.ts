/**
 * Skill vs Extension classifier + allowed-tool gate tests
 * (Cluster E / F14, ADR-0040).
 */
import { describe, expect, test } from "bun:test"
import type { SkillFrontmatter } from "../../src/skill/skill-frontmatter"
import {
  assertAllowedTool,
  classify,
  isToolAllowed,
  ToolNotAllowedBySkillError,
} from "../../src/skill/skill-vs-extension"

const fm = (overrides: Partial<SkillFrontmatter> = {}): SkillFrontmatter => ({
  name: "demo",
  description: "x",
  userInvocable: false,
  allowedTools: [],
  category: "skill",
  stability: "stable",
  ...overrides,
})

describe("classify", () => {
  test("classifies a userInvocable skill", () => {
    const got = classify(fm({ category: "skill", userInvocable: true }))
    expect(got).toEqual({ kind: "skill", userInvocable: true })
  })

  test("classifies a non-userInvocable skill", () => {
    const got = classify(fm({ category: "skill", userInvocable: false }))
    expect(got).toEqual({ kind: "skill", userInvocable: false })
  })

  test("classifies an extension as non-userInvocable", () => {
    const got = classify(fm({ category: "extension", userInvocable: false }))
    expect(got).toEqual({ kind: "extension", userInvocable: false })
  })

  test("rejects extension + userInvocable=true (contradiction)", () => {
    expect(() => classify(fm({ category: "extension", userInvocable: true }))).toThrow(
      ToolNotAllowedBySkillError,
    )
  })
})

describe("assertAllowedTool / isToolAllowed", () => {
  test("permits a tool that is explicitly listed", () => {
    expect(() => assertAllowedTool(fm({ allowedTools: ["Read"] }), "Read")).not.toThrow()
    expect(isToolAllowed(fm({ allowedTools: ["Read"] }), "Read")).toBe(true)
  })

  test("denies a tool that is not listed", () => {
    expect(() => assertAllowedTool(fm({ allowedTools: ["Read"] }), "Bash")).toThrow(
      ToolNotAllowedBySkillError,
    )
    expect(isToolAllowed(fm({ allowedTools: ["Read"] }), "Bash")).toBe(false)
  })

  test("EMPTY allowedTools means NO tools allowed (not 'all')", () => {
    expect(() => assertAllowedTool(fm({ allowedTools: [] }), "Read")).toThrow(
      ToolNotAllowedBySkillError,
    )
    expect(isToolAllowed(fm({ allowedTools: [] }), "Read")).toBe(false)
  })

  test("case-sensitive (Read != read)", () => {
    expect(isToolAllowed(fm({ allowedTools: ["Read"] }), "read")).toBe(false)
  })

  test("error message names the offending tool and skill", () => {
    let caught: unknown
    try {
      assertAllowedTool(fm({ name: "rummager", allowedTools: ["X"] }), "Y")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ToolNotAllowedBySkillError)
    expect((caught as Error).message).toMatch(/rummager/)
    expect((caught as Error).message).toMatch(/'Y'/)
  })
})
