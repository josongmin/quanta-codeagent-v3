/**
 * TB foundation — PASS_TO_PASS threading (eval-only) into `Instance.swebench`.
 *
 * The regression oracle (verify-and-select) needs the official PASS_TO_PASS set
 * to decide `regressionGreen`. It is threaded the SAME eval-only way the gold
 * patch is — parsed from the dataset row, attached to `swebench`, NEVER given to
 * the agent loop. These teeth lock the parse (malformed ⇒ omitted, never `[]`)
 * and the threading (present ⇒ on `swebench.passToPass`, absent ⇒ undefined so
 * the regression signal stays FAIL-OPEN).
 */
import { describe, expect, test } from "bun:test"
import { parseTestNameList, toInstance } from "@/runner/batch/corpus/dataset"
import type { SwebenchTask } from "@/runner/batch/corpus/dataset"

const taskWith = (raw: Record<string, unknown>): SwebenchTask => ({
  instanceId: "sympy__sympy-17630",
  repo: "sympy/sympy",
  baseCommit: "deadbeef",
  problemStatement: typeof raw.problem_statement === "string" ? raw.problem_statement : "fix the bug",
  raw,
})

describe("parseTestNameList", () => {
  test("parses a JSON string array of node-ids", () => {
    const out = parseTestNameList(
      { PASS_TO_PASS: JSON.stringify(["a.py::t1", "b.py::t2"]) },
      "PASS_TO_PASS",
    )
    expect(out).toEqual(["a.py::t1", "b.py::t2"])
  })

  test("drops non-string / empty entries", () => {
    const out = parseTestNameList(
      { PASS_TO_PASS: JSON.stringify(["keep", "", 7, null, "keep2"]) },
      "PASS_TO_PASS",
    )
    expect(out).toEqual(["keep", "keep2"])
  })

  // FAIL-OPEN teeth: every degenerate input must collapse to `undefined`, never
  // `[]` — an empty array threaded through would later map to FAIL-OPEN anyway,
  // but `undefined` keeps the omit-the-key contract (exactOptionalPropertyTypes).
  test("absent field ⇒ undefined", () => {
    expect(parseTestNameList({}, "PASS_TO_PASS")).toBeUndefined()
  })
  test("non-string field ⇒ undefined", () => {
    expect(parseTestNameList({ PASS_TO_PASS: ["already", "array"] }, "PASS_TO_PASS")).toBeUndefined()
  })
  test("malformed JSON ⇒ undefined", () => {
    expect(parseTestNameList({ PASS_TO_PASS: "{not json" }, "PASS_TO_PASS")).toBeUndefined()
  })
  test("empty array ⇒ undefined (omit, not [])", () => {
    expect(parseTestNameList({ PASS_TO_PASS: "[]" }, "PASS_TO_PASS")).toBeUndefined()
  })
  test("all-blank array ⇒ undefined", () => {
    expect(parseTestNameList({ PASS_TO_PASS: JSON.stringify(["", "  "]) }, "PASS_TO_PASS")).toEqual([
      "  ",
    ])
    // (whitespace-only is a non-empty string — kept; only length-0 is dropped)
  })
})

describe("toInstance — PASS_TO_PASS threading", () => {
  test("present ⇒ swebench.passToPass populated", () => {
    const inst = toInstance(
      taskWith({ PASS_TO_PASS: JSON.stringify(["t1", "t2"]) }),
      "/tmp/repo",
    )
    expect(inst.swebench?.passToPass).toEqual(["t1", "t2"])
  })

  // red-on-injection: removing the threading line makes this go from defined→undefined.
  test("absent ⇒ swebench.passToPass undefined (regression signal FAIL-OPEN)", () => {
    const inst = toInstance(taskWith({}), "/tmp/repo")
    expect(inst.swebench).toBeDefined()
    expect(inst.swebench?.passToPass).toBeUndefined()
  })

  // No-leak proof: PASS_TO_PASS lands ONLY under swebench (eval-only), never on
  // the agent-facing fields (problemStatement / testCmd must not echo it).
  test("no-leak: PASS_TO_PASS not echoed into agent-facing problemStatement", () => {
    const inst = toInstance(
      taskWith({
        problem_statement: "fix the bug",
        PASS_TO_PASS: JSON.stringify(["secret_regression_test_xyz"]),
      } as Record<string, unknown>),
      "/tmp/repo",
    )
    // toInstance reads problemStatement from task.problemStatement (not raw), so
    // this is belt-and-suspenders, but it fences the eval-only boundary.
    expect(inst.problemStatement).not.toContain("secret_regression_test_xyz")
  })

  test("swebench testCmd installs setuptools in the repo-local verifier env", () => {
    const inst = toInstance(
      taskWith({
        FAIL_TO_PASS: JSON.stringify(["tests/test_x.py::test_y"]),
        version: "1.5",
      }),
      "/tmp/repo",
    )
    expect(inst.testCmd).toContain("--with pytest")
    expect(inst.testCmd).toContain("--with setuptools")
    expect(inst.testCmd).toContain("--no-project")
    expect(inst.testCmd).toContain("--with-editable . pytest -x --no-header")
  })

  test("xarray testCmd shell-quotes the numpy<2 guard instead of redirecting it", () => {
    const inst = toInstance(
      {
        instanceId: "pydata__xarray-2905",
        repo: "pydata/xarray",
        baseCommit: "deadbeef",
        problemStatement: "fix the bug",
        raw: {
          repo: "pydata/xarray",
          version: "0.12",
          FAIL_TO_PASS: JSON.stringify(["xarray/tests/test_variable.py::TestAsCompatibleData::test_unsupported_type"]),
        },
      },
      "/tmp/repo",
    )
    expect(inst.testCmd).toContain("--with 'numpy<2'")
  })
})
