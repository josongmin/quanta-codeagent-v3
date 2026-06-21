/**
 * `reproRunArgv` + `pythonForRepoVersion` — runs an Agentless repro script under
 * the SAME project env the synthesized testCmd uses (uvx editable install). The
 * CPython minor is now (repo, version)-keyed from the SWE-bench ground-truth map,
 * fixing the RCA jun-20 bug: a single static per-repo python forced django 5.0
 * onto 3.9 (`No solution found`, requires-python>=3.10) and old scikit-learn onto
 * 3.10 (numpy build fail) — ~13% of repros silently lost their oracle.
 */
import { describe, expect, test } from "bun:test"
import { reproRunArgv } from "@/runner/batch/corpus/dataset"
import { pythonForRepoVersion } from "@/runner/batch/corpus/repo-version-python"

const pyOf = (argv: readonly string[]): string => argv[argv.indexOf("--python") + 1] as string
const hasWithDep = (argv: readonly string[], dep: string): boolean =>
  argv.some((arg, idx) => arg === "--with" && argv[idx + 1] === dep)

describe("reproRunArgv", () => {
  test("wraps the script in a uv-run editable-install env (not a bare python)", () => {
    const argv = reproRunArgv("sympy/sympy", "1.5", "/sandbox/__repro_0.py")
    expect(argv.slice(0, 2)).toEqual(["uv", "run"])
    expect(argv).toContain("--no-project")
    expect(hasWithDep(argv, "setuptools")).toBe(true)
    expect(argv).toContain("--with-editable")
    expect(argv[argv.indexOf("--with-editable") + 1]).toBe(".")
    expect(argv[argv.length - 1]).toBe("/sandbox/__repro_0.py")
    expect(argv[argv.length - 2]).toBe("python")
  })

  // THE bug fix: django 5.0 needs 3.11. The old static "django→3.9" map produced
  // `--python 3.9` → uv `No solution found` → repro execution_failed.
  test("django 5.0 ⇒ --python 3.11 (was wrongly 3.9 → repro env failure)", () => {
    expect(pyOf(reproRunArgv("django/django", "5.0", "/s/x.py"))).toBe("3.11")
  })

  test("unknown version ⇒ per-repo high fallback (django ⇒ 3.11)", () => {
    expect(pyOf(reproRunArgv("django/django", "99.99", "/s/x.py"))).toBe("3.11")
  })

  test("unknown repo ⇒ conservative 3.11 default", () => {
    expect(pyOf(reproRunArgv("some/unknown-repo", undefined, "/s/x.py"))).toBe("3.11")
  })

  test("xarray inherits the legacy numpy<2 guard in its repro env", () => {
    expect(hasWithDep(reproRunArgv("pydata/xarray", "0.12", "/s/x.py"), "numpy<2")).toBe(true)
    expect(hasWithDep(reproRunArgv("sympy/sympy", "1.5", "/s/x.py"), "numpy<2")).toBe(false)
  })
})

describe("pythonForRepoVersion — (repo,version) ground truth, FLOORED at 3.9", () => {
  // The fix that mattered: high-end bumped to the version's real python.
  test("django 5.0 ⇒ 3.11 (the bug: was forced to 3.9)", () => {
    expect(pythonForRepoVersion("django/django", "5.0")).toBe("3.11")
    expect(pythonForRepoVersion("django/django", "4.2")).toBe("3.9")
  })

  // RCA jun-20 AUDIT regression: swebench pins old django/sklearn to 3.5/3.6, but
  // uv cannot provide < 3.8 ("No interpreter found for Python 3.6"), and 3.9 ran
  // them fine for a year. The UV_FLOOR clamps the unavailable-low to 3.9.
  test("old versions FLOOR at 3.9 (swebench 3.5/3.6 → uv can't provide)", () => {
    expect(pythonForRepoVersion("django/django", "1.11")).toBe("3.9") // swebench 3.5 → floored
    expect(pythonForRepoVersion("django/django", "3.0")).toBe("3.9") // swebench 3.6 → floored
    expect(pythonForRepoVersion("django/django", "4.0")).toBe("3.9") // swebench 3.8 → floored
    expect(pythonForRepoVersion("scikit-learn/scikit-learn", "0.20")).toBe("3.9") // swebench 3.6
  })

  test("sympy is uniformly 3.9 (already at the floor)", () => {
    expect(pythonForRepoVersion("sympy/sympy", "1.5")).toBe("3.9")
    expect(pythonForRepoVersion("sympy/sympy", "1.13")).toBe("3.9")
  })

  test("undefined version ⇒ per-repo high fallback (never the too-low failure)", () => {
    expect(pythonForRepoVersion("django/django", undefined)).toBe("3.11")
  })
})
