import { describe, expect, it } from "bun:test"
import { discoverImpactedTestCandidates } from "@/runner/batch/eval/impacted-test-discovery"

// #6: the `maxTests` cap drops lower-ranked admissible witnesses from the
// executed regression set. Pre-fix that drop was silent — so a candidate that
// breaks a capped-out witness reads as `regressionGreen` (the gate never ran the
// breaking test). `onCap` makes the truncation observable: discovered vs executed.

const TWO_WITNESSES = {
  changedFiles: ["pkg/core.py"],
  repoFiles: [
    { path: "tests/test_other.py", text: "from pkg.core import run\n" },
    { path: "pkg/tests/test_core.py", text: "from pkg.core import run\n" },
  ],
}

describe("impacted-test cap telemetry (#6)", () => {
  it("fires onCap with discovered>executed when the cap truncates witnesses", () => {
    const caps: { discovered: number; executed: number }[] = []
    const kept = discoverImpactedTestCandidates({
      ...TWO_WITNESSES,
      maxTests: 1,
      onCap: (info) => caps.push(info),
    })
    expect(kept).toHaveLength(1) // cap honored
    expect(caps).toEqual([{ discovered: 2, executed: 1 }]) // …and the drop is surfaced
  })

  it("does NOT fire onCap when every discovered witness fits under the cap", () => {
    const caps: unknown[] = []
    const kept = discoverImpactedTestCandidates({
      ...TWO_WITNESSES,
      maxTests: 5,
      onCap: (info) => caps.push(info),
    })
    expect(kept).toHaveLength(2)
    expect(caps).toEqual([])
  })

  it("exactly-at-cap does not fire onCap (no witnesses dropped)", () => {
    const caps: unknown[] = []
    discoverImpactedTestCandidates({
      ...TWO_WITNESSES,
      maxTests: 2,
      onCap: (info) => caps.push(info),
    })
    expect(caps).toEqual([])
  })
})
