/**
 * ★ CONTRACT — C4: ADR-0004 cache prefix (src/agent/prompt-sections.ts).
 *   `fourSectionPreset` + `MAX_CACHE_BREAKPOINTS = 4` cap is HARD — with 5
 *   cacheable inputs (base + project_md + session_ctx + user_append +
 *   memorySummary), the section count stays ≤ 4 (memorySummary coalesces with
 *   session_ctx). `validateSectionsCacheBudget` rejects a hand-built 5-cached
 *   list. cache:false sections do not consume budget. Cached prefix is byte-
 *   identical across turns (per-turn churn lives in trailing user, not prefix).
 */
import { describe, expect, test } from "bun:test"
import type { TurnContextInput } from "@/agent"
import { buildTurnContext } from "@/agent"
import {
  buildSectionedSystemBlocks,
  fourSectionPreset,
  MAX_CACHE_BREAKPOINTS,
  validateSectionsCacheBudget,
} from "@/agent/prompt-sections"
import type { Message } from "@/llm"
import { MEMORY_SUMMARY_MAX_BYTES } from "@/memory/consolidate/constants"

/**
 * C4 — cache breakpoint cap HELLGATE.
 *
 * Anthropic rejects a request with more than {@link MAX_CACHE_BREAKPOINTS} (4)
 * `cache_control` markers. `fourSectionPreset` is the chokepoint: it must NEVER
 * emit a 5th cached section even when more than four cacheable inputs are
 * present (base + project_md + session_ctx + user_append + memorySummary +
 * "extra"). The deterministic cap policy is COALESCE, not drop: memorySummary
 * rides the SAME `session_ctx` breakpoint instead of allocating its own. We pin
 * that rule exactly so a future refactor that "fixes" it into a 5th block fails
 * the build.
 */

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]

const baseInput = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  planMode: false,
  ...over,
})

describe("C4 hellgate — preset caps cached sections at MAX_CACHE_BREAKPOINTS", () => {
  test("ALL five+ cacheable inputs present ⇒ exactly 4 sections, never 5+", () => {
    // base + projectMd + sessionCtx + userAppend + memorySummaryMd — five
    // distinct cacheable inputs. The cap policy coalesces memorySummary into
    // session_ctx so the breakpoint count stays 4.
    const sections = fourSectionPreset({
      base: "BASE",
      projectMd: "PROJECT",
      sessionCtx: "SESSION",
      userAppend: "USER",
      memorySummaryMd: "- distilled hint",
    })
    expect(sections).toHaveLength(MAX_CACHE_BREAKPOINTS)
    expect(sections.length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS)
    // The exact ordered breakpoint identity — no 5th `memory_summary` block.
    expect(sections.map((s) => s.name)).toEqual([
      "base",
      "project_md",
      "session_ctx",
      "user_append",
    ])
    // Every section is a real breakpoint.
    expect(sections.every((s) => s.cache === true)).toBe(true)
    const cachedCount = sections.filter((s) => s.cache).length
    expect(cachedCount).toBe(4)
    expect(cachedCount).not.toBeGreaterThan(MAX_CACHE_BREAKPOINTS)
    // And the validator agrees the budget holds.
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: true })
  })

  test("the memorySummary 5th input is COALESCED into session_ctx (deterministic selection rule)", () => {
    const sections = fourSectionPreset({
      base: "BASE",
      projectMd: "PROJECT",
      sessionCtx: "REAL_SESSION_CTX",
      userAppend: "USER",
      memorySummaryMd: "- coalesced hint body",
    })
    const sessionCtx = sections.find((s) => s.name === "session_ctx")
    expect(sessionCtx).toBeDefined()
    const text = sessionCtx?.text ?? ""
    // The memory body rides the session_ctx breakpoint, ordered FIRST, then the
    // real session ctx — proving coalesce (not a dropped 5th block, not a
    // dropped memory input).
    const memIdx = text.indexOf("coalesced hint body")
    const ctxIdx = text.indexOf("REAL_SESSION_CTX")
    expect(memIdx).toBeGreaterThanOrEqual(0)
    expect(ctxIdx).toBeGreaterThan(memIdx)
    // No standalone memory_summary breakpoint leaked anywhere.
    expect(sections.some((s) => s.name === "memory_summary")).toBe(false)
    expect(sections.some((s) => s.name === "memorySummary")).toBe(false)
  })

  test("wire-level: even with 4 stamped breakpoints, validator stays ok and count never exceeds 4", () => {
    // Drive the full assembly through buildTurnContext, which is what callers
    // actually hit. With projectMd + sessionCtx + userAppend the sectioned
    // path activates; assert the emitted SystemBlock[] is ≤ 4 and every flagged
    // block carries cache:true (the breakpoint the adapter stamps).
    const { system } = buildTurnContext(
      baseInput({
        system: "BASE",
        repoRules: {
          sourcePath: "/repo/CLAUDE.md",
          entrypoint: "CLAUDE.md",
          body: "PROJECT-RULES",
          loadedAt: 0,
        },
        sessionCtx: "STATIC-SESSION",
        userAppend: "USER-APPEND",
      }),
    )
    expect(system.length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS)
    const stamped = system.filter((b) => b.cache === true).length
    expect(stamped).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS)
    expect(stamped).toBe(system.length)
  })
})

describe("C4 hellgate — validator deterministically rejects an over-cap section list", () => {
  test("a hand-built 5-cached-section list is rejected with the exact overflow verdict", () => {
    // The preset cannot produce this by construction, but the validator is the
    // last-line defense if a future caller hand-assembles sections. Assert the
    // deterministic verdict shape.
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
      expect(v.limit).toBe(MAX_CACHE_BREAKPOINTS)
    }
  })

  test("cache:false sections do NOT consume a breakpoint (cap counts only true)", () => {
    // 6 sections but only 4 cached → under cap. This pins the rule that the cap
    // is about cache_control markers, not section count.
    const sections = [
      { name: "a", text: "A", cache: true },
      { name: "b", text: "B", cache: false },
      { name: "c", text: "C", cache: true },
      { name: "d", text: "D", cache: false },
      { name: "e", text: "E", cache: true },
      { name: "f", text: "F", cache: true },
    ]
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: true })
    const blocks = buildSectionedSystemBlocks(sections)
    expect(blocks.filter((b) => b.cache).length).toBe(4)
  })
})

describe("C4 hellgate — empty / single-section edges do not crash", () => {
  test("zero optional inputs ⇒ base-only single breakpoint", () => {
    const sections = fourSectionPreset({ base: "ONLY_BASE" })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe("base")
    expect(sections[0]?.cache).toBe(true)
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: true })
  })

  test("empty section list ⇒ validator ok, zero breakpoints, no crash", () => {
    expect(validateSectionsCacheBudget([])).toEqual({ ok: true })
    expect(buildSectionedSystemBlocks([])).toEqual([])
  })

  test("all-whitespace optional inputs collapse to base-only (no empty blocks)", () => {
    const sections = fourSectionPreset({
      base: "BASE",
      projectMd: "   ",
      sessionCtx: "\n\t\n",
      userAppend: "",
      memorySummaryMd: "   \n  ",
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe("base")
    expect(validateSectionsCacheBudget(sections)).toEqual({ ok: true })
  })

  test("legacy single-block path: no sectioned inputs ⇒ exactly one cached SystemBlock", () => {
    const { system } = buildTurnContext(baseInput())
    expect(system).toHaveLength(1)
    expect(system[0]?.cache).toBe(true)
    expect(system.filter((b) => b.cache).length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS)
  })
})

describe("C4 hellgate — cap holds at the memorySummary byte boundary", () => {
  test("memorySummary exactly at cap with all other inputs ⇒ still 4 sections", () => {
    const atCap = "x".repeat(MEMORY_SUMMARY_MAX_BYTES)
    const sections = fourSectionPreset({
      base: "B",
      projectMd: "P",
      sessionCtx: "S",
      userAppend: "U",
      memorySummaryMd: atCap,
    })
    expect(sections).toHaveLength(MAX_CACHE_BREAKPOINTS)
    expect(sections.map((s) => s.name)).toEqual([
      "base",
      "project_md",
      "session_ctx",
      "user_append",
    ])
  })

  test("memorySummary 1 byte over cap throws BEFORE any section is emitted (fail-closed)", () => {
    const over = "x".repeat(MEMORY_SUMMARY_MAX_BYTES + 1)
    expect(() =>
      fourSectionPreset({
        base: "B",
        projectMd: "P",
        sessionCtx: "S",
        userAppend: "U",
        memorySummaryMd: over,
      }),
    ).toThrow(/MEMORY_SUMMARY_MAX_BYTES/)
  })
})
