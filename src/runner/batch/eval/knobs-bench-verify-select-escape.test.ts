import { describe, expect, test } from "bun:test"
import { benchPostureFromState, resolveBenchKnobs } from "./knobs-bench"

/**
 * B1 — verify-select is a RETIRED footgun (jun-27: the best-of-N veto SELECTION
 * plane laundered correct patches to empty when no candidate passed the hard
 * gates). Its knob read is now FAIL-CLOSED: `QUANTA_BENCH_VERIFY_SELECT=<n>`
 * resolves to `verifySelectN` only when the explicit operator ESCAPE hatch
 * `QUANTA_BENCH_VERIFY_SELECT_ESCAPE` is set. Without the escape, the plane stays
 * inert (`verifySelectN === undefined` ⇒ single-pass path, byte-identical to a
 * run that never set the knob).
 */
describe("B1 verify-select fail-closed behind QUANTA_BENCH_VERIFY_SELECT_ESCAPE", () => {
  const posture = (env: NodeJS.ProcessEnv) =>
    benchPostureFromState(resolveBenchKnobs({ envVars: env }), env)

  test("verify-select set WITHOUT escape ⇒ inert (verifySelectN undefined)", () => {
    const p = posture({ QUANTA_BENCH_VERIFY_SELECT: "3" })
    expect(p.verifySelectN).toBeUndefined()
  })

  test("verify-select set WITH escape ⇒ honored (verifySelectN = 3)", () => {
    const p = posture({
      QUANTA_BENCH_VERIFY_SELECT: "3",
      QUANTA_BENCH_VERIFY_SELECT_ESCAPE: "1",
    })
    expect(p.verifySelectN).toBe(3)
  })

  test("no verify-select env ⇒ undefined regardless of escape (byte-identical default)", () => {
    expect(posture({}).verifySelectN).toBeUndefined()
    expect(posture({ QUANTA_BENCH_VERIFY_SELECT_ESCAPE: "1" }).verifySelectN).toBeUndefined()
  })
})
