import { describe, expect, test } from "bun:test"
import {
  discoverImpactedTestCandidates,
  discoverImpactedTests,
  isPythonTestFile,
  normalizeRepoPath,
  rankWitnessEvidence,
  type WitnessEvidence,
} from "@/runner/batch/eval/impacted-test-discovery"

describe("impacted repo-test discovery", () => {
  test("normalizes diff-style repo paths", () => {
    expect(normalizeRepoPath("a/src/pkg/mod.py")).toBe("src/pkg/mod.py")
    expect(normalizeRepoPath("./b\\pkg\\mod.py")).toBe("pkg/mod.py")
  })

  test("recognizes pytest-style files and avoids helpers", () => {
    expect(isPythonTestFile("tests/test_app.py")).toBe(true)
    expect(isPythonTestFile("pkg/tests/test_app.py")).toBe(true)
    expect(isPythonTestFile("pkg/tests/app.py")).toBe(true)
    expect(isPythonTestFile("pkg/tests.py")).toBe(true)
    expect(isPythonTestFile("tests/conftest.py")).toBe(false)
    expect(isPythonTestFile("pkg/app.py")).toBe(false)
  })

  test("mirror path discovers the matching repo test without a generated oracle", () => {
    const tests = discoverImpactedTests({
      changedFiles: ["src/flask/app.py"],
      repoFiles: [
        { path: "tests/test_app.py", text: "" },
        { path: "tests/test_blueprints.py", text: "" },
      ],
    })
    expect(tests).toEqual(["tests/test_app.py"])
  })

  test("import references discover non-mirror tests", () => {
    const tests = discoverImpactedTests({
      changedFiles: ["flask/app.py"],
      repoFiles: [
        { path: "tests/test_cli.py", text: "from flask.app import Flask\n" },
        { path: "tests/test_json.py", text: "from flask import json\n" },
      ],
    })
    expect(tests).toEqual(["tests/test_cli.py"])
  })

  test("tests.py under a matching feature directory is discovered without imports", () => {
    const tests = discoverImpactedTests({
      changedFiles: ["django/core/validators.py"],
      repoFiles: [
        { path: "tests/validators/tests.py", text: "" },
        { path: "tests/forms/tests.py", text: "" },
      ],
    })
    expect(tests).toEqual(["tests/validators/tests.py"])
  })

  test("path-token affinity discovers nested feature tests even when the basename is generic", () => {
    const candidates = discoverImpactedTestCandidates({
      changedFiles: ["django/template/context.py"],
      repoFiles: [
        { path: "tests/template_tests/test_misc.py", text: "" },
        { path: "tests/forms_tests/test_misc.py", text: "" },
      ],
    })
    expect(candidates.map((c) => c.path)).toEqual(["tests/template_tests/test_misc.py"])
    expect(candidates[0]?.reasons).toContain("context-token:template")
  })

  test("ignores changed tests and non-python files", () => {
    const tests = discoverImpactedTests({
      changedFiles: ["tests/test_app.py", "docs/usage.md"],
      repoFiles: [{ path: "tests/test_app.py", text: "from flask.app import Flask\n" }],
    })
    expect(tests).toEqual([])
  })

  test("ranks stronger mirror/import candidates first and respects maxTests", () => {
    const candidates = discoverImpactedTestCandidates({
      changedFiles: ["pkg/core.py"],
      repoFiles: [
        { path: "tests/test_other.py", text: "from pkg.core import run\n" },
        { path: "pkg/tests/test_core.py", text: "from pkg.core import run\n" },
      ],
      maxTests: 1,
    })
    expect(candidates.map((c) => c.path)).toEqual(["pkg/tests/test_core.py"])
    expect(candidates[0]?.reasons).toContain("mirror:core")
    expect(candidates[0]?.reasons).toContain("import-ref")
  })

  test("candidates carry typed structural evidence (telemetry) alongside the rank", () => {
    const candidates = discoverImpactedTestCandidates({
      changedFiles: ["pkg/core.py"],
      repoFiles: [{ path: "pkg/tests/test_core.py", text: "from pkg.core import run\n" }],
    })
    const kinds = candidates[0]?.evidence.map((e) => e.kind) ?? []
    expect(kinds).toContain("mirror")
    expect(kinds).toContain("import-ref")
    expect(kinds).toContain("package")
    // The ordering score is exactly the pure projection of the evidence.
    expect(candidates[0]?.score).toBe(rankWitnessEvidence(candidates[0]?.evidence ?? []))
  })

  // ── Hellgate: the rank is ORDERING-ONLY, never admissibility authority ──────
  // The static score table may decide which witness runs *first* under maxTests,
  // but it can NEVER decide whether a test is a candidate at all. Admissibility
  // is keyed on the presence of structural evidence, so re-weighting the rank
  // cannot add or drop a candidate from the discovered set.
  test("admissibility is evidence-presence, not score — rank only reorders", () => {
    const repoFiles = [
      // import-ref only (rank 30): non-mirror test that imports the source.
      { path: "tests/test_uses_core.py", text: "from pkg.core import run\n" },
      // mirror only (rank 50): same-stem mirror test, no import.
      { path: "pkg/tests/test_core.py", text: "" },
    ]
    const candidates = discoverImpactedTestCandidates({
      changedFiles: ["pkg/core.py"],
      repoFiles,
    })
    // Both are admitted (each has evidence). The mirror outranks the import-ref,
    // so it sorts first — that is the ONLY thing the score decides.
    expect(candidates.map((c) => c.path)).toEqual([
      "pkg/tests/test_core.py",
      "tests/test_uses_core.py",
    ])
    // The ADMITTED SET (as a set) is independent of any weight tuning: it is the
    // union of every test with non-empty evidence.
    expect(new Set(candidates.map((c) => c.path))).toEqual(
      new Set(["pkg/tests/test_core.py", "tests/test_uses_core.py"]),
    )
    expect(candidates.every((c) => c.evidence.length > 0)).toBe(true)
  })

  test("rankWitnessEvidence is a pure additive projection (no gate / threshold)", () => {
    const mirror: WitnessEvidence = { kind: "mirror", detail: "core" }
    const importRef: WitnessEvidence = { kind: "import-ref", detail: "pkg.core" }
    // Empty evidence ranks 0 — but an empty-evidence candidate is simply never
    // built, so a 0 here is not a "reject", it is "not a witness".
    expect(rankWitnessEvidence([])).toBe(0)
    expect(rankWitnessEvidence([mirror])).toBe(50)
    expect(rankWitnessEvidence([importRef])).toBe(30)
    // Additive: combining evidence sums the weights, order-independent.
    expect(rankWitnessEvidence([mirror, importRef])).toBe(80)
    expect(rankWitnessEvidence([importRef, mirror])).toBe(80)
  })

  test("empty witness candidates: a changed non-source file yields no candidates", () => {
    const candidates = discoverImpactedTestCandidates({
      changedFiles: ["docs/usage.md", "tests/test_app.py"],
      repoFiles: [{ path: "tests/test_app.py", text: "from pkg.app import App\n" }],
    })
    expect(candidates).toEqual([])
  })
})
