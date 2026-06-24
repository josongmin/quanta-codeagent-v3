import { describe, expect, test } from "bun:test"
import { familyCoverageCoeditEnabled } from "@/runner/batch/eval/driver"
import { __private__ } from "@/runner/batch/eval/family-coverage-coedit"

describe("family coverage co-edit", () => {
  test("coedit gate is default-OFF and explicit opt-in only", () => {
    expect(familyCoverageCoeditEnabled({})).toBe(false)
    expect(familyCoverageCoeditEnabled({ QUANTA_BENCH_FAMILY_COVERAGE_COEDIT: "1" })).toBe(true)
    expect(
      familyCoverageCoeditEnabled({ QUANTA_BENCH_FAMILY_COVERAGE_COEDIT: "true" }),
    ).toBe(true)
    expect(
      familyCoverageCoeditEnabled({ QUANTA_BENCH_FAMILY_COVERAGE_COEDIT: "off" }),
    ).toBe(false)
  })

  test("replays bounded exact-block donor edits onto one sibling file", () => {
    const donorBefore = [
      "def runshell(self, parameters):",
      "    args = [self.executable_name]",
      "    subprocess.run(args)",
    ].join("\n")
    const donorAfter = [
      "def runshell(self, parameters):",
      "    env = os.environ.copy()",
      "    args = [self.executable_name]",
      "    subprocess.run(args, env=env)",
    ].join("\n")
    const siblingBefore = [
      "def runshell(self, parameters):",
      "    args = [self.executable_name]",
      "    subprocess.run(args)",
    ].join("\n")

    const replayed = __private__.applyExactReplay(siblingBefore, donorBefore, donorAfter)

    expect(replayed).toBe(
      [
        "def runshell(self, parameters):",
        "    env = os.environ.copy()",
        "    args = [self.executable_name]",
        "    subprocess.run(args, env=env)",
      ].join("\n"),
    )
  })
})
