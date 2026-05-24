/** ADR-0197 — MCP elicitation hellgate.
 *
 *  Sections (12 cases):
 *    HELL-E-01: headlessRejecter always typed-denies
 *    HELL-E-02: validation error → 1 retry → abort on second violation
 *    HELL-E-03..09: 7 schemas each round-trip (Titled + Untitled covered via .title)
 *    HELL-E-10: cliPrompter AbortSignal cancels
 *    HELL-E-11: empty options list → typed empty-enum
 *    HELL-E-12: number/integer NaN/Infinity rejected as invalid-input */

import { describe, expect, test } from "bun:test"
import { type CliPrompterIO, cliPrompter, headlessRejecter } from "@/mcp"

const scriptedIO = (lines: ReadonlyArray<string | null>): CliPrompterIO & { written: string[] } => {
  const written: string[] = []
  let i = 0
  return {
    written,
    write(s: string) {
      written.push(s)
    },
    async read(_signal: AbortSignal): Promise<string | null> {
      const v = lines[i] ?? null
      i++
      return v
    },
  }
}

describe("Elicitation — headlessRejecter (HELL-E-01)", () => {
  test("every method resolves to ok:false reason: headless-denied", async () => {
    const ac = new AbortController()
    const cases = await Promise.all([
      headlessRejecter.promptString({ prompt: "q" }, ac.signal),
      headlessRejecter.promptNumber({ prompt: "q" }, ac.signal),
      headlessRejecter.promptInteger({ prompt: "q" }, ac.signal),
      headlessRejecter.promptBoolean({ prompt: "q" }, ac.signal),
      headlessRejecter.promptEnum({ prompt: "q", options: ["a", "b"] }, ac.signal),
      headlessRejecter.promptMultiEnum({ prompt: "q", options: ["a"] }, ac.signal),
      headlessRejecter.promptSingleEnum({ prompt: "q", options: ["a"] }, ac.signal),
    ])
    for (const r of cases) {
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.reason).toBe("headless-denied")
    }
  })
})

describe("Elicitation — cliPrompter validation retry (HELL-E-02)", () => {
  test("validation error → 1 retry → typed validation-error on second violation", async () => {
    const io = scriptedIO(["", ""])
    const p = cliPrompter(io)
    // String schema with minLength:1 ⇒ empty string fails twice ⇒ validation-error.
    const r = await p.promptString({ prompt: "name", minLength: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("validation-error")
    // The retry prompt was written once after the first invalid line.
    expect(io.written.some((w) => w.includes("try once more"))).toBe(true)
  })

  test("validation succeeds on first retry → ok:true", async () => {
    const io = scriptedIO(["", "alice"])
    const p = cliPrompter(io)
    const r = await p.promptString({ prompt: "name", minLength: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBe("alice")
  })
})

describe("Elicitation — 7 schema round-trips (HELL-E-03..09)", () => {
  test("HELL-E-03 String (Untitled)", async () => {
    const io = scriptedIO(["hello"])
    const r = await cliPrompter(io).promptString({ prompt: "name" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBe("hello")
    // Untitled: no `[label]` prefix in the prompt.
    expect(io.written[0]).not.toContain("[")
  })

  test("HELL-E-03b String (Titled) renders the title", async () => {
    const io = scriptedIO(["bob"])
    await cliPrompter(io).promptString({ prompt: "name", title: "user" })
    expect(io.written[0]).toContain("[user]")
  })

  test("HELL-E-04 Number Titled accepts a valid number", async () => {
    const io = scriptedIO(["3.14"])
    const r = await cliPrompter(io).promptNumber({ prompt: "pi", title: "n" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBe(3.14)
  })

  test("HELL-E-05 Integer rejects non-integer real", async () => {
    const io = scriptedIO(["3.14", "3.14"])
    const r = await cliPrompter(io).promptInteger({ prompt: "n" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("invalid-input")
  })

  test("HELL-E-05b Integer Titled accepts a valid integer", async () => {
    const io = scriptedIO(["42"])
    const r = await cliPrompter(io).promptInteger({ prompt: "n", title: "count" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBe(42)
  })

  test("HELL-E-06 Boolean accepts y/n/true/false/1/0", async () => {
    for (const [raw, want] of [
      ["y", true],
      ["yes", true],
      ["true", true],
      ["1", true],
      ["n", false],
      ["no", false],
      ["false", false],
      ["0", false],
    ] as const) {
      const io = scriptedIO([raw])
      const r = await cliPrompter(io).promptBoolean({ prompt: "ok?" })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.value).toBe(want)
    }
  })

  test("HELL-E-07 Enum accepts 1-based index OR literal value", async () => {
    {
      const io = scriptedIO(["2"])
      const r = await cliPrompter(io).promptEnum({ prompt: "pick", options: ["a", "b", "c"] })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.value).toBe("b")
    }
    {
      const io = scriptedIO(["c"])
      const r = await cliPrompter(io).promptEnum({ prompt: "pick", options: ["a", "b", "c"] })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.value).toBe("c")
    }
  })

  test("HELL-E-08 MultiSelectEnum accepts comma-list, dedups, applies min/max", async () => {
    const io = scriptedIO(["1, 2, 1"])
    const r = await cliPrompter(io).promptMultiEnum({
      prompt: "pick",
      options: ["a", "b", "c"],
      minSelected: 1,
      maxSelected: 3,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toEqual(["a", "b"])
  })

  test("HELL-E-08b MultiSelectEnum rejects under minSelected", async () => {
    const io = scriptedIO(["1", "1"])
    const r = await cliPrompter(io).promptMultiEnum({
      prompt: "pick",
      options: ["a", "b", "c"],
      minSelected: 2,
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("validation-error")
  })

  test("HELL-E-09 SingleSelectEnum mirrors Enum semantics", async () => {
    const io = scriptedIO(["1"])
    const r = await cliPrompter(io).promptSingleEnum({ prompt: "pick", options: ["a", "b"] })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBe("a")
  })
})

describe("Elicitation — AbortSignal (HELL-E-10)", () => {
  test("aborted signal yields cancelled (no validation/retry attempts)", async () => {
    const io = scriptedIO([])
    const ac = new AbortController()
    ac.abort()
    const r = await cliPrompter(io).promptString({ prompt: "q" }, ac.signal)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("cancelled")
  })

  test("EOF on stdin (read → null) surfaces as cancelled", async () => {
    const io = scriptedIO([null])
    const r = await cliPrompter(io).promptString({ prompt: "q" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("cancelled")
  })
})

describe("Elicitation — empty options (HELL-E-11)", () => {
  test("Enum with [] short-circuits to empty-enum BEFORE prompting (no IO)", async () => {
    const io = scriptedIO([])
    const r = await cliPrompter(io).promptEnum({ prompt: "q", options: [] as never })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("empty-enum")
    expect(io.written).toEqual([])
  })

  test("MultiSelect with [] short-circuits to empty-enum", async () => {
    const io = scriptedIO([])
    const r = await cliPrompter(io).promptMultiEnum({ prompt: "q", options: [] as never })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("empty-enum")
  })

  test("Single with [] short-circuits to empty-enum", async () => {
    const io = scriptedIO([])
    const r = await cliPrompter(io).promptSingleEnum({ prompt: "q", options: [] as never })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("empty-enum")
  })
})

describe("Elicitation — Number/Integer non-finite (HELL-E-12)", () => {
  test("Number rejects NaN", async () => {
    const io = scriptedIO(["NaN", "NaN"])
    const r = await cliPrompter(io).promptNumber({ prompt: "n" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("invalid-input")
  })

  test("Number rejects Infinity / -Infinity", async () => {
    const io = scriptedIO(["Infinity", "-Infinity"])
    const r = await cliPrompter(io).promptNumber({ prompt: "n" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("invalid-input")
  })

  test("Integer rejects NaN/Infinity", async () => {
    const io = scriptedIO(["NaN", "Infinity"])
    const r = await cliPrompter(io).promptInteger({ prompt: "n" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("invalid-input")
  })
})
