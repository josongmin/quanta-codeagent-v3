/**
 * Phase A — regression test-set selection (SOTA++ dual-guard, the missing half).
 *
 * Faithful pure reimplementation of agentless/test/select_regression_tests.py:
 * given the tests that PASS on the un-patched repo, the LLM names which to EXCLUDE
 * (functionality the fix may legitimately change); the regression set = passing −
 * excluded. A context-fit guard halves the passing list until the prompt fits.
 *
 * CLEAN TOGGLE: every export here is a PURE function (parse/diff/prompt/fit) plus
 * ONE injected-LLM orchestrator. Nothing runs unless a caller invokes it, so the
 * whole dual-guard path is default-OFF/inert by construction.
 */

import { describe, expect, test } from "bun:test"
import {
  buildRegressionSelectPrompt,
  fitPassingToContext,
  parseExcludedTests,
  resolveRegressionTests,
  selectRegressionSubset,
} from "../../src/runner/batch/eval/regression-select"

describe("parseExcludedTests (model output → excluded names)", () => {
  test("empty / whitespace ⇒ []", () => {
    expect(parseExcludedTests("")).toEqual([])
    expect(parseExcludedTests("   \n  ")).toEqual([])
  })
  test("multi-line ⇒ trimmed non-empty lines", () => {
    expect(parseExcludedTests("test1\n test2 \n\ntest5\n")).toEqual(["test1", "test2", "test5"])
  })
})

describe("selectRegressionSubset (keep = passing − excluded)", () => {
  test("removes exactly the excluded, preserves order", () => {
    expect(selectRegressionSubset(["a", "b", "c", "d"], ["b", "d"])).toEqual(["a", "c"])
  })
  test("excluded names not in passing are ignored", () => {
    expect(selectRegressionSubset(["a", "b"], ["x", "y"])).toEqual(["a", "b"])
  })
  test("exact-match only (no substring/prefix removal)", () => {
    expect(selectRegressionSubset(["test_a", "test_ab"], ["test_a"])).toEqual(["test_ab"])
  })
})

describe("fitPassingToContext (halve until prompt fits)", () => {
  test("halves the passing list until token count is under the limit", () => {
    const passing = Array.from({ length: 8 }, (_, i) => `t${i}`)
    // fake counter: ~1 token per test name in the prompt.
    const count = (msg: string) => msg.split("\n").length
    const fitted = fitPassingToContext("issue", passing, count, /*limit*/ 6)
    expect(fitted.length).toBeLessThan(8)
    // it keeps a HEAD slice (deterministic), never reorders
    expect(fitted).toEqual(passing.slice(0, fitted.length))
  })
  test("already-fitting list is returned unchanged", () => {
    const passing = ["a", "b"]
    expect(fitPassingToContext("i", passing, () => 1, 1000)).toEqual(passing)
  })
})

describe("buildRegressionSelectPrompt", () => {
  test("embeds the issue + the passing tests verbatim", () => {
    const p = buildRegressionSelectPrompt("THE ISSUE", ["t_one", "t_two"])
    expect(p).toContain("THE ISSUE")
    expect(p).toContain("t_one")
    expect(p).toContain("t_two")
    expect(p.toLowerCase()).toContain("should not be run")
  })
})

describe("resolveRegressionTests (orchestrator, injected LLM)", () => {
  test("empty passing ⇒ empty regression, no LLM call", async () => {
    let called = false
    const r = await resolveRegressionTests("issue", [], {
      llm: async () => {
        called = true
        return "x"
      },
    })
    expect(r.regression).toEqual([])
    expect(called).toBe(false)
  })

  test("LLM-excluded tests are removed; rest become the regression set", async () => {
    const r = await resolveRegressionTests("issue", ["a", "b", "c"], {
      llm: async () => "b\n",
    })
    expect(r.regression).toEqual(["a", "c"])
    expect(r.original).toEqual(["a", "b", "c"])
    expect(r.raw).toBe("b\n")
  })

  test("MUTATION GUARD: a candidate the model excludes never survives", async () => {
    const r = await resolveRegressionTests("issue", ["keep", "drop"], {
      llm: async () => "drop",
    })
    expect(r.regression.includes("drop")).toBe(false)
    expect(r.regression.includes("keep")).toBe(true)
  })
})
