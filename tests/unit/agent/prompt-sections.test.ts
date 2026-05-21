/**
 * Sectioned system prompt assembly tests.
 *
 * Mirrors Claude Desktop 1.7196.3's `systemPromptSectionCache` 4-section
 * pattern: `base + project_md(CLAUDE.md) + session_ctx + user_append`,
 * each flagged with `cache:true` and capped at Anthropic's 4-breakpoint
 * provider limit.
 *
 * Contract:
 *   - `fourSectionPreset` builds 1..4 ordered sections, base always present.
 *   - Missing/empty optional inputs collapse the section (no empty blocks).
 *   - `validateSectionsCacheBudget` returns `{ok:true}` for any preset output.
 *   - `buildTurnContext` auto-wires sectioned system blocks when repoRules.text
 *     OR userAppend is present (legacy callers stay byte-identical: 1 block).
 */
import { describe, expect, test } from "bun:test"
import type { TurnContextInput } from "@/agent"
import { buildTurnContext } from "@/agent"
import {
  buildSectionedSystemBlocks,
  defaultPromptSections,
  fourSectionPreset,
  MAX_CACHE_BREAKPOINTS,
  validateSectionsCacheBudget,
} from "@/agent/prompt-sections"
import type { Message } from "@/llm"

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]

const baseInput = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  planMode: false,
  ...over,
})

describe("prompt-sections — base utilities", () => {
  test("MAX_CACHE_BREAKPOINTS is 4 (Anthropic cache_control cap)", () => {
    expect(MAX_CACHE_BREAKPOINTS).toBe(4)
  })

  test("buildSectionedSystemBlocks renders one cached text block per section, in order", () => {
    const blocks = buildSectionedSystemBlocks([
      { name: "a", text: "A", cache: true },
      { name: "b", text: "B", cache: true },
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: "text", text: "A", cache: true })
    expect(blocks[1]).toEqual({ type: "text", text: "B", cache: true })
  })

  test("defaultPromptSections produces a single cached section from basePrompt", () => {
    const sections = defaultPromptSections("BASE")
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe("base")
    expect(sections[0]?.text).toBe("BASE")
    expect(sections[0]?.cache).toBe(true)
  })

  test("validateSectionsCacheBudget — ok for <=4 cached sections", () => {
    const sections = [
      { name: "a", text: "A", cache: true },
      { name: "b", text: "B", cache: true },
      { name: "c", text: "C", cache: true },
      { name: "d", text: "D", cache: true },
    ]
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: true })
  })

  test("validateSectionsCacheBudget — over budget for >4 cached sections", () => {
    const sections = [
      { name: "a", text: "A", cache: true },
      { name: "b", text: "B", cache: true },
      { name: "c", text: "C", cache: true },
      { name: "d", text: "D", cache: true },
      { name: "e", text: "E", cache: true },
    ]
    const v = validateSectionsCacheBudget(sections)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.cachedCount).toBe(5)
      expect(v.limit).toBe(4)
    }
  })
})

describe("prompt-sections — fourSectionPreset (Claude Desktop pattern)", () => {
  test("(a) full preset yields 4 ordered cached sections", () => {
    const sections = fourSectionPreset({
      base: "BASE",
      projectMd: "PROJECT",
      sessionCtx: "SESSION",
      userAppend: "USER",
    })
    expect(sections).toHaveLength(4)
    expect(sections.map((s) => s.name)).toEqual([
      "base",
      "project_md",
      "session_ctx",
      "user_append",
    ])
    expect(sections.map((s) => s.text)).toEqual(["BASE", "PROJECT", "SESSION", "USER"])
    expect(sections.every((s) => s.cache === true)).toBe(true)
  })

  test("(b) missing optional inputs collapse — only base section remains", () => {
    const sections = fourSectionPreset({ base: "BASE" })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe("base")
    expect(sections[0]?.text).toBe("BASE")
  })

  test("(b') partial preset preserves declared order (project + user only)", () => {
    const sections = fourSectionPreset({
      base: "B",
      projectMd: "P",
      userAppend: "U",
    })
    expect(sections.map((s) => s.name)).toEqual(["base", "project_md", "user_append"])
  })

  test("(c) empty / whitespace-only optional inputs collapse to base-only", () => {
    const sections = fourSectionPreset({
      base: "BASE",
      projectMd: "",
      sessionCtx: "   \n  ",
      userAppend: "",
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe("base")
  })

  test("(d) validateSectionsCacheBudget on fourSectionPreset is always ok", () => {
    const full = fourSectionPreset({
      base: "B",
      projectMd: "P",
      sessionCtx: "S",
      userAppend: "U",
    })
    expect(validateSectionsCacheBudget(full)).toEqual({ ok: true })
    const baseOnly = fourSectionPreset({ base: "B" })
    expect(validateSectionsCacheBudget(baseOnly)).toEqual({ ok: true })
  })
})

describe("buildTurnContext — auto-wire 4-section preset", () => {
  test("(e) repoRules.text OR userAppend present ⇒ sectioned system in declared order", () => {
    const { system } = buildTurnContext(
      baseInput({
        system: "BASE",
        repoRules: {
          sourcePath: "/repo/CLAUDE.md",
          entrypoint: "CLAUDE.md",
          body: "X",
          loadedAt: 0,
        },
        userAppend: "Y",
      }),
    )
    // At least 3 sections: base + project_md + user_append. session_ctx is
    // optional (caller-supplied statics) and may be absent.
    expect(system.length).toBeGreaterThanOrEqual(3)
    expect(system.length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS)
    // Order check: base first, project_md before user_append.
    expect(system[0]?.text).toBe("BASE")
    const texts = system.map((b) => b.text)
    const projectIdx = texts.findIndex((t) => t.includes("X"))
    const userIdx = texts.findIndex((t) => t.includes("Y"))
    expect(projectIdx).toBeGreaterThan(0)
    expect(userIdx).toBeGreaterThan(projectIdx)
    // All sectioned blocks carry cache:true.
    expect(system.every((b) => b.cache === true)).toBe(true)
  })

  test("(e') userAppend alone (no repoRules) still triggers sectioned path", () => {
    const { system } = buildTurnContext(baseInput({ system: "BASE", userAppend: "APPEND" }))
    expect(system.length).toBeGreaterThanOrEqual(2)
    expect(system[0]?.text).toBe("BASE")
    expect(system.some((b) => b.text === "APPEND")).toBe(true)
  })

  test("legacy: no repoRules / no userAppend ⇒ single SystemBlock (byte-identical)", () => {
    const { system } = buildTurnContext(baseInput())
    expect(system).toHaveLength(1)
    expect(system[0]?.cache).toBe(true)
  })
})
