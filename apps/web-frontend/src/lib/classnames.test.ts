import { describe, expect, it } from "vitest"
import { cx } from "./classnames"

describe("cx", () => {
  it("joins truthy strings with a single space", () => {
    expect(cx("a", "b", "c")).toBe("a b c")
  })

  it("drops false / null / undefined / empty inputs", () => {
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b")
  })

  it("flattens nested arrays of class values", () => {
    expect(cx("base", ["one", ["two", false, "three"]], "tail")).toBe(
      "base one two three tail",
    )
  })

  it("returns an empty string when nothing is truthy", () => {
    expect(cx(false, null, undefined, "")).toBe("")
  })

  it("preserves intra-string spacing (does not split tokens)", () => {
    expect(cx("a b", "c")).toBe("a b c")
  })
})
