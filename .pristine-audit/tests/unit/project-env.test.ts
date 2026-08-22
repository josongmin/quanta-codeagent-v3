/**
 * SCAFF-07 — astropy repro/candidate env parity.
 *
 * `buildProjectEnvUvRunArgv` is the SINGLE builder every repo-local SWE-bench
 * exec path threads through (repro samples, issue-smoke MWE, synthesized
 * testCmd, regression oracle). The `astropy__astropy-13033` clean repro failed
 * because astropy's `setup.py` does a build-time `import extension_helpers`
 * (ModuleNotFoundError), NOT a model/selector miss.
 *
 * P0 (2026-06-23): the `--with extension_helpers --no-build-isolation` mechanism
 * was PROVEN BROKEN under uv (the editable `.` target builds BEFORE `--with`
 * packages reach the setuptools build backend). The build dep is now
 * materialized into the repo's `pyproject.toml` `[tool.uv.extra-build-
 * dependencies]` table at sandbox-prep time (see project-env-sandbox-hellgate).
 * These hellgates therefore assert the argv NO LONGER carries the broken build
 * flags, and that runtime pins / repo-scoping / determinism still hold.
 */
import { describe, expect, test } from "bun:test"
import { buildProjectEnvUvRunArgv } from "@/runner/batch/corpus/project-env"

const hasWithDep = (argv: readonly string[], dep: string): boolean =>
  argv.some((arg, idx) => arg === "--with" && argv[idx + 1] === dep)
const uvRunIndex = (argv: readonly string[]): number =>
  argv.findIndex((arg, idx) => arg === "uv" && argv[idx + 1] === "run")

describe("buildProjectEnvUvRunArgv — astropy env parity (SCAFF-07 / P0 mechanism)", () => {
  test("astropy/astropy argv carries the base env but NOT the broken build flags", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "4.3")
    // uv must not switch into the repo's own project env, which would hide
    // the `--with` pins behind the project layer.
    expect(uvRunIndex(argv)).toBeGreaterThanOrEqual(0)
    expect(argv).toContain("--no-project")
    // The build dep moved to pyproject materialization; the broken `--with`
    // pins + isolation toggle are GONE (they never reached the build backend).
    expect(hasWithDep(argv, "setuptools<60")).toBe(false)
    expect(hasWithDep(argv, "extension_helpers")).toBe(false)
    expect(argv).not.toContain("--no-build-isolation")
    expect(hasWithDep(argv, "numpy<2")).toBe(true)
    expect(hasWithDep(argv, "hypothesis")).toBe(true)
    expect(hasWithDep(argv, "pytest-astropy")).toBe(true)
    expect(argv).toContain(
      "CFLAGS=-Wno-error=incompatible-function-pointer-types -Wno-incompatible-function-pointer-types",
    )
    // The repo itself is installed editable from the sandbox cwd. astropy's
    // official install is `pip install -e .[test]`, so the editable target
    // carries the `[test]` extra (not a bare `.`).
    expect(argv).toContain("--with-editable")
    expect(argv[argv.indexOf("--with-editable") + 1]).toBe(".[test]")
  })

  test("extraWith deps coexist with the base env (pytest path), still no build flags", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "4.3", ["pytest"])
    expect(hasWithDep(argv, "pytest")).toBe(true)
    expect(hasWithDep(argv, "extension_helpers")).toBe(false)
    expect(argv).not.toContain("--no-build-isolation")
    expect(hasWithDep(argv, "setuptools")).toBe(true)
  })

  // Paired control: the config is REPO-SCOPED, not a global default. A pure-
  // python repo must not inherit any astropy override.
  test("a pure-python repo (sympy) does NOT inherit any astropy override", () => {
    const argv = buildProjectEnvUvRunArgv("sympy/sympy", "1.5")
    expect(hasWithDep(argv, "setuptools<60")).toBe(false)
    expect(hasWithDep(argv, "extension_helpers")).toBe(false)
    expect(argv).not.toContain("--no-build-isolation")
    // ...but it still gets the shared base env (so this control is not vacuous).
    expect(argv).toContain("--no-project")
    expect(hasWithDep(argv, "setuptools")).toBe(true)
    expect(argv).toContain("--with-editable")
  })

  // Slug match must be exact: `astropy/astropy`, not a substring/other form.
  // (No build flags remain in the argv, so this guards the runtime-pin path
  // does not over-match either.)
  test("overrides are keyed on the exact `astropy/astropy` slug", () => {
    expect(buildProjectEnvUvRunArgv("astropy", "4.3")).not.toContain("--no-build-isolation")
    expect(
      hasWithDep(buildProjectEnvUvRunArgv("not-astropy/astropy", "4.3"), "extension_helpers"),
    ).toBe(false)
  })

  // Determinism: same repo slug ⇒ byte-identical argv across two calls. The
  // exec env must not drift between repro, candidate, and grading runs.
  test("same repo slug ⇒ identical argv across two calls (determinism)", () => {
    expect(buildProjectEnvUvRunArgv("astropy/astropy", "4.3")).toEqual(
      buildProjectEnvUvRunArgv("astropy/astropy", "4.3"),
    )
    expect(buildProjectEnvUvRunArgv("sympy/sympy", "1.5")).toEqual(
      buildProjectEnvUvRunArgv("sympy/sympy", "1.5"),
    )
  })
})

// Characterization (FIX C): the per-repo overrides were consolidated from
// scattered `if (repo === ...)` branches into ONE table. These pin the EXACT
// pins+flags for every known repo so the consolidation is proven behavior-
// preserving — a regression that drops/changes a pin fails here.
describe("buildProjectEnvUvRunArgv — per-repo env overrides (FIX C consolidation)", () => {
  test("xarray pins numpy<2 (np.unicode_ removed in numpy 2) and NO build-isolation flag", () => {
    const argv = buildProjectEnvUvRunArgv("pydata/xarray", "2022.03")
    expect(hasWithDep(argv, "numpy<2")).toBe(true)
    // xarray gets NO build-env override; its repo-specific fix is runtime-only.
    expect(argv).not.toContain("--no-build-isolation")
    // ...still inherits the shared base env (control not vacuous).
    expect(argv).toContain("--no-project")
    expect(hasWithDep(argv, "setuptools")).toBe(true)
    expect(argv).toContain("--with-editable")
  })

  test("astropy build dep is NOT a --with (it is materialized into pyproject)", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "4.3")
    expect(hasWithDep(argv, "setuptools<60")).toBe(false)
    expect(hasWithDep(argv, "extension_helpers")).toBe(false)
    expect(hasWithDep(argv, "extension-helpers")).toBe(false)
    expect(argv).toContain(
      "CFLAGS=-Wno-error=incompatible-function-pointer-types -Wno-incompatible-function-pointer-types",
    )
    expect(argv).not.toContain("--no-build-isolation")
  })

  test("an unlisted repo gets NEITHER pins nor build flags (only the base env)", () => {
    const argv = buildProjectEnvUvRunArgv("django/django", "4.1")
    expect(hasWithDep(argv, "numpy<2")).toBe(false)
    expect(hasWithDep(argv, "setuptools<60")).toBe(false)
    expect(hasWithDep(argv, "extension_helpers")).toBe(false)
    expect(argv).not.toContain("--no-build-isolation")
    expect(hasWithDep(argv, "setuptools")).toBe(true) // base dep still present
  })

  // Ordering invariant: base flags → `--with` deps → `--with-editable .[test]`.
  // No build flags remain (build deps moved to pyproject), so the shape is
  // `--no-project … --python v --with <dep> … --with-editable .[test]` (astropy's
  // official install carries the `[test]` extra).
  test("argv shape preserved: base flags → --with deps → --with-editable .[test]", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "4.3")
    const uvIdx = uvRunIndex(argv)
    const noProjIdx = argv.indexOf("--no-project")
    const firstWith = argv.indexOf("--with")
    const editIdx = argv.indexOf("--with-editable")
    expect(uvIdx).toBeGreaterThanOrEqual(0)
    expect(noProjIdx).toBeGreaterThan(uvIdx)
    expect(firstWith).toBeGreaterThan(noProjIdx)
    expect(editIdx).toBeGreaterThan(firstWith)
    expect(argv[editIdx + 1]).toBe(".[test]")
  })
})
