/**
 * Hellgate — upstream-dataset truncated test-id robustness (jul-01).
 *
 * SWE-bench-Live truncated some parametrized PASS_TO_PASS ids at the first whitespace inside
 * `[...]` (dropping the closing `]`), e.g. stored `test_intel_cc_default[2021.3-classic-Intel`
 * vs the real `…-Intel C++ Compiler 19.2]`. pytest can't collect such an id → reports it as a
 * collection error → the harness lists it as a PASS_TO_PASS *failure* → even the GOLD patch is
 * "unresolved" (proven by local reproduction of conan-io__conan-15377). A non-collectable test
 * is neither pass nor fail, so it must NOT veto resolution. These tests pin that exclusion AND
 * that it NEVER masks a real failure.
 */
import { describe, expect, test } from "bun:test"
import { extractGradeBreakdowns, isTruncatedTestId } from "./python-swebench"

describe("isTruncatedTestId — only flags ids that cannot match a real test", () => {
  test("REAL conan truncated ids (from the live repro) are flagged", () => {
    for (const id of [
      "conans/test/unittests/tools/microsoft/test_msvs_toolset.py::test_intel_cc_default[2021.3-classic-Intel",
      'conans/test/functional/command/export_test.py::TestRevisionModeSCM::test_revision_mode_scm_excluded_files[+["*.cpp",',
      'conans/test/integration/graph/test_dependencies_visit.py::test_cmake_zlib[print("=>{}".format(self.dependencies.get("zlib",',
    ]) {
      expect(isTruncatedTestId(id)).toBe(true)
    }
  })

  test("VALID ids are NEVER flagged (no false drop of a real test)", () => {
    for (const id of [
      // non-parametrized
      "conans/test/functional/tools/scm/test_git.py::TestGitBasicSCMFlow::test_full_scm",
      // balanced parametrized (the real, complete form — ends in ])
      "conans/test/unittests/tools/microsoft/test_msvs_toolset.py::test_intel_cc_default[2021.3-classic-Intel C++ Compiler 19.2]",
      "pkg/test_x.py::test_y[True]",
      "pkg/test_x.py::test_y[a-b-c]",
      // a param value that itself contains brackets but is still closed
      "pkg/test_x.py::test_y[list[int]]",
    ]) {
      expect(isTruncatedTestId(id)).toBe(false)
    }
  })
})

const breakdownOf = (tests_status: unknown) =>
  extractGradeBreakdowns({ "x__x-1": { resolved: false, tests_status } }).get("x__x-1")

describe("extractGradeBreakdowns — re-derives resolution excluding truncated ids", () => {
  test("ONLY truncated P2P 'failures' ⇒ UPGRADE to resolved (harness said false)", () => {
    const b = breakdownOf({
      FAIL_TO_PASS: { success: ["a::t1[True]", "a::t2[True]"], failure: [] },
      PASS_TO_PASS: { success: ["b::ok[x]"], failure: ["c::p[2021.3-Intel", 'c::q[+["*.cpp",'] },
    })
    expect(b?.resolved).toBe(true) // upgraded — the only "failures" are non-existent ids
    expect(b?.passToPassFailed).toBe(0)
    expect(b?.truncatedExcluded).toBe(2)
  })

  test("a REAL P2P failure (valid id) is NEVER masked, even alongside truncated ones", () => {
    const b = breakdownOf({
      FAIL_TO_PASS: { success: ["a::t[True]"], failure: [] },
      PASS_TO_PASS: { success: [], failure: ["c::real_regression[ok]", "c::trunc[2021.3-Intel"] },
    })
    expect(b?.resolved).toBe(false) // the valid failure still vetoes
    expect(b?.passToPassFailed).toBe(1) // only the real one counts
    expect(b?.truncatedExcluded).toBe(1)
  })

  test("a truncated FAIL_TO_PASS id does not fake a resolve when the real F2P didn't pass", () => {
    // F2P has a real (valid) failure ⇒ the target was NOT fixed ⇒ unresolved regardless of truncation.
    const b = breakdownOf({
      FAIL_TO_PASS: { success: [], failure: ["a::target[real]"] },
      PASS_TO_PASS: { success: ["b::ok"], failure: [] },
    })
    expect(b?.resolved).toBe(false)
    expect(b?.failToPassFailed).toBe(1)
  })

  test("clean run (no failures, no truncation) ⇒ resolved, truncatedExcluded omitted", () => {
    const b = breakdownOf({
      FAIL_TO_PASS: { success: ["a::t[True]"], failure: [] },
      PASS_TO_PASS: { success: ["b::ok"], failure: [] },
    })
    expect(b?.resolved).toBe(true)
    expect(b?.truncatedExcluded).toBeUndefined()
  })
})
