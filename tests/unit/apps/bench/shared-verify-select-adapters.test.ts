import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

describe("apps bench driver shared verify-select adapters", () => {
  test("apps driver imports shared regression adapters instead of a drifting local copy", () => {
    expect(DRIVER_SRC).toContain(
      'from "@/runner/batch/eval/regression-oracle-adapter"',
    )
    expect(DRIVER_SRC).toContain(
      'from "@/runner/batch/eval/repo-regression-discovery-adapter"',
    )
    expect(DRIVER_SRC).not.toContain('from "./regression-oracle-adapter"')
    expect(DRIVER_SRC).not.toContain('from "./repo-regression-discovery-adapter"')
  })
})
