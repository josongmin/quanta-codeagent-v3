import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const APP_DRIVER_SRC = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")
// The runner core driver was split (jul-02) into `./driver/*` submodules (pure
// code motion). The regression-oracle / repo-regression-discovery adapter wiring
// the runner core OWNS (and the app delegates to) now lives in those submodules,
// which import via `../` since they sit one level deeper. Aggregate the barrel +
// all submodule sources so the SSOT invariant is unchanged by the file split.
const DRIVER_DIR = join(REPO_ROOT, "src/runner/batch/eval/driver")
const SHARED_DRIVER_SRC = [
  readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8"),
  ...readdirSync(DRIVER_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(DRIVER_DIR, f), "utf8")),
].join("\n")

describe("apps bench driver shared verify-select adapters", () => {
  test("apps driver routes verify-select ownership through the shared runner driver", () => {
    expect(APP_DRIVER_SRC).toContain('from "@/runner/batch/eval/driver"')
    expect(APP_DRIVER_SRC).toContain("computeEffectiveProofRequired")
    expect(APP_DRIVER_SRC).toContain("familyCoverageCoeditEnabled")
    expect(APP_DRIVER_SRC).not.toContain('from "./regression-oracle-adapter"')
    expect(APP_DRIVER_SRC).not.toContain('from "./repo-regression-discovery-adapter"')
    expect(SHARED_DRIVER_SRC).toContain('from "../regression-oracle-adapter"')
    expect(SHARED_DRIVER_SRC).toContain('from "../repo-regression-discovery-adapter"')
  })

  test("apps driver routes repair llm evidence through the bench-local repair facade", () => {
    expect(APP_DRIVER_SRC).toContain('from "./repair/llm-evidence"')
    expect(APP_DRIVER_SRC).not.toContain('from "@/runner/batch/eval/repair/llm-evidence"')
  })
})
