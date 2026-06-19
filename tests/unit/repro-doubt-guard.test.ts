/**
 * Hellgate RED→GREEN for the repro-doubt guard (src/agent/repro-doubt-guard.ts).
 *
 * MEASURED failure mode this targets (jun-20, bon3 run): the agent edits the RIGHT
 * site, the false-negative repro oracle keeps the test red, so the agent re-runs the
 * test 5..N times with no further edit and burns the whole turn budget
 * (`verify_loop_stuck`, 124 turns → FAIL). The structural intervention: after K
 * consecutive test re-runs WITHOUT an intervening edit (and only once the agent has
 * actually attempted a fix), inject a one-shot steer telling it to DOUBT ITS REPRO
 * TEST (not just its patch) and submit if the fix looks right — breaking the churn.
 *
 * The guard is a pure reducer over the tool-call stream; default-OFF (no threshold ⇒
 * byte-identical no-op), fires the steer at most once, and resets on every edit.
 */
import { describe, expect, test } from "bun:test"
import {
  createReproDoubtState,
  reproDoubtStep,
  REPRO_DOUBT_STEER,
} from "@/agent/repro-doubt-guard"

const cfg = { stuckRuns: 5 }

const drive = (tools: string[], c = cfg) => {
  let s = createReproDoubtState()
  const steers: (string | undefined)[] = []
  for (const t of tools) {
    const r = reproDoubtStep(s, t, c)
    s = r.state
    steers.push(r.steer)
  }
  return steers
}

describe("repro-doubt-guard", () => {
  test("no-op when no config (byte-identical baseline)", () => {
    // call the reducer directly — passing `undefined` to drive() would trip JS
    // default-param semantics and silently substitute `cfg`.
    let s = createReproDoubtState()
    for (const t of ["edit", "bash", "bash", "bash", "bash", "bash", "bash"]) {
      const r = reproDoubtStep(s, t, undefined)
      s = r.state
      expect(r.steer).toBeUndefined()
    }
  })

  test("no-op when stuckRuns is invalid (0 / non-integer)", () => {
    for (const bad of [{ stuckRuns: 0 }, { stuckRuns: -1 }, { stuckRuns: 2.5 }, {}]) {
      let s = createReproDoubtState()
      const r1 = reproDoubtStep(s, "edit", bad as any)
      const r2 = reproDoubtStep(r1.state, "bash", bad as any)
      expect(r1.steer).toBeUndefined()
      expect(r2.steer).toBeUndefined()
    }
  })

  test("fires after K test-runs that FOLLOW an edit", () => {
    // edit (attempted a fix) then 5 test re-runs with no edit ⇒ steer on the 5th
    const steers = drive(["edit", "bash", "bash", "bash", "bash", "bash"])
    expect(steers.slice(0, 5).every((x) => x === undefined)).toBe(true)
    expect(steers[5]).toBe(REPRO_DOUBT_STEER)
  })

  test("does NOT fire before any edit (no fix attempted yet)", () => {
    // 6 test runs but the agent never edited ⇒ it's still exploring, not stuck-on-fix
    const steers = drive(["bash", "bash", "bash", "bash", "bash", "bash"])
    expect(steers.every((x) => x === undefined)).toBe(true)
  })

  test("an intervening edit RESETS the counter (progress ⇒ not stuck)", () => {
    const steers = drive(["edit", "bash", "bash", "edit", "bash", "bash", "bash"])
    expect(steers.every((x) => x === undefined)).toBe(true)
  })

  test("fires at most ONCE per stuck streak", () => {
    const steers = drive(["edit", "bash", "bash", "bash", "bash", "bash", "bash", "bash"])
    const fired = steers.filter((x) => x === REPRO_DOUBT_STEER)
    expect(fired.length).toBe(1)
  })

  test("write counts as an edit (resets)", () => {
    const steers = drive(["write", "bash", "bash", "edit", "bash", "bash", "bash"])
    expect(steers.every((x) => x === undefined)).toBe(true)
  })

  test("non-test tools between runs do not advance the stuck counter", () => {
    // read/grep are investigation, not test-churn; should not trip the guard
    const steers = drive(["edit", "bash", "read", "grep", "bash", "read", "bash"])
    expect(steers.every((x) => x === undefined)).toBe(true)
  })

  test("test_runner tool also counts as a test run", () => {
    // [edit, tr×5] → 5th test run (array index 5) trips the guard
    const steers = drive(["edit", "test_runner", "test_runner", "test_runner", "test_runner", "test_runner"])
    expect(steers.slice(0, 5).every((x) => x === undefined)).toBe(true)
    expect(steers[5]).toBe(REPRO_DOUBT_STEER)
  })

  test("respects a custom stuckRuns threshold", () => {
    const steers = drive(["edit", "bash", "bash", "bash"], { stuckRuns: 3 })
    expect(steers[3]).toBe(REPRO_DOUBT_STEER) // 3rd run trips it
  })
})
