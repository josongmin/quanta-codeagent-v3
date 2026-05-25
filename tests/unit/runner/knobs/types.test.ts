/**
 * Knob `types.ts` — exception shape + literal type ergonomics.
 *
 * Type-level assertions (e.g. `exactOptionalPropertyTypes` contract) are
 * exercised by the compiler; runtime tests below cover the error classes
 * and how they encode their data.
 */
import { describe, expect, test } from "bun:test"
import { KnobConflictError, KnobMissingRequiredError, KnobParseError } from "@/runner/knobs"

describe("KnobConflictError", () => {
  test("name + message + conflicts payload", () => {
    const err = new KnobConflictError([
      ["a", "b"],
      ["c", "d"],
    ])
    expect(err.name).toBe("KnobConflictError")
    expect(err.message).toContain("a<->b")
    expect(err.message).toContain("c<->d")
    expect(err.conflicts.length).toBe(2)
  })

  test("instanceof Error", () => {
    const err = new KnobConflictError([["a", "b"]])
    expect(err).toBeInstanceOf(Error)
  })

  test("empty conflicts still constructable", () => {
    const err = new KnobConflictError([])
    expect(err.conflicts.length).toBe(0)
  })

  test("conflicts payload preserves order", () => {
    const err = new KnobConflictError([
      ["z", "a"],
      ["b", "c"],
    ])
    expect(err.conflicts[0]).toEqual(["z", "a"])
    expect(err.conflicts[1]).toEqual(["b", "c"])
  })
})

describe("KnobMissingRequiredError", () => {
  test("name + message + payload", () => {
    const err = new KnobMissingRequiredError("foo", "bar")
    expect(err.name).toBe("KnobMissingRequiredError")
    expect(err.message).toContain('"foo"')
    expect(err.message).toContain('"bar"')
    expect(err.knobId).toBe("foo")
    expect(err.missingRequired).toBe("bar")
  })

  test("instanceof Error", () => {
    const err = new KnobMissingRequiredError("foo", "bar")
    expect(err).toBeInstanceOf(Error)
  })
})

describe("KnobParseError", () => {
  test("name + payload", () => {
    const err = new KnobParseError("foo", "junk")
    expect(err.name).toBe("KnobParseError")
    expect(err.knobId).toBe("foo")
    expect(err.raw).toBe("junk")
    expect(err.message).toContain('"foo"')
    expect(err.message).toContain('"junk"')
  })

  test("empty raw still encoded", () => {
    const err = new KnobParseError("foo", "")
    expect(err.raw).toBe("")
  })

  test("instanceof Error", () => {
    const err = new KnobParseError("foo", "x")
    expect(err).toBeInstanceOf(Error)
  })
})
