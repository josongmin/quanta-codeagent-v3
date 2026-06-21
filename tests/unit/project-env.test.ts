/**
 * SCAFF-07 — astropy repro/candidate env parity.
 *
 * `buildProjectEnvUvRunArgv` is the SINGLE builder every repo-local SWE-bench
 * exec path threads through (repro samples, issue-smoke MWE, synthesized
 * testCmd, regression oracle). The `astropy__astropy-13033` clean repro failed
 * with `No module named 'setuptools.dep_util'` — a too-new setuptools under
 * uv's build isolation, NOT a model/selector miss. These hellgates assert the
 * astropy-specific build env (pinned setuptools, extension_helpers, isolation
 * off) is baked into the real builder output, and that the config is repo-
 * SCOPED (a pure-python repo never inherits it) and deterministic.
 */
import { describe, expect, test } from "bun:test"
import { buildProjectEnvUvRunArgv } from "@/runner/batch/corpus/project-env"

const hasWithDep = (argv: readonly string[], dep: string): boolean =>
  argv.some((arg, idx) => arg === "--with" && argv[idx + 1] === dep)

describe("buildProjectEnvUvRunArgv — astropy env parity (SCAFF-07)", () => {
  test("astropy/astropy argv carries the full setuptools.dep_util build env", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "4.3")
    // uv must not switch into the repo's own project env, which would hide
    // the `--with` pins behind the project layer.
    expect(argv).toContain("--no-project")
    // The pinned setuptools (<60 still ships setuptools.dep_util) + the
    // C-extension build helper astropy imports during editable install.
    expect(hasWithDep(argv, "setuptools<60")).toBe(true)
    expect(hasWithDep(argv, "extension_helpers")).toBe(true)
    // Build isolation would otherwise hide the pinned setuptools from the
    // build backend, re-triggering the dep_util ImportError.
    expect(argv).toContain("--no-build-isolation")
    // The repo itself is installed editable from the sandbox cwd.
    expect(argv).toContain("--with-editable")
    expect(argv[argv.indexOf("--with-editable") + 1]).toBe(".")
  })

  test("extraWith deps coexist with the astropy build pins (pytest path)", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "4.3", ["pytest"])
    expect(hasWithDep(argv, "pytest")).toBe(true)
    expect(hasWithDep(argv, "setuptools<60")).toBe(true)
    expect(hasWithDep(argv, "extension_helpers")).toBe(true)
    expect(argv).toContain("--no-build-isolation")
  })

  // Paired control: the config is REPO-SCOPED, not a global default. A pure-
  // python repo must not inherit astropy's build flags — otherwise the test
  // above would pass for the wrong reason (flags applied everywhere).
  test("a pure-python repo (sympy) does NOT inherit the astropy build flags", () => {
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
  test("astropy build flags are keyed on the exact `astropy/astropy` slug", () => {
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
