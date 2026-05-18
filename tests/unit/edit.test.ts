import { describe, expect, test } from "bun:test"
import { applyExactEdit } from "../../src/tool/edit/exact"

describe("applyExactEdit", () => {
  test("replaces a unique occurrence", () => {
    const r = applyExactEdit("const a = 1", "1", "2", false)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("const a = 2")
  })

  test("rejects ambiguous match without replace_all", () => {
    const r = applyExactEdit("a a a", "a", "b", false)
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined()
  })

  test("replace_all rewrites every occurrence", () => {
    const r = applyExactEdit("a a a", "a", "b", true)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("b b b")
  })

  test("rejects missing old_string", () => {
    expect(applyExactEdit("xyz", "q", "w", false).ok).toBe(false)
  })
})
