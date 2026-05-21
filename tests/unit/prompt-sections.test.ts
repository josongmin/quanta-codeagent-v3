import { describe, expect, test } from "bun:test"
import { buildSystemPrompt, buildTurnContext, type TurnContextInput } from "@/agent"
import {
  buildSectionedSystemBlocks,
  defaultPromptSections,
  MAX_CACHE_BREAKPOINTS,
  type SystemPromptSection,
  validateSectionsCacheBudget,
} from "@/agent/prompt-sections"
import type { Message, SystemBlock } from "@/llm"

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "do it" }] }]

const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  planMode: false,
  ...over,
})

describe("defaultPromptSections", () => {
  test("returns a one-section list with name 'base', given text, and cache:true", () => {
    const sections = defaultPromptSections("hi")
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe("base")
    expect(sections[0]?.text).toBe("hi")
    expect(sections[0]?.cache).toBe(true)
  })
})

describe("buildSectionedSystemBlocks", () => {
  test("empty input yields empty output", () => {
    expect(buildSectionedSystemBlocks([])).toEqual([])
  })

  test("section without cache flag produces a block with NO cache field", () => {
    const blocks = buildSectionedSystemBlocks([{ name: "a", text: "x" }])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ type: "text", text: "x" })
    expect(blocks[0]?.cache).toBeUndefined()
    expect(Object.hasOwn(blocks[0] as object, "cache")).toBe(false)
  })

  test("section with cache:true produces a block with cache:true", () => {
    const blocks = buildSectionedSystemBlocks([{ name: "a", text: "x", cache: true }])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ type: "text", text: "x", cache: true })
  })

  test("empty / whitespace-only text is filtered out", () => {
    const blocks = buildSectionedSystemBlocks([
      { name: "blank", text: "" },
      { name: "spaces", text: "   \n\t" },
      { name: "real", text: "ok" },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toBe("ok")
  })

  test("preserves section order", () => {
    const blocks = buildSectionedSystemBlocks([
      { name: "a", text: "AAA" },
      { name: "b", text: "BBB" },
      { name: "c", text: "CCC" },
    ])
    expect(blocks.map((b) => b.text)).toEqual(["AAA", "BBB", "CCC"])
  })

  test("section with cache:false is treated as 'no breakpoint' (cache field omitted)", () => {
    const blocks = buildSectionedSystemBlocks([{ name: "a", text: "x", cache: false }])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.cache).toBeUndefined()
    expect(Object.hasOwn(blocks[0] as object, "cache")).toBe(false)
  })
})

describe("validateSectionsCacheBudget", () => {
  test("returns ok:true for zero cached sections", () => {
    expect(validateSectionsCacheBudget([])).toEqual({ ok: true })
    expect(validateSectionsCacheBudget([{ name: "a", text: "x" }])).toEqual({ ok: true })
  })

  test("returns ok:true for exactly MAX_CACHE_BREAKPOINTS cached", () => {
    const sections: SystemPromptSection[] = Array.from(
      { length: MAX_CACHE_BREAKPOINTS },
      (_, i) => ({ name: `s${i}`, text: `t${i}`, cache: true }),
    )
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: true })
  })

  test("returns ok:false with cached count when exceeding 4 cached", () => {
    const sections: SystemPromptSection[] = Array.from({ length: 5 }, (_, i) => ({
      name: `s${i}`,
      text: `t${i}`,
      cache: true,
    }))
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: false, cached: 5 })
  })

  test("uncached sections do not count toward the cap", () => {
    const sections: SystemPromptSection[] = [
      { name: "a", text: "x", cache: true },
      { name: "b", text: "y" },
      { name: "c", text: "z" },
      { name: "d", text: "w", cache: false },
    ]
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: true })
  })
})

describe("buildTurnContext + sections", () => {
  test("defaultPromptSections('hello') produces ONE block byte-equivalent to legacy single-prefix path", () => {
    const legacy = buildTurnContext(base({ system: "hello" }))
    const sectioned = buildTurnContext(base({ systemSections: defaultPromptSections("hello") }))
    expect(JSON.stringify(sectioned.system)).toBe(JSON.stringify(legacy.system))
    expect(sectioned.system).toHaveLength(1)
    expect(sectioned.system[0]).toEqual({ type: "text", text: "hello", cache: true })
  })

  test("two sections (cached base + uncached skills) produce two ordered blocks", () => {
    const { system } = buildTurnContext(
      base({
        systemSections: [
          { name: "base", text: "A", cache: true },
          { name: "skills", text: "B" },
        ],
      }),
    )
    expect(system).toHaveLength(2)
    expect(system[0]).toEqual({ type: "text", text: "A", cache: true })
    expect(system[1]).toEqual({ type: "text", text: "B" })
    expect(system[1]?.cache).toBeUndefined()
  })

  test("legacy path (no system, no systemSections) is byte-identical to today's single-prefix output", () => {
    const { system } = buildTurnContext(base())
    expect(system).toHaveLength(1)
    expect(system[0]?.type).toBe("text")
    expect(system[0]?.cache).toBe(true)
    expect(system[0]?.text).toBe(buildSystemPrompt())
    // Pin the SystemBlock shape: type + text + cache only, no surprise fields.
    const keys = Object.keys(system[0] as SystemBlock).sort()
    expect(keys).toEqual(["cache", "text", "type"])
  })

  test("systemSections with all-blank entries falls back to the legacy single-prefix path", () => {
    const legacy = buildTurnContext(base())
    const fallback = buildTurnContext(
      base({
        systemSections: [
          { name: "blank", text: "" },
          { name: "spaces", text: "   \n  " },
        ],
      }),
    )
    expect(JSON.stringify(fallback.system)).toBe(JSON.stringify(legacy.system))
    expect(fallback.system).toHaveLength(1)
    expect(fallback.system[0]?.text).toBe(buildSystemPrompt())
    expect(fallback.system[0]?.cache).toBe(true)
  })

  test("when BOTH system and systemSections are provided, systemSections wins (precedence)", () => {
    const { system } = buildTurnContext(
      base({
        system: "LEGACY-SHOULD-NOT-APPEAR",
        systemSections: [
          { name: "base", text: "FROM-SECTIONS", cache: true },
          { name: "tail", text: "TAIL" },
        ],
      }),
    )
    expect(system).toHaveLength(2)
    expect(system[0]?.text).toBe("FROM-SECTIONS")
    expect(system[1]?.text).toBe("TAIL")
    expect(system.some((b) => b.text === "LEGACY-SHOULD-NOT-APPEAR")).toBe(false)
  })
})
