// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
import { describe, expect, test } from "bun:test"
import { parseYaml, stringifyYaml } from "../../tools/feature-catalog/yaml"

/** Round-trip helper: parse → stringify → parse, assert deep equal. */
function roundTrip(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("roundTrip: top-level must be a mapping")
  }
  const out = stringifyYaml(value)
  const back = parseYaml(out)
  expect(back).toEqual(value as Record<string, unknown>)
}

describe("yaml.ts — scalar parsing", () => {
  test("parses null / ~ / empty", () => {
    expect(parseYaml("a: null\nb: ~\n")).toEqual({ a: null, b: null })
  })

  test("parses booleans", () => {
    expect(parseYaml("on: true\noff: false\n")).toEqual({ on: true, off: false })
  })

  test("parses integers and floats", () => {
    expect(parseYaml("n: 42\nf: -3.14\n")).toEqual({ n: 42, f: -3.14 })
  })

  test("parses unquoted strings as strings", () => {
    expect(parseYaml("id: my-feature\ntitle: Some Title\n")).toEqual({
      id: "my-feature",
      title: "Some Title",
    })
  })

  test("parses single-quoted strings (with '' escape)", () => {
    const got = parseYaml("k: 'it''s a string'\n") as Record<string, unknown>
    expect(got.k).toBe("it's a string")
  })

  test("parses double-quoted strings with escapes", () => {
    const got = parseYaml('k: "line\\nbreak\\t<tab>"\n') as Record<string, unknown>
    expect(got.k).toBe("line\nbreak\t<tab>")
  })
})

describe("yaml.ts — sequences", () => {
  test("parses flow sequence of scalars", () => {
    expect(parseYaml("xs: [1, 2, 3]\n")).toEqual({ xs: [1, 2, 3] })
  })

  test("parses empty flow sequence", () => {
    expect(parseYaml("xs: []\n")).toEqual({ xs: [] })
  })

  test("parses flow sequence with quoted strings", () => {
    const got = parseYaml(`tags: ['a', "b, c", d]\n`)
    expect(got).toEqual({ tags: ["a", "b, c", "d"] })
  })

  test("parses block sequence", () => {
    const src = "items:\n  - one\n  - two\n  - three\n"
    expect(parseYaml(src)).toEqual({ items: ["one", "two", "three"] })
  })

  test("parses block sequence of mappings", () => {
    const src = "list:\n  - name: a\n    val: 1\n  - name: b\n    val: 2\n"
    expect(parseYaml(src)).toEqual({
      list: [
        { name: "a", val: 1 },
        { name: "b", val: 2 },
      ],
    })
  })
})

describe("yaml.ts — block scalar / multiline", () => {
  test("parses literal block scalar with preserved newlines", () => {
    const src = "purpose: |\n  line one\n  line two\n  line three\n"
    expect(parseYaml(src)).toEqual({ purpose: "line one\nline two\nline three" })
  })

  test("indented lines in block scalar preserve relative indent", () => {
    const src = "p: |\n  outer\n    inner\n  outer2\n"
    expect(parseYaml(src)).toEqual({ p: "outer\n  inner\nouter2" })
  })
})

describe("yaml.ts — mappings + nesting", () => {
  test("parses nested mapping", () => {
    const src = "a:\n  b: 1\n  c: 2\n"
    expect(parseYaml(src)).toEqual({ a: { b: 1, c: 2 } })
  })

  test("parses deeply nested mapping (3 levels)", () => {
    const src = "a:\n  b:\n    c: hi\n"
    expect(parseYaml(src)).toEqual({ a: { b: { c: "hi" } } })
  })
})

describe("yaml.ts — comments + edge cases", () => {
  test("ignores standalone comment lines", () => {
    const src = "# preamble\na: 1\n# middle\nb: 2\n"
    expect(parseYaml(src)).toEqual({ a: 1, b: 2 })
  })

  test("strips trailing inline comments", () => {
    const src = "a: 1  # explanation\nb: hello # right\n"
    expect(parseYaml(src)).toEqual({ a: 1, b: "hello" })
  })

  test("does not strip # inside quoted string", () => {
    const src = `a: "has # hash"\n`
    expect(parseYaml(src)).toEqual({ a: "has # hash" })
  })

  test("blank lines are ignored", () => {
    const src = "a: 1\n\n\nb: 2\n"
    expect(parseYaml(src)).toEqual({ a: 1, b: 2 })
  })
})

describe("yaml.ts — errors", () => {
  test("rejects tab indentation", () => {
    expect(() => parseYaml("a:\n\tb: 1\n")).toThrow(/tabs are forbidden/)
  })

  test("rejects unterminated double-quoted string", () => {
    expect(() => parseYaml('a: "unterminated\n')).toThrow()
  })

  test("rejects malformed mapping key", () => {
    expect(() => parseYaml("not a key line\n")).toThrow(/malformed mapping key/)
  })
})

describe("yaml.ts — stringifyYaml + round-trip", () => {
  test("round-trips simple flat mapping", () => {
    roundTrip({ a: 1, b: "hello", c: true, d: null })
  })

  test("round-trips nested mapping", () => {
    roundTrip({ outer: { inner: { leaf: 42 } } })
  })

  test("round-trips flow sequence", () => {
    roundTrip({ tags: ["a", "b", "c"] })
  })

  test("round-trips empty array as []", () => {
    roundTrip({ xs: [] })
  })

  test("round-trips block sequence of objects", () => {
    roundTrip({
      list: [
        { name: "a", count: 1 },
        { name: "b", count: 2 },
      ],
    })
  })

  test("round-trips multiline string via block scalar", () => {
    roundTrip({ purpose: "line one\nline two\nline three" })
  })

  test("round-trips strings needing quotes (numeric-looking, true-looking)", () => {
    roundTrip({ a: "42", b: "true", c: "null", d: "", e: "has: colon" })
  })

  test("round-trips a feature-shaped object", () => {
    roundTrip({
      id: "verify-guard",
      title: "Verify-guard (Tier 0)",
      section: 1,
      subsystem: "1.4",
      order: 0,
      maturity: "L4",
      status: "stable",
      purpose: "Block finish-without-verify on mutating sessions.",
      evidence: {
        code: ["src/agent/verify-guard.ts"],
        adrs: [13],
        tests: { unit: ["tests/unit/verify-guard.test.ts"], integration: [], contract: [] },
      },
      knobs: ["QUANTA_VERIFY_GUARD", "QUANTA_VERIFY_GUARD_MAX_TRIPS"],
      deliberate_hold: null,
    })
  })

  test("round-trips deliberate_hold object", () => {
    roundTrip({
      id: "hold-example",
      deliberate_hold: { reason: "advisory only", promotion_path: "ship after benchmark" },
    })
  })
})
