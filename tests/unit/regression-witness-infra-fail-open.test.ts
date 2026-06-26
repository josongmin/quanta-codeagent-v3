/**
 * F3R — regression witness fail-OPEN on infra failure (jun-25).
 *
 * PRINCIPLE under test: an infrastructure failure (the regression witness could
 * not RUN — exec port threw / ENOENT / timeout-kill / pytest never reached a
 * verdict) must NEVER be scored as a correctness `regressionGreen=false`. It
 * must fail-OPEN (null). A REAL test failure (pytest ran and a base-green
 * witness broke) must still bar (`false`).
 *
 * ROOT CAUSE this guards: `executeWitnessTestsOnPatched` previously collapsed a
 * `null` "couldn't run" verdict into a `failure` (`!== true`), so a correct
 * patch whose witness merely failed to RUN on the patched tree (a broken exec
 * env) became `regressionGreen=false` → an unjust hard veto → winner=null →
 * empty patch laundered as a model miss.
 */
import { describe, expect, test } from "bun:test"
import {
  executeWitnessTestsOnPatched,
  type WitnessRunVerdict,
} from "@/apps/bench/eval/repo-regression-discovery-adapter"

describe("F3R: regression witness fail-open on infra", () => {
  // ── RED-on-injection: infra must NOT become a correctness false ──────────
  test("an infra verdict on the patched tree fails OPEN (null), is not a failure", async () => {
    const executed: string[] = []
    const out = await executeWitnessTestsOnPatched(
      ["tests/test_a.py"],
      async (test): Promise<WitnessRunVerdict> => {
        executed.push(test)
        return "infra" // the witness could not RUN (e.g. exec threw / ENOENT)
      },
    )
    // The witness was attempted, but the run was infra-blocked: no verdict.
    expect(executed).toEqual(["tests/test_a.py"])
    // CRITICAL: fail-OPEN. Not `false`. An infra failure has no veto authority.
    expect(out.regressionGreen).toBeNull()
    expect(out.failures).toEqual([])
    expect(out.infraSkipped).toEqual(["tests/test_a.py"])
  })

  test("a mix of green + infra fails OPEN-to-green only on the green evidence (infra never bars)", async () => {
    const out = await executeWitnessTestsOnPatched(
      ["tests/test_green.py", "tests/test_infra.py"],
      async (test): Promise<WitnessRunVerdict> =>
        test === "tests/test_green.py" ? "green" : "infra",
    )
    // One witness actually ran and stayed green; the other was infra-blocked.
    // There is positive (green) evidence and ZERO real red → safety_green.
    expect(out.regressionGreen).toBe(true)
    expect(out.failures).toEqual([])
    expect(out.infraSkipped).toEqual(["tests/test_infra.py"])
  })

  test("ALL witnesses infra-blocked ⇒ null (no executed evidence at all)", async () => {
    const out = await executeWitnessTestsOnPatched(
      ["tests/test_a.py", "tests/test_b.py"],
      async (): Promise<WitnessRunVerdict> => "infra",
    )
    expect(out.regressionGreen).toBeNull()
    expect(out.failures).toEqual([])
    expect(out.infraSkipped).toEqual(["tests/test_a.py", "tests/test_b.py"])
  })

  // ── PAIRED CONTROL: a REAL regression still bars ─────────────────────────
  test("a REAL red (witness ran and broke) still bars with regressionGreen=false", async () => {
    const out = await executeWitnessTestsOnPatched(
      ["tests/test_a.py", "tests/test_b.py"],
      async (test): Promise<WitnessRunVerdict> => (test === "tests/test_b.py" ? "red" : "green"),
    )
    expect(out.regressionGreen).toBe(false)
    expect(out.failures).toEqual(["tests/test_b.py"])
    expect(out.infraSkipped).toEqual([])
  })

  test("a real red dominates a co-occurring infra skip (infra cannot launder a real regression away)", async () => {
    const out = await executeWitnessTestsOnPatched(
      ["tests/test_red.py", "tests/test_infra.py"],
      async (test): Promise<WitnessRunVerdict> => (test === "tests/test_red.py" ? "red" : "infra"),
    )
    // A real executed red exists ⇒ bar. The infra skip is recorded but does not
    // change the verdict (and is NOT itself counted as a failure).
    expect(out.regressionGreen).toBe(false)
    expect(out.failures).toEqual(["tests/test_red.py"])
    expect(out.infraSkipped).toEqual(["tests/test_infra.py"])
  })

  test("all green ⇒ regressionGreen=true (positive evidence, unchanged)", async () => {
    const out = await executeWitnessTestsOnPatched(
      ["tests/test_a.py", "tests/test_b.py"],
      async (): Promise<WitnessRunVerdict> => "green",
    )
    expect(out.regressionGreen).toBe(true)
    expect(out.failures).toEqual([])
    expect(out.infraSkipped).toEqual([])
  })
})
