import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  extractVerificationOwnerTestExpectations,
  ownerTestCandidatesFromModules,
} from "@/runner/batch/eval/verification-owner-test-expectations"

/**
 * T2 — bounded source-search fallback for existing-test expectations when the
 * command-derived test paths are empty.
 */

describe("ownerTestCandidatesFromModules — convention-based namespace probe", () => {
  it("derives OWNER-RELATIVE test layouts (no bare repo-root path for a nested owner)", () => {
    expect(ownerTestCandidatesFromModules(["astropy/timeseries/core.py"])).toEqual([
      "astropy/timeseries/tests/test_core.py",
      "astropy/timeseries/test_core.py",
      "astropy/tests/test_core.py",
    ])
  })

  it("skips test files and non-python owners", () => {
    expect(
      ownerTestCandidatesFromModules(["pkg/tests/test_x.py", "pkg/readme.md", "pkg/m.py"]),
    ).toEqual(["pkg/tests/test_m.py", "pkg/test_m.py"])
  })

  it("MULTI-OWNER same-basename: candidates stay owner-scoped, no shared repo-root collision", () => {
    // Two owners share basename `core`. Each gets only ITS OWN package-relative
    // candidates; neither emits a bare `tests/test_core.py` that would let one
    // owner's probe read the other's (or an unrelated global) test.
    const got = ownerTestCandidatesFromModules(["pkg1/core.py", "pkg2/core.py"])
    expect(got).toEqual([
      "pkg1/tests/test_core.py",
      "pkg1/test_core.py",
      "pkg2/tests/test_core.py",
      "pkg2/test_core.py",
    ])
    expect(got).not.toContain("tests/test_core.py")
  })

  it("repo-root owner still gets its own tests/test_X.py first candidate", () => {
    expect(ownerTestCandidatesFromModules(["setup_helpers.py"])).toEqual([
      "tests/test_setup_helpers.py",
      "test_setup_helpers.py",
    ])
  })
})

const writeFileEnsured = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}

describe("extractVerificationOwnerTestExpectations — T2 fallback wiring", () => {
  it("falls back to convention test files when command paths are empty", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "t2-fallback-"))
    try {
      await writeFileEnsured(
        join(sandbox, "astropy/timeseries/tests/test_core.py"),
        "def test_invalid():\n    assert msg == 'expected the first columns'\n",
      )
      const facts = await extractVerificationOwnerTestExpectations({
        sandbox,
        ownerNearTests: [], // no command-derived paths
        localizedOwnerFiles: ["astropy/timeseries/core.py"],
      })
      expect(facts.length).toBeGreaterThan(0)
      expect(facts.join("\n")).toContain("astropy/timeseries/tests/test_core.py")
      expect(facts.join("\n")).toContain("expected the first columns")
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it("command paths take precedence; fallback is not consulted when commands resolve", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "t2-cmd-"))
    try {
      await writeFileEnsured(
        join(sandbox, "pkg/tests/test_real.py"),
        "def test_a():\n    assert x == 'from command path'\n",
      )
      // A convention file ALSO exists; it must be ignored because the command resolves.
      await writeFileEnsured(
        join(sandbox, "pkg/tests/test_m.py"),
        "def test_b():\n    assert y == 'from convention path'\n",
      )
      const facts = await extractVerificationOwnerTestExpectations({
        sandbox,
        ownerNearTests: ["python -m pytest pkg/tests/test_real.py::test_a"],
        localizedOwnerFiles: ["pkg/m.py"],
      })
      expect(facts.join("\n")).toContain("from command path")
      expect(facts.join("\n")).not.toContain("from convention path")
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it("falls back when a command-derived test path is stale / missing on disk", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "t2-missing-cmd-"))
    try {
      await writeFileEnsured(
        join(sandbox, "pkg/tests/test_real.py"),
        "def test_a():\n    assert x == 'found via fallback after stale command path'\n",
      )
      const facts = await extractVerificationOwnerTestExpectations({
        sandbox,
        ownerNearTests: ["python -m pytest pkg/tests/test_missing.py::test_a"],
        localizedOwnerFiles: ["pkg/real.py"],
      })
      expect(facts.join("\n")).toContain("found via fallback after stale command path")
      expect(facts.join("\n")).toContain("pkg/tests/test_real.py")
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it("no localized owners + no commands ⇒ empty (byte-identical to pre-T2)", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "t2-empty-"))
    try {
      expect(
        await extractVerificationOwnerTestExpectations({ sandbox, ownerNearTests: [] }),
      ).toEqual([])
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it("fallback only probes files that exist (a missing convention file yields nothing)", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "t2-missing-"))
    try {
      const facts = await extractVerificationOwnerTestExpectations({
        sandbox,
        ownerNearTests: [],
        localizedOwnerFiles: ["pkg/never_here.py"],
      })
      expect(facts).toEqual([])
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})
