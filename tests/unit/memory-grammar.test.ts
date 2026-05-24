/**
 * ADR-0131 Phase D — preference phrase grammar tests.
 *
 * Coverage targets (ADR-0131 §2):
 *   - Korean quote preservation (no paraphrase, no normalization)
 *   - English quote preservation
 *   - Mixed-language quote
 *   - Confidence: count derivative (1/2/3+)
 *   - Confidence: explicit marker wins over count derivative
 *   - Evidence: file:line / URL / SHA forms (parser accepts all literally)
 *   - Substring + lowercase + whitespace tolerance in headers
 *   - Empty / malformed input → `{}` (never throws)
 *   - Lint W1/W2/W3 fire on the documented inputs and stay silent otherwise
 */

import { describe, expect, test } from "bun:test"
import { lintMemoryFrontmatter, parsePreferenceSignal } from "../../src/memory/consolidate"

describe("ADR-0131 — parsePreferenceSignal: quote extraction", () => {
  test("Korean quote preserved byte-for-byte", () => {
    const body = '**When the user said** "코드 레벨로만"\n**They meant**: narrow'
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBe("코드 레벨로만")
  })

  test("English quote preserved with case + punctuation", () => {
    const body = '**When the user said** "Use bun, NOT npm."'
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBe("Use bun, NOT npm.")
  })

  test("Mixed Korean + English quote preserved", () => {
    const body = '**When the user said** "병렬로 / in parallel"'
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBe("병렬로 / in parallel")
  })

  test("Backtick-delimited quote also recognized", () => {
    const body = "**When the user said** `terse summaries`"
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBe("terse summaries")
  })

  test("Curly typographic quotes recognized (paste from word processor)", () => {
    const body = "**When the user said** “no docs”"
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBe("no docs")
  })

  test("Header is case-insensitive and bold-optional", () => {
    const body = 'when the user said: "less verbose"'
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBe("less verbose")
  })

  test("Header tolerates extra whitespace + newlines between header and quote", () => {
    const body = '**When the user said**   "spaced out"'
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBe("spaced out")
  })

  test("Whitespace inside the quote is preserved literally", () => {
    const body = '**When the user said** "  trim  outer  "'
    const s = parsePreferenceSignal(body)
    // outer leading/trailing trimmed; inner double-space preserved
    expect(s.quote).toBe("trim  outer")
  })

  test("No quote → quote field absent (not empty string)", () => {
    const body = "**They meant**: narrow"
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBeUndefined()
  })

  test("Empty quote ('') is rejected (not coerced)", () => {
    const body = '**When the user said** ""'
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBeUndefined()
  })
})

describe("ADR-0131 — parsePreferenceSignal: evidence extraction", () => {
  test("file:line evidence captured verbatim", () => {
    const body = "**Evidence**: src/foo.ts:42"
    const s = parsePreferenceSignal(body)
    expect(s.evidence).toBe("src/foo.ts:42")
  })

  test("file:line-range evidence captured", () => {
    const body = "**Evidence**: ../sessions/2026-05-23-x.md L42-L51"
    const s = parsePreferenceSignal(body)
    expect(s.evidence).toBe("../sessions/2026-05-23-x.md L42-L51")
  })

  test("URL evidence captured", () => {
    const body = "Evidence: https://example.com/issue/123"
    const s = parsePreferenceSignal(body)
    expect(s.evidence).toBe("https://example.com/issue/123")
  })

  test("Commit-SHA evidence captured", () => {
    const body = "Evidence: a1b2c3d4e5f"
    const s = parsePreferenceSignal(body)
    expect(s.evidence).toBe("a1b2c3d4e5f")
  })

  test("Evidence with parenthetical annotation preserved", () => {
    const body = "**Evidence**: src/foo.ts:42 (3 corrections same week)"
    const s = parsePreferenceSignal(body)
    expect(s.evidence).toBe("src/foo.ts:42 (3 corrections same week)")
  })

  test("Multi-line body: evidence capture is line-bound (does not eat the next paragraph)", () => {
    const body = "**Evidence**: src/foo.ts:42\n\n**Confidence**: low"
    const s = parsePreferenceSignal(body)
    expect(s.evidence).toBe("src/foo.ts:42")
  })
})

describe("ADR-0131 — parsePreferenceSignal: confidence (count derivative + explicit)", () => {
  test("1 correction → low", () => {
    const s = parsePreferenceSignal("**Confidence**: derived from 1 correction")
    expect(s.confidence).toBe("low")
  })

  test("2 corrections → medium", () => {
    const s = parsePreferenceSignal("seen 2 corrections same week")
    expect(s.confidence).toBe("medium")
  })

  test("3 corrections → high", () => {
    const s = parsePreferenceSignal("seen 3 corrections same week")
    expect(s.confidence).toBe("high")
  })

  test("10 corrections → high (still high above 3)", () => {
    const s = parsePreferenceSignal("seen 10 corrections")
    expect(s.confidence).toBe("high")
  })

  test("'repetitions' alternative noun also drives count derivative", () => {
    const s = parsePreferenceSignal("noted 2 repetitions")
    expect(s.confidence).toBe("medium")
  })

  test("Explicit marker 'Confidence: medium' wins over a count of 3+", () => {
    const s = parsePreferenceSignal("**Confidence**: medium — based on 5 corrections")
    expect(s.confidence).toBe("medium")
  })

  test("Explicit marker is case-insensitive", () => {
    const s = parsePreferenceSignal("Confidence: HIGH")
    expect(s.confidence).toBe("high")
  })

  test("Invalid explicit level falls through to count derivative", () => {
    const s = parsePreferenceSignal("Confidence: extremely-high — based on 2 corrections")
    expect(s.confidence).toBe("medium")
  })

  test("No confidence marker AND no count → confidence absent", () => {
    const s = parsePreferenceSignal('**When the user said** "X"')
    expect(s.confidence).toBeUndefined()
  })
})

describe("ADR-0131 — parsePreferenceSignal: combined + edge cases", () => {
  test("Full body returns all three fields", () => {
    const body = [
      '**When the user said** "코드 레벨로만"',
      "**They meant**: narrow",
      "**Evidence**: ../sessions/2026-05-23-x.md L42-L51",
      "**Confidence**: high (3 repetitions)",
    ].join("\n")
    const s = parsePreferenceSignal(body)
    expect(s.quote).toBe("코드 레벨로만")
    expect(s.evidence).toBe("../sessions/2026-05-23-x.md L42-L51")
    expect(s.confidence).toBe("high")
  })

  test("Empty input → empty signal (no throw)", () => {
    expect(parsePreferenceSignal("")).toEqual({})
  })

  test("Whitespace-only input → empty signal", () => {
    expect(parsePreferenceSignal("   \n\n   ")).toEqual({})
  })

  test("Body with all markers but invalid count → no confidence", () => {
    const s = parsePreferenceSignal('**When the user said** "X"\n**Evidence**: src/a.ts:1')
    expect(s.quote).toBe("X")
    expect(s.evidence).toBe("src/a.ts:1")
    expect(s.confidence).toBeUndefined()
  })

  test("Substring-style mention of `confidence` without colon does NOT trigger", () => {
    const s = parsePreferenceSignal("I have low confidence in this claim.")
    expect(s.confidence).toBeUndefined()
  })

  test("Non-string input (defensive) → empty signal", () => {
    // @ts-expect-error — intentionally exercising defensive guard
    expect(parsePreferenceSignal(null)).toEqual({})
    // @ts-expect-error
    expect(parsePreferenceSignal(undefined)).toEqual({})
  })
})

describe("ADR-0131 — lintMemoryFrontmatter: W1 outcome-evidence-missing", () => {
  test("outcome declared without evidence → W1 warning fires", () => {
    const md = ["---", "name: x", "outcome: success", "---", "body"].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.errors).toHaveLength(0)
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]?.rule).toBe("outcome-evidence-missing")
  })

  test("outcome AND valid evidence → no W1", () => {
    const md = [
      "---",
      "name: x",
      "outcome: success",
      "outcome_evidence: src/foo.ts:42",
      "---",
      "body",
    ].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.filter((w) => w.rule === "outcome-evidence-missing")).toHaveLength(0)
  })

  test("nested metadata.outcome without evidence still triggers W1", () => {
    const md = ["---", "metadata:", "  outcome: partial", "---", "body"].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.some((w) => w.rule === "outcome-evidence-missing")).toBe(true)
  })
})

describe("ADR-0131 — lintMemoryFrontmatter: W2 evidence shape", () => {
  test("file:line evidence passes", () => {
    const md = ["---", "outcome: success", "outcome_evidence: src/foo.ts:42", "---", ""].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.filter((w) => w.rule === "outcome-evidence-shape")).toHaveLength(0)
  })

  test("URL evidence passes", () => {
    const md = [
      "---",
      "outcome: success",
      "outcome_evidence: https://example.com/x",
      "---",
      "",
    ].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.filter((w) => w.rule === "outcome-evidence-shape")).toHaveLength(0)
  })

  test("SHA evidence passes", () => {
    const md = ["---", "outcome: success", "outcome_evidence: a1b2c3d4e5f6", "---", ""].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.filter((w) => w.rule === "outcome-evidence-shape")).toHaveLength(0)
  })

  test("free-form prose evidence fails W2", () => {
    const md = ["---", "outcome: success", "outcome_evidence: the user said so", "---", ""].join(
      "\n",
    )
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.some((w) => w.rule === "outcome-evidence-shape")).toBe(true)
  })
})

describe("ADR-0131 — lintMemoryFrontmatter: W3 percentage-grace", () => {
  test("'80% done' in body triggers W3", () => {
    const md = ["---", "name: x", "---", "Feature is 80% done."].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.some((w) => w.rule === "percentage-grace")).toBe(true)
  })

  test("'30% complete' also triggers", () => {
    const md = ["---", "name: x", "---", "Project 30% complete!"].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.some((w) => w.rule === "percentage-grace")).toBe(true)
  })

  test("'100% finished' also triggers", () => {
    const md = ["---", "name: x", "---", "We are 100% finished here."].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.some((w) => w.rule === "percentage-grace")).toBe(true)
  })

  test("'80%' without 'done|complete|finished' does NOT trigger", () => {
    const md = ["---", "name: x", "---", "Coverage is at 80% across the suite."].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.filter((w) => w.rule === "percentage-grace")).toHaveLength(0)
  })

  test("W3 line number is in the BODY (not frontmatter)", () => {
    const md = [
      "---",
      "name: x",
      "outcome: partial",
      "outcome_evidence: src/a.ts:1",
      "---",
      "",
      "80% done.",
    ].join("\n")
    const report = lintMemoryFrontmatter(md)
    const w3 = report.warnings.find((w) => w.rule === "percentage-grace")
    expect(w3).toBeDefined()
    // Body starts after the closing `---`; line numbers are 1-based whole-file.
    expect(w3!.line).toBeGreaterThanOrEqual(5)
  })

  test("multiple W3 hits on different lines each get their own warning", () => {
    const md = ["---", "---", "80% done.", "90% finished."].join("\n")
    const report = lintMemoryFrontmatter(md)
    const w3s = report.warnings.filter((w) => w.rule === "percentage-grace")
    expect(w3s.length).toBeGreaterThanOrEqual(2)
  })
})

describe("ADR-0131 — lintMemoryFrontmatter: backward compat + edge cases", () => {
  test("file without frontmatter → no W1/W2; W3 still scans body", () => {
    const report = lintMemoryFrontmatter("Just a body with 80% done note.")
    expect(report.warnings.filter((w) => w.rule === "outcome-evidence-missing")).toHaveLength(0)
    expect(report.warnings.some((w) => w.rule === "percentage-grace")).toBe(true)
  })

  test("empty input → empty report", () => {
    const report = lintMemoryFrontmatter("")
    expect(report.warnings).toEqual([])
    expect(report.errors).toEqual([])
  })

  test("file with frontmatter but no outcome and clean body → empty report", () => {
    const md = ["---", "name: hello", "---", "Just normal text."].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings).toEqual([])
  })

  test("malformed frontmatter (no closing fence) → no W1/W2 fired", () => {
    const md = "---\nname: x\noutcome: success\nNot a real fence"
    const report = lintMemoryFrontmatter(md)
    expect(report.warnings.filter((w) => w.rule === "outcome-evidence-missing")).toHaveLength(0)
  })

  test("errors array is always empty (lint is warning-only per ADR-0131)", () => {
    const md = [
      "---",
      "outcome: success",
      "outcome_evidence: not-a-shape",
      "---",
      "80% done.",
    ].join("\n")
    const report = lintMemoryFrontmatter(md)
    expect(report.errors).toEqual([])
    // …but warnings should have fired.
    expect(report.warnings.length).toBeGreaterThanOrEqual(2)
  })
})
