import { describe, expect, test } from "bun:test"
import {
  discoverImpactedTestCandidates,
  discoverImpactedTests,
  isPythonTestFile,
  normalizeRepoPath,
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
})
