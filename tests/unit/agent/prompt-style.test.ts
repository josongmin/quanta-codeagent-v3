/**
 * Prompt render STYLE axis (jul-6) — flat vs Codex-style `##` sections.
 *
 * Invariants:
 *   1. `flat` (default / absent) ⇒ byte-identical to the pre-axis prompt.
 *   2. The header allowlist is NOT stale: every SECTION_HEADER_LINES entry
 *      appears verbatim, col-0, in the default-rendered prompt.
 *   3. `sectioned` promotes EXACTLY the allowlisted headers to `## …` — one
 *      per entry, none leaked, line count preserved (1:1 map), lossless
 *      (parenthetical guidance retained in the heading).
 */

import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "@/agent"
import {
  applyPromptStyle,
  HEADER_INJECT_BEFORE,
  renderSectionHeader,
  SECTION_HEADER_LINES,
  SUBSECTION_HEADER_LINES,
} from "@/agent/prompt-style"

const INJECTED_LINES = HEADER_INJECT_BEFORE.flatMap((i) => [...i.block])
const INJECTED_H2 = INJECTED_LINES.filter((l) => l.startsWith("## ")).length

const flat = () => buildSystemPrompt(undefined, { promptPack: "batch" })
const sectioned = () =>
  buildSystemPrompt(undefined, { promptPack: "batch", promptStyle: "sectioned" })

describe("applyPromptStyle — flat is identity", () => {
  test("flat returns the input unchanged (byte-identical)", () => {
    const s = "Operating principles:\n- do a thing\nTrust and inputs:\n- another"
    expect(applyPromptStyle(s, "flat")).toBe(s)
  })

  test("buildSystemPrompt default ⇒ byte-identical to explicit flat", () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt(undefined, { promptStyle: "flat" }))
  })

  test("promptStyle omitted ⇒ byte-identical to flat across a loaded axis combo", () => {
    const omitted = buildSystemPrompt(undefined, { promptPack: "batch", persona: "codex" })
    const explicit = buildSystemPrompt(undefined, {
      promptPack: "batch",
      persona: "codex",
      promptStyle: "flat",
    })
    expect(omitted).toBe(explicit)
  })
})

describe("SECTION_HEADER_LINES allowlist is not stale", () => {
  test("every allowlisted header appears col-0 in the default prompt", () => {
    const lines = new Set(flat().split("\n"))
    for (const header of SECTION_HEADER_LINES) {
      expect(lines.has(header)).toBe(true)
    }
  })

  test("allowlist entries are unique", () => {
    expect(new Set(SECTION_HEADER_LINES).size).toBe(SECTION_HEADER_LINES.length)
  })

  test("every SUBSECTION entry is also a SECTION entry (subset relation)", () => {
    for (const sub of SUBSECTION_HEADER_LINES) {
      expect(SECTION_HEADER_LINES).toContain(sub)
    }
  })
})

describe("sectioned render", () => {
  test("header levels: ### per sub-section, ## for the rest + injected", () => {
    const lines = sectioned().split("\n")
    const h2 = lines.filter((l) => l.startsWith("## "))
    const h3 = lines.filter((l) => l.startsWith("### "))
    expect(h3).toHaveLength(SUBSECTION_HEADER_LINES.length)
    // ## = (top-level allowlist headers) + (## headers we inject before orphan blocks)
    expect(h2).toHaveLength(
      SECTION_HEADER_LINES.length - SUBSECTION_HEADER_LINES.length + INJECTED_H2,
    )
  })

  test("no allowlisted flat header survives un-promoted; its rendered form is present", () => {
    const secLines = new Set(sectioned().split("\n"))
    for (const header of SECTION_HEADER_LINES) {
      expect(secLines.has(header)).toBe(false)
      expect(secLines.has(renderSectionHeader(header))).toBe(true)
    }
  })

  test("F3 rename: the two 'Trust …' headers are disambiguated, collision gone", () => {
    const sec = sectioned()
    expect(sec).toContain("## Source-of-truth ladder (when sources disagree, the higher wins)")
    expect(sec).toContain("## Untrusted inputs & injection defense")
    expect(sec).not.toContain("## Trust ladder")
    expect(sec).not.toContain("## Trust and inputs")
  })

  test("F1 inject: orphan task-rule block gets a header, placed before [R-ENV]", () => {
    const lines = sectioned().split("\n")
    const hdr = lines.indexOf("## Environment & task rules")
    const rEnv = lines.findIndex((l) => l.startsWith("- [R-ENV]"))
    expect(hdr).toBeGreaterThan(-1)
    expect(rEnv).toBeGreaterThan(hdr)
    // …and nothing else sits between the injected header and the rule it heads.
    expect(lines.slice(hdr + 1, rEnv).every((l) => l === "")).toBe(true)
  })

  test("line count == flat + injected lines (only injection adds lines)", () => {
    expect(sectioned().split("\n")).toHaveLength(flat().split("\n").length + INJECTED_LINES.length)
  })

  test("content preserved: every non-header flat line survives verbatim", () => {
    const headerSet = new Set<string>(SECTION_HEADER_LINES)
    const secLines = new Set(sectioned().split("\n"))
    for (const line of flat().split("\n")) {
      if (headerSet.has(line)) continue // headers are rewritten, checked above
      expect(secLines.has(line)).toBe(true)
    }
  })

  test("does NOT touch indented body lines that happen to end with a colon", () => {
    // "  Verification:" (indented) is inside the Verification-report block and
    // must survive verbatim — only col-0 allowlisted headers are promoted.
    expect(sectioned()).toContain("  Verification:")
    expect(sectioned()).not.toContain("## Verification\n")
  })
})
