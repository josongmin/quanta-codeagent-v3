/**
 * Parity safety-net for the spec-derived test-command synthesis (jun-27).
 *
 * `synthesizeTestCmd` USED to hardcode `python tests/runtests.py
 * --settings=test_sqlite --parallel=1` for `repo === "django/django"`, ignoring
 * VERSION. The flags now come from the SWE-bench spec SSOT (`specTestCmd`), so:
 *   - django 1.10 still gets `--settings=test_sqlite` (parity with the old output),
 *   - django 1.9 gets NO `--settings=test_sqlite` (the version-correct behavior the
 *     old hardcode got WRONG),
 *   - pytest-style repos keep the node-id / `-k` pytest path unchanged.
 *
 * This command BAKES the FAIL_TO_PASS answer key into the grading oracle — exactly
 * the existing behavior we must preserve byte-for-byte for django 1.10.
 */
import { describe, expect, test } from "bun:test"
import { synthesizeTestCmd } from "@/runner/batch/corpus/dataset"
import { specRunnerKind, specTestCmd } from "@/runner/batch/corpus/repo-version-specs"

const f2p = (names: readonly string[]) => JSON.stringify(names)

describe("synthesizeTestCmd derives the runner from the SWE-bench spec SSOT", () => {
  // Real django FAIL_TO_PASS uses the unittest `name (dotted.module.Class)`
  // shape; `djangoRuntestsLabel` rewrites it to the `module.Class.name` label
  // runtests.py expects.
  const DJANGO_F2P = ["test_x (admin_views.tests.AdminViewBasicTest)"]
  const DJANGO_LABEL = "admin_views.tests.AdminViewBasicTest.test_x"

  test("django 1.10 → runtests.py with --settings=test_sqlite + dotted label (parity with old hardcode)", () => {
    const cmd = synthesizeTestCmd({
      repo: "django/django",
      version: "1.10",
      FAIL_TO_PASS: f2p(DJANGO_F2P),
    })
    expect(cmd).toContain("runtests.py")
    // version-correct flags come straight from the spec, verbatim
    expect(cmd).toContain("--settings=test_sqlite")
    expect(cmd).toContain("--verbosity 2")
    expect(cmd).toContain("--parallel 1")
    // FAIL_TO_PASS → dotted module label (gold baked into the oracle command)
    expect(cmd).toContain(DJANGO_LABEL)
    // runner invoked under python with the leading `./` stripped
    expect(cmd).toContain("python tests/runtests.py")
    // gold-suppression link: the django command carries the PYTEST_ADDOPTS=
    // signature that driver's isSynthesizedDatasetVerifierCommand hides from the
    // agent (this command bakes the FAIL_TO_PASS answer key) — any version.
    expect(cmd).toContain("PYTEST_ADDOPTS=")
    // the runner substring is exactly the spec's, with no re-added settings
    const runner = specTestCmd("django/django", "1.10") ?? ""
    expect(runner).toBe("./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1")
    expect(cmd).toContain(runner.replace(/^\.\//, ""))
  })

  test("django 1.9 → runtests.py WITHOUT --settings=test_sqlite (version-correct; old hardcode was wrong)", () => {
    const cmd = synthesizeTestCmd({
      repo: "django/django",
      version: "1.9",
      FAIL_TO_PASS: f2p(DJANGO_F2P),
    })
    expect(cmd).toContain("runtests.py")
    expect(cmd).toContain("--verbosity 2")
    expect(cmd).toContain(DJANGO_LABEL)
    // THE version-correct difference: 1.9 has no --settings / --parallel
    expect(cmd).not.toContain("--settings=test_sqlite")
    expect(cmd).not.toContain("--parallel")
    expect(specTestCmd("django/django", "1.9")).toBe("./tests/runtests.py --verbosity 2")
  })

  test("django 1.9 and 1.10 commands differ exactly by the version-aware spec flags", () => {
    const args = (v: string) =>
      synthesizeTestCmd({
        repo: "django/django",
        version: v,
        FAIL_TO_PASS: f2p(DJANGO_F2P),
      })
    const c19 = args("1.9")
    const c110 = args("1.10")
    expect(c19).not.toBe(c110)
    expect(c110.includes("--settings=test_sqlite")).toBe(true)
    expect(c19.includes("--settings=test_sqlite")).toBe(false)
  })

  test("pytest-style repo keeps the node-id pytest path unchanged", () => {
    const cmd = synthesizeTestCmd({
      repo: "astropy/astropy",
      version: "4.3",
      FAIL_TO_PASS: f2p(["astropy/io/fits/tests/test_header.py::test_update_comment"]),
    })
    expect(cmd).toContain("pytest -x --no-header")
    expect(cmd).toContain("astropy/io/fits/tests/test_header.py::test_update_comment")
    expect(cmd).not.toContain("runtests.py")
    expect(cmd).not.toContain("--settings=test_sqlite")
  })

  test("pytest-style repo with a bare test name uses a -k keyword expression", () => {
    const cmd = synthesizeTestCmd({
      repo: "sympy/sympy",
      version: "1.1",
      FAIL_TO_PASS: f2p(["test_encode_morse"]),
    })
    expect(cmd).toContain("pytest -x --no-header")
    expect(cmd).toContain("-k")
    expect(cmd).toContain("test_encode_morse")
    expect(cmd).not.toContain("runtests.py")
  })

  test("specRunnerKind: ONLY django needs its spec runner; every other SWE-bench Verified repo is pytest-run", () => {
    // The de-heuristic's design claim, pinned: django genuinely can't run under
    // plain pytest (needs runtests + settings — the engage=0 RCA), so it uses its
    // spec runner; every OTHER Verified repo is pytest-compatible in-loop and uses
    // the uniform pytest oracle (their native wrappers — sphinx's tox, sympy's
    // bin/test — aren't on the uv env, and their tests collect under pytest). This
    // makes the runtests-vs-pytest split FUNCTIONAL + spec-derived, not a guess.
    expect(specRunnerKind("django/django", "1.10")).toBe("runtests")
    expect(specRunnerKind("django/django", "1.9")).toBe("runtests")
    expect(specRunnerKind("django/django", "5.0")).toBe("runtests")
    for (const [repo, version] of [
      ["astropy/astropy", "5.1"],
      ["sympy/sympy", "1.1"], // spec runner is bin/test → still pytest-run in-loop
      ["sphinx-doc/sphinx", "4.1"], // spec runner is tox → still pytest-run in-loop
      ["scikit-learn/scikit-learn", "1.3"],
      ["matplotlib/matplotlib", "3.7"],
      ["pytest-dev/pytest", "7.4"],
      ["pylint-dev/pylint", "3.0"],
      ["psf/requests", "2.31"],
      ["pallets/flask", "2.3"],
      ["pydata/xarray", "2023.07"],
      ["mwaskom/seaborn", "0.13"],
    ] as const) {
      expect(specRunnerKind(repo, version)).toBe("pytest")
    }
    // unknown (repo,version) defaults to the pytest oracle, never a broken runner
    expect(specRunnerKind("foo/bar", "1.0")).toBe("pytest")
  })

  test('no `repo === "django/django"` literal remains in dataset.ts', async () => {
    const src = await Bun.file(
      new URL("../../src/runner/batch/corpus/dataset.ts", import.meta.url),
    ).text()
    expect(src.includes('repo === "django/django"')).toBe(false)
    // the runner string must come from the spec module, not a hardcoded literal value
    expect(src.includes("--settings=test_sqlite")).toBe(false)
  })
})
