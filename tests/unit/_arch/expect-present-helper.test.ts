import { describe, expect, test } from "bun:test"

import { nth, present } from "../../_helpers/expect-present"

/**
 * The helper exists for its failure MESSAGE, so the message is what this pins.
 * Many suites now depend on `nth`/`present`; a silent regression to a bare
 * `undefined` throw would take the diagnostic value with it and nothing else
 * would notice.
 */
describe("nth", () => {
  test("returns the element when it is there", () => {
    expect(nth([10, 20, 30], 1, "codes")).toBe(20)
  })

  test("names the index AND the real length when the collection is short", () => {
    const chunks = [{ text: "a" }, { text: "b" }]
    let message = ""
    try {
      nth(chunks, 3, "chunks")
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("chunks")
    expect(message).toContain("[3]")
    expect(message).toContain("2") // the observed length, which `chunks[3]!` never tells you
  })

  test("throws an Error, not a TypeError from a downstream property read", () => {
    expect(() => nth([], 0, "empty")).toThrow(Error)
  })

  test("falls back to a generic name when the caller gives none", () => {
    expect(() => nth([], 0)).toThrow(/item\[0\]/)
  })

  test("works on any ArrayLike, not just arrays", () => {
    expect(nth("abc", 2, "chars")).toBe("c")
  })
})

describe("present", () => {
  test("returns the value when it is set", () => {
    expect(present(0, "zero")).toBe(0)
    expect(present("", "blank")).toBe("")
    expect(present(false, "flag")).toBe(false)
  })

  test("names the field and says undefined", () => {
    let message = ""
    try {
      present(undefined, "run.metrics.gold_coverage_rate")
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("run.metrics.gold_coverage_rate")
    expect(message).toContain("undefined")
  })

  test("names the field and says null", () => {
    let message = ""
    try {
      present(null, "session.threadId")
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("session.threadId")
    expect(message).toContain("null")
  })
})

describe("no assertion context required", () => {
  test("both work outside expect(), e.g. in a fixture builder", () => {
    const build = (): string => nth(["only"], 0, "rows")
    expect(build()).toBe("only")
    expect(present(build(), "built")).toBe("only")
  })
})
