/**
 * `composeIssueHint` — verbatim-evidence markdown format contract.
 *
 *   - empty hint ⇒ "" (sentinel: byte-identical pass-through at the seam)
 *   - non-empty ⇒ self-contained markdown block ending with the calibration
 *     line "Use these as starting points but verify with your own tools."
 *
 * Verbatim policy: codeFences and tracebacks bodies are NOT summarized in the
 * output — they're re-wrapped in triple-backticks and emitted as-is.
 */
import { describe, expect, test } from "bun:test"
import { composeIssueHint } from "../../../src/agent/issue-hint/compose"
import { EMPTY_HINT, type IssueHint } from "../../../src/agent/issue-hint/types"

/** Build a partial IssueHint, filling in empty defaults for unspecified fields.
 *  This keeps the test cases readable — they only mention the fields they care
 *  about. */
const hint = (partial: Partial<IssueHint>): IssueHint => ({
  files: partial.files ?? [],
  symbols: partial.symbols ?? [],
  errors: partial.errors ?? [],
  codeFences: partial.codeFences ?? [],
  tracebacks: partial.tracebacks ?? [],
  tracebackPaths: partial.tracebackPaths ?? [],
  refs: partial.refs ?? [],
  ...(partial.expectedActual !== undefined ? { expectedActual: partial.expectedActual } : {}),
})

describe("composeIssueHint — verbatim-evidence markdown format", () => {
  test("empty hint → empty string (byte-identical sentinel)", () => {
    expect(composeIssueHint(EMPTY_HINT)).toBe("")
    expect(composeIssueHint(hint({}))).toBe("")
  })

  test("files-only hint → Likely files section + calibration footer", () => {
    const out = composeIssueHint(hint({ files: ["a/b.py"] }))
    expect(out).toContain("## Issue evidence (verbatim)")
    expect(out).toContain("### Likely files")
    expect(out).toContain("- `a/b.py`")
    expect(out).toContain("Use these as starting points but verify with your own tools.")
    // No bogus sections
    expect(out).not.toContain("### Symbols mentioned")
    expect(out).not.toContain("### Errors")
    expect(out).not.toContain("### Traceback")
    expect(out).not.toContain("### Reproduction code")
    expect(out).not.toContain("### Refs")
  })

  test("all fields populated → all sections present, calibration last", () => {
    const h = hint({
      files: ["a/b.py", "c/d.py"],
      symbols: ["foo", "Bar"],
      errors: ["TypeError", "UnicodeError: bad codec"],
      codeFences: ["import x\nx()"],
      tracebacks: ['Traceback (most recent call last):\n  File "a.py", line 1\nTypeError: x'],
      tracebackPaths: ["a/b.py:10"],
      refs: ["#774"],
    })
    const out = composeIssueHint(h)
    // Likely files section bullets
    expect(out).toContain("- `a/b.py`")
    expect(out).toContain("- `c/d.py`")
    // Symbols comma list
    expect(out).toContain("### Symbols mentioned")
    expect(out).toContain("`foo`, `Bar`")
    // Errors bullets with verbatim message body
    expect(out).toContain("### Errors")
    expect(out).toContain("- `TypeError`")
    expect(out).toContain("- `UnicodeError: bad codec`")
    // Verbatim code fence body
    expect(out).toContain("### Reproduction code")
    expect(out).toContain("import x\nx()")
    // Verbatim traceback block (header + frame + exception line)
    expect(out).toContain("### Traceback")
    expect(out).toContain("Traceback (most recent call last):")
    // Refs
    expect(out).toContain("### Refs")
    expect(out).toContain("- #774")
    // When a verbatim traceback block is present, the legacy tracebackPaths
    // section is SUPPRESSED (subsumed by the block).
    expect(out).not.toContain("### Traceback locations")
    // Calibration line ALWAYS last non-empty line
    const trimmed = out.replace(/\s+$/g, "")
    expect(trimmed.endsWith("Use these as starting points but verify with your own tools.")).toBe(
      true,
    )
  })

  test("tracebackPaths fallback (no traceback block) → legacy section emitted", () => {
    const h = hint({
      // Issue mentioned `File "x.py", line 1` inline but not under Traceback header
      tracebackPaths: ["x.py:1"],
    })
    const out = composeIssueHint(h)
    expect(out).toContain("### Traceback locations")
    expect(out).toContain("- `x.py:1`")
  })

  test("single code fence → singular 'Reproduction code' label", () => {
    const out = composeIssueHint(hint({ codeFences: ["only one block"] }))
    expect(out).toContain("### Reproduction code\n```\nonly one block\n```")
    expect(out).not.toContain("Reproduction code blocks")
  })

  test("multiple code fences → plural 'Reproduction code blocks' label", () => {
    const out = composeIssueHint(hint({ codeFences: ["a", "b"] }))
    expect(out).toContain("### Reproduction code blocks")
    // Both bodies present verbatim
    expect(out).toContain("```\na\n```")
    expect(out).toContain("```\nb\n```")
  })

  test("compose preserves array order (extractors decide, composer renders)", () => {
    const out = composeIssueHint(
      hint({
        files: ["z.py", "a.py"], // intentionally NOT sorted
      }),
    )
    const idxZ = out.indexOf("z.py")
    const idxA = out.indexOf("a.py")
    expect(idxZ).toBeGreaterThan(-1)
    expect(idxA).toBeGreaterThan(-1)
    expect(idxZ).toBeLessThan(idxA)
  })

  test("backtick-fenced identifier list (escape sanity)", () => {
    const out = composeIssueHint(hint({ symbols: ["prepare_url"] }))
    expect(out).toContain("`prepare_url`")
  })

  test("error with verbatim message body emitted intact", () => {
    const out = composeIssueHint(hint({ errors: ["InvalidURL: URL has an invalid label."] }))
    expect(out).toContain("- `InvalidURL: URL has an invalid label.`")
  })

  test("opt-in expectedActual — section emitted when array populated", () => {
    const out = composeIssueHint(hint({ expectedActual: ["should return 1.", "got 2."] }))
    expect(out).toContain("### Expected/Actual phrases")
    expect(out).toContain("- should return 1.")
    expect(out).toContain("- got 2.")
  })

  test("opt-in expectedActual — property absent ⇒ section omitted", () => {
    const out = composeIssueHint(hint({ files: ["a/b.py"] }))
    expect(out).not.toContain("Expected/Actual phrases")
  })

  test("refs section uses plain bullets (no backtick fencing)", () => {
    const out = composeIssueHint(hint({ refs: ["#774", "PROJ-1"] }))
    // No surrounding backticks — refs read naturally as `#774`, `PROJ-1` text
    expect(out).toContain("- #774")
    expect(out).toContain("- PROJ-1")
    // Sanity: not the backtick-wrapped form
    expect(out).not.toContain("- `#774`")
  })

  test("real SWE-bench shape (requests-5414 evidence)", () => {
    const h = hint({
      files: ["requests/models.py"],
      symbols: ["prepare_url", "InvalidUrl"],
      errors: ["UnicodeError", "InvalidUrl: URL has an invalid label."],
      codeFences: ['import requests\nrequests.get("http://.example.com")'],
      refs: ["#774", "#4168"],
    })
    const out = composeIssueHint(h)
    // Each evidence axis present
    expect(out).toContain("requests/models.py")
    expect(out).toContain("prepare_url")
    expect(out).toContain("UnicodeError")
    expect(out).toContain("InvalidUrl: URL has an invalid label.")
    expect(out).toContain('requests.get("http://.example.com")')
    expect(out).toContain("#774")
  })
})
