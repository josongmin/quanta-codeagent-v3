import { describe, expect, test } from "bun:test"
import {
  __createSeededHistoryForTest,
  createPromptHistory,
} from "../../../../src/apps/cli/prompt-history"

describe("prompt-history (bash-style)", () => {
  test("push + prev returns the most recent entry first", () => {
    const h = __createSeededHistoryForTest(["a", "b", "c"])
    expect(h.size()).toBe(3)
    expect(h.prev()).toBe("c")
    expect(h.prev()).toBe("b")
    expect(h.prev()).toBe("a")
    expect(h.prev()).toBeUndefined() // walked off the start
  })

  test("next walks newer; past-newest returns undefined (restore draft)", () => {
    const h = __createSeededHistoryForTest(["a", "b"])
    expect(h.prev()).toBe("b")
    expect(h.prev()).toBe("a")
    expect(h.next()).toBe("b")
    expect(h.next()).toBeUndefined() // past newest
  })

  test("consecutive duplicates suppressed (bash HISTCONTROL=ignoredups)", () => {
    const h = createPromptHistory({ ephemeral: true })
    h.push("ls")
    h.push("ls")
    h.push("ls")
    h.push("pwd")
    h.push("pwd")
    expect(h.__snapshot()).toEqual(["ls", "pwd"])
  })

  test("empty lines are skipped", () => {
    const h = createPromptHistory({ ephemeral: true })
    h.push("a")
    h.push("")
    h.push("b")
    expect(h.__snapshot()).toEqual(["a", "b"])
  })

  test("ring buffer enforces maxLines (oldest evicted)", () => {
    const h = createPromptHistory({ ephemeral: true, maxLines: 3 })
    h.push("a")
    h.push("b")
    h.push("c")
    h.push("d")
    expect(h.__snapshot()).toEqual(["b", "c", "d"])
    h.push("e")
    expect(h.__snapshot()).toEqual(["c", "d", "e"])
  })

  test("prev filter pulls the most recent entry with the given prefix", () => {
    const h = __createSeededHistoryForTest(["foo bar", "git status", "foo baz", "ls"])
    expect(h.prev("foo")).toBe("foo baz")
    expect(h.prev("foo")).toBe("foo bar")
    expect(h.prev("foo")).toBeUndefined()
  })

  test("reset() clears the cursor so next prev() restarts at newest", () => {
    const h = __createSeededHistoryForTest(["a", "b", "c"])
    expect(h.prev()).toBe("c")
    expect(h.prev()).toBe("b")
    h.reset()
    expect(h.prev()).toBe("c") // restarted
  })

  test("search() finds the most recent containing substring; subsequent search() goes older", () => {
    const h = __createSeededHistoryForTest(["foo bar", "alpha", "foo baz", "beta"])
    expect(h.search("foo")).toBe("foo baz")
    expect(h.search("foo")).toBe("foo bar")
    expect(h.search("foo")).toBeUndefined()
  })

  test("search() returns undefined for empty query (no-op)", () => {
    const h = __createSeededHistoryForTest(["a", "b"])
    expect(h.search("")).toBeUndefined()
  })

  test("push resets the navigation cursor (matches bash behavior)", () => {
    const h = __createSeededHistoryForTest(["a", "b", "c"])
    expect(h.prev()).toBe("c")
    expect(h.prev()).toBe("b")
    h.push("d")
    // After a push the next `prev()` starts from the newest again.
    expect(h.prev()).toBe("d")
  })

  test("ephemeral mode never touches disk (no path required)", () => {
    // Just verify it doesn't throw and isolates from any real file.
    const h = createPromptHistory({ ephemeral: true })
    h.push("x")
    expect(h.size()).toBe(1)
    expect(h.prev()).toBe("x")
  })

  test("size() reflects the live ring buffer", () => {
    const h = createPromptHistory({ ephemeral: true, maxLines: 5 })
    expect(h.size()).toBe(0)
    h.push("a")
    h.push("b")
    expect(h.size()).toBe(2)
  })
})
