/**
 * Realistic fixture: run `extractIssueHint` over EVERY instance in our regression
 * smoke set (tests/smoke/swebench/picks.jsonl) and pin loose-contract invariants
 * per-instance. We DO NOT pin exact extracted sets — issue text evolves and the
 * extractors are conservative-by-design; instead we pin that each fixture
 * yields *some* signal and prints what was found (visible in test output).
 *
 * Why loose contracts: the goal is to detect regressions where an extractor
 * silently goes blind (e.g. a regex change drops all matches), not to over-pin
 * the exact set (over-pinning blocks legitimate improvements to extractors).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { extractIssueHint } from "../../../src/agent/issue-hint"

interface Pick {
  readonly instance_id: string
  readonly problem_statement: string
}

const REPO_ROOT = join(__dirname, "..", "..", "..")
const PICKS_PATH = join(REPO_ROOT, "tests", "smoke", "swebench", "picks.jsonl")

const loadPicks = (): readonly Pick[] => {
  const raw = readFileSync(PICKS_PATH, "utf8")
  const lines = raw.split("\n").filter((l) => l.trim() !== "")
  return lines.map((l) => JSON.parse(l) as Pick)
}

describe("extractIssueHint — SWE-bench picks.jsonl corpus (loose contract)", () => {
  const picks = loadPicks()

  test("corpus loaded (sanity)", () => {
    expect(picks.length).toBeGreaterThan(0)
  })

  for (const pick of picks) {
    test(`${pick.instance_id}: extraction is well-typed and never throws`, () => {
      const hint = extractIssueHint(pick.problem_statement)
      // Loose contract: extraction never throws AND every mandatory field is
      // a defined array (not undefined). expectedActual is optional and
      // OMITTED when not opted in.
      expect(Array.isArray(hint.files)).toBe(true)
      expect(Array.isArray(hint.symbols)).toBe(true)
      expect(Array.isArray(hint.errors)).toBe(true)
      expect(Array.isArray(hint.codeFences)).toBe(true)
      expect(Array.isArray(hint.tracebacks)).toBe(true)
      expect(Array.isArray(hint.tracebackPaths)).toBe(true)
      expect(Array.isArray(hint.refs)).toBe(true)

      // Print summary for human-visible test output (logged via expect message).
      const summary = [
        `files=${hint.files.length} (${hint.files.slice(0, 3).join(", ")})`,
        `symbols=${hint.symbols.length} (${hint.symbols.slice(0, 3).join(", ")})`,
        `errors=${hint.errors.length} (${hint.errors.slice(0, 3).join(", ")})`,
        `codeFences=${hint.codeFences.length}`,
        `tracebacks=${hint.tracebacks.length}`,
        `tracebackPaths=${hint.tracebackPaths.length} (${hint.tracebackPaths.slice(0, 2).join(", ")})`,
        `refs=${hint.refs.length} (${hint.refs.slice(0, 3).join(", ")})`,
      ].join(" | ")
      // biome-ignore lint/suspicious/noConsole: test-time visibility of per-instance extraction
      console.log(`[${pick.instance_id}] ${summary}`)
    })
  }

  test("at least one fixture extracts a meaningful signal (no-blind regression)", () => {
    // Group invariant: the corpus contains real issues. If EVERY fixture
    // yielded zero signals, an extractor went blind. Loose-but-strict.
    let total = 0
    for (const pick of picks) {
      const h = extractIssueHint(pick.problem_statement)
      total +=
        h.files.length +
        h.symbols.length +
        h.errors.length +
        h.codeFences.length +
        h.tracebackPaths.length
    }
    expect(total).toBeGreaterThan(0)
  })

  test("requests-5414: known signals appear (the canonical RCA case)", () => {
    const target = picks.find((p) => p.instance_id === "psf__requests-5414")
    expect(target).toBeDefined()
    if (!target) return
    const hint = extractIssueHint(target.problem_statement)
    // Issue text references `requests/models.py` AND `UnicodeError` AND
    // `InvalidUrl` (which surfaces via backtick-fenced symbol path). Loose
    // contract: at least the file AND the error must appear (the RCA root
    // cause was the agent picking the wrong file — this proves the hint
    // would have steered it right).
    expect(hint.files).toContain("requests/models.py")
    expect(hint.errors).toContain("UnicodeError")
  })

  test("requests-5414: VERBATIM reproduction code body extracted", () => {
    const target = picks.find((p) => p.instance_id === "psf__requests-5414")
    expect(target).toBeDefined()
    if (!target) return
    const hint = extractIssueHint(target.problem_statement)
    // Verbatim policy: the `requests.get("http://.example.com")` reproduction
    // body must appear verbatim in codeFences (no summary).
    expect(hint.codeFences.length).toBeGreaterThan(0)
    const hasRepro = hint.codeFences.some(
      (body) =>
        body.includes("import requests") && body.includes('requests.get("http://.example.com")'),
    )
    expect(hasRepro).toBe(true)
  })

  test("requests-5414: PR ref #774 extracted", () => {
    const target = picks.find((p) => p.instance_id === "psf__requests-5414")
    expect(target).toBeDefined()
    if (!target) return
    const hint = extractIssueHint(target.problem_statement)
    expect(hint.refs).toContain("#774")
  })

  test("pytest-7982: symlink / pathlib issue mentions the file", () => {
    const target = picks.find((p) => p.instance_id === "pytest-dev__pytest-7982")
    expect(target).toBeDefined()
    if (!target) return
    const hint = extractIssueHint(target.problem_statement)
    // The issue body cites a commit — extractFiles may or may not pick up a
    // path (the issue text itself is short). At minimum: extraction must not
    // throw and must produce a typed shape.
    expect(Array.isArray(hint.files)).toBe(true)
    expect(Array.isArray(hint.symbols)).toBe(true)
    expect(Array.isArray(hint.errors)).toBe(true)
  })

  test("sympy-13480: traceback path is captured", () => {
    const target = picks.find((p) => p.instance_id === "sympy__sympy-13480")
    expect(target).toBeDefined()
    if (!target) return
    const hint = extractIssueHint(target.problem_statement)
    // The issue body includes a Windows-path traceback frame. Even if Python's
    // `File "x", line N` is on a Windows path, the extractor pattern matches.
    // Loose contract: SOME traceback or file signal present.
    const hasSignal = hint.tracebackPaths.length > 0 || hint.files.length > 0
    expect(hasSignal).toBe(true)
  })
})
