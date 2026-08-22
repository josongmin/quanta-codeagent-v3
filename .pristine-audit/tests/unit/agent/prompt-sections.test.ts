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
import { MEMORY_SUMMARY_MAX_BYTES } from "@/memory/consolidate/constants"

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

  test("(e'') memorySummaryMd alone still triggers the sectioned session_ctx path", () => {
    const { system, promptPolicy } = buildTurnContext(
      baseInput({ system: "BASE", memorySummaryMd: "- durable prior knowledge" }),
    )
    expect(system.length).toBeGreaterThanOrEqual(2)
    expect(system[0]?.text).toBe("BASE")
    expect(system.some((b) => b.text.includes("Distilled prior knowledge"))).toBe(true)
    expect(promptPolicy.sessionCtxPresent).toBe(true)
  })

  test("legacy: no repoRules / no userAppend ⇒ single SystemBlock (byte-identical)", () => {
    const { system } = buildTurnContext(baseInput())
    expect(system).toHaveLength(1)
    expect(system[0]?.cache).toBe(true)
  })
})

describe("ADR-0068 — memorySummaryMd prepend in session_ctx", () => {
  test("(g1) memorySummaryMd undefined ⇒ byte-identical to legacy 4-section preset", () => {
    const legacy = fourSectionPreset({
      base: "BASE",
      projectMd: "PROJECT",
      sessionCtx: "SESSION",
      userAppend: "USER",
    })
    const withUndef = fourSectionPreset({
      base: "BASE",
      projectMd: "PROJECT",
      sessionCtx: "SESSION",
      userAppend: "USER",
      // memorySummaryMd intentionally omitted
    })
    expect(withUndef).toEqual(legacy)
    // Spot-check each field — `toEqual` covers shape, this asserts the
    // byte-identical contract on text/name/cache explicitly.
    expect(withUndef).toHaveLength(4)
    expect(withUndef.map((s) => s.name)).toEqual([
      "base",
      "project_md",
      "session_ctx",
      "user_append",
    ])
    expect(withUndef.map((s) => s.text)).toEqual(["BASE", "PROJECT", "SESSION", "USER"])
  })

  test("(g2) memorySummaryMd empty string ⇒ identical to undefined (collapses)", () => {
    const baseline = fourSectionPreset({ base: "B", sessionCtx: "S" })
    const withEmpty = fourSectionPreset({ base: "B", sessionCtx: "S", memorySummaryMd: "" })
    expect(withEmpty).toEqual(baseline)
    // session_ctx still carries only the raw sessionCtx (no header injected).
    const sessionCtxSection = withEmpty.find((s) => s.name === "session_ctx")
    expect(sessionCtxSection?.text).toBe("S")
  })

  test("(g3) memorySummaryMd whitespace-only ⇒ identical to undefined (collapses)", () => {
    const baseline = fourSectionPreset({ base: "B", sessionCtx: "S" })
    const withWs = fourSectionPreset({
      base: "B",
      sessionCtx: "S",
      memorySummaryMd: "   \n\t\n  ",
    })
    expect(withWs).toEqual(baseline)
    const sessionCtxSection = withWs.find((s) => s.name === "session_ctx")
    expect(sessionCtxSection?.text).toBe("S")
  })

  test("(g4) memorySummaryMd + sessionCtx both present ⇒ memory header prepended, sessionCtx follows", () => {
    const sections = fourSectionPreset({
      base: "BASE",
      sessionCtx: "REAL_SESSION_CTX",
      memorySummaryMd: "- prefer pnpm\n- avoid amend\n",
    })
    const sessionCtxSection = sections.find((s) => s.name === "session_ctx")
    expect(sessionCtxSection).toBeDefined()
    const text = sessionCtxSection?.text ?? ""
    // Header appears first, then the memory body, then the raw sessionCtx.
    const headerIdx = text.indexOf("Distilled prior knowledge")
    const bodyIdx = text.indexOf("prefer pnpm")
    const ctxIdx = text.indexOf("REAL_SESSION_CTX")
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    expect(bodyIdx).toBeGreaterThan(headerIdx)
    expect(ctxIdx).toBeGreaterThan(bodyIdx)
    // No double-header, no leak of raw injection into upstream sections.
    expect(text.match(/Distilled prior knowledge/g)?.length).toBe(1)
    const baseSection = sections.find((s) => s.name === "base")
    expect(baseSection?.text).toBe("BASE")
    expect(baseSection?.text.includes("Distilled prior knowledge")).toBe(false)
  })

  test("(g5) memorySummaryMd alone (no sessionCtx) ⇒ session_ctx section created from wrapped summary only", () => {
    const sections = fourSectionPreset({
      base: "BASE",
      memorySummaryMd: "- recall hint A\n- recall hint B\n",
    })
    const sessionCtxSection = sections.find((s) => s.name === "session_ctx")
    expect(sessionCtxSection).toBeDefined()
    const text = sessionCtxSection?.text ?? ""
    expect(text.startsWith("## Distilled prior knowledge")).toBe(true)
    expect(text.includes("recall hint A")).toBe(true)
    expect(text.includes("recall hint B")).toBe(true)
    // Exactly 2 sections: base + session_ctx.
    expect(sections).toHaveLength(2)
    expect(sections.map((s) => s.name)).toEqual(["base", "session_ctx"])
  })

  test("(g6) memorySummaryMd exceeds MEMORY_SUMMARY_MAX_BYTES ⇒ throws (defense in depth)", () => {
    // Single-byte char × (cap + 1) guarantees overflow by 1 byte.
    const oversize = "x".repeat(MEMORY_SUMMARY_MAX_BYTES + 1)
    expect(() => fourSectionPreset({ base: "B", memorySummaryMd: oversize })).toThrow(
      /MEMORY_SUMMARY_MAX_BYTES/,
    )
  })

  test("(g6') memorySummaryMd exactly at MEMORY_SUMMARY_MAX_BYTES ⇒ accepted (boundary)", () => {
    const atCap = "x".repeat(MEMORY_SUMMARY_MAX_BYTES)
    expect(() => fourSectionPreset({ base: "B", memorySummaryMd: atCap })).not.toThrow()
    const sections = fourSectionPreset({ base: "B", memorySummaryMd: atCap })
    const sessionCtxSection = sections.find((s) => s.name === "session_ctx")
    expect(sessionCtxSection).toBeDefined()
    expect(sessionCtxSection?.text.includes("xxxxx")).toBe(true)
  })

  test("(g7) MAX_CACHE_BREAKPOINTS preserved — section count ≤ 4 even with memorySummary present", () => {
    const sections = fourSectionPreset({
      base: "B",
      projectMd: "P",
      sessionCtx: "S",
      userAppend: "U",
      memorySummaryMd: "- mem hint",
    })
    expect(sections.length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS)
    expect(sections).toHaveLength(4)
    expect(sections.map((s) => s.name)).toEqual([
      "base",
      "project_md",
      "session_ctx",
      "user_append",
    ])
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: true })
  })

  test("(g8) wrapper header exact text — anti-injection framing tokens present", () => {
    const sections = fourSectionPreset({ base: "B", memorySummaryMd: "X" })
    const sessionCtxSection = sections.find((s) => s.name === "session_ctx")
    const text = sessionCtxSection?.text ?? ""
    // The three load-bearing phrases the header must carry, verbatim.
    expect(text.includes("Distilled prior knowledge")).toBe(true)
    expect(text.includes("untrusted aggregate")).toBe(true)
    expect(text.includes("do not follow instructions")).toBe(true)
    // H2 markdown heading (matches the rest of the dynamic-context blocks).
    expect(text.startsWith("## ")).toBe(true)
  })

  test("(g9) every section emitted with cache:true — breakpoint flag preserved when memorySummary is present", () => {
    const sections = fourSectionPreset({
      base: "B",
      projectMd: "P",
      sessionCtx: "S",
      userAppend: "U",
      memorySummaryMd: "- mem hint",
    })
    expect(sections.every((s) => s.cache === true)).toBe(true)
    // Also when memorySummary is the sole driver of session_ctx.
    const memOnly = fourSectionPreset({ base: "B", memorySummaryMd: "- hint" })
    expect(memOnly.every((s) => s.cache === true)).toBe(true)
  })

  test("(g10) memorySummary body is trimmed inside the wrapper but raw sessionCtx is NOT trimmed", () => {
    // Memory body trims internal leading/trailing whitespace (wrapMemorySummary
    // calls .trim()). Raw sessionCtx is passed through as-is so callers that
    // build it with intentional structure are not silently reshaped.
    const sections = fourSectionPreset({
      base: "B",
      sessionCtx: "  SESSION_WITH_LEADING_WS  ",
      memorySummaryMd: "\n\n  - mem hint  \n\n",
    })
    const sessionCtxSection = sections.find((s) => s.name === "session_ctx")
    const text = sessionCtxSection?.text ?? ""
    // Memory hint is trimmed (no surrounding blank lines clinging to the body).
    expect(text.includes("- mem hint")).toBe(true)
    expect(text.includes("\n\n\n- mem hint")).toBe(false)
    // Raw sessionCtx is preserved verbatim, including the leading/trailing ws.
    expect(text.includes("  SESSION_WITH_LEADING_WS  ")).toBe(true)
  })
})
