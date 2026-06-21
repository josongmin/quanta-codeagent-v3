import { describe, expect, test } from "bun:test"
import { buildProjectPytestArgv as buildAppProjectPytestArgv } from "@/apps/bench/eval/regression-oracle-adapter"
import { buildProjectPytestArgv } from "@/runner/batch/eval/regression-oracle-adapter"

const hasWithDep = (argv: readonly string[], dep: string): boolean =>
  argv.some((arg, idx) => arg === "--with" && argv[idx + 1] === dep)

describe("buildProjectPytestArgv", () => {
  test("shared verifier env installs pytest + setuptools in the uv-run project env", () => {
    const argv = buildProjectPytestArgv("pydata/xarray", "2023.1")(["tests/test_x.py::test_y"])
    expect(argv.slice(0, 2)).toEqual(["uv", "run"])
    expect(argv).toContain("--no-project")
    expect(hasWithDep(argv, "pytest")).toBe(true)
    expect(hasWithDep(argv, "setuptools")).toBe(true)
    expect(argv).toContain("--with-editable")
    expect(argv[argv.length - 1]).toBe("tests/test_x.py::test_y")
  })

  test("apps bench adapter stays a thin re-export of the shared verifier builder", () => {
    const tests = ["tests/test_x.py::test_y"]
    expect(buildAppProjectPytestArgv("pydata/xarray", "2023.1")(tests)).toEqual(
      buildProjectPytestArgv("pydata/xarray", "2023.1")(tests),
    )
  })
})
