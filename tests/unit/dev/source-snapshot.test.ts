import { describe, expect, test } from "bun:test"
import { createSourceSnapshot } from "../../../tools/dev/source-snapshot"

describe("process-local source snapshot", () => {
  test("the same path is loaded once and mutation uses a clone", () => {
    let loads = 0
    const snapshot = createSourceSnapshot("abc")
    const first = snapshot.read("src/a.ts", () => {
      loads += 1
      return "one"
    })
    const second = snapshot.read("src/a.ts", () => {
      loads += 1
      return "two"
    })
    expect(loads).toBe(1)
    expect(second.text).toBe("one")
    const clone = snapshot.clone()
    clone.read("src/a.ts", () => "mutated")
    expect(snapshot.read("src/a.ts", () => "ignored").text).toBe("one")
    expect(first.contentSha).toHaveLength(64)
  })
})
