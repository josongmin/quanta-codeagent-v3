import { describe, expect, test } from "bun:test"
import { cpus, loadavg } from "node:os"
import {
  describeQuietBoxWait,
  loadPerCore,
  quietBoxBudgetMs,
  waitForQuietBox,
} from "../../../tools/dev/box-load"

/**
 * The wait that keeps a real-toolchain gate off a saturated box.
 *
 * MEASURED, and the reason this exists: another session on this machine left 40
 * orphaned busy-loop shells running for nine and a half hours, holding a
 * 16-core box at load 52. Same commit, same command,
 * `evidence-lsp-bridge-real-e2e.test.ts` went 1 pass / 1 fail at load 52 and
 * 2 pass in 5.2s at load 3.9 — a starved language server answers with an EMPTY
 * hover, not a late one, which is why no timeout was touched.
 *
 * Every branch here is a decision that can silently invert the rail's verdict,
 * so time is injected rather than slept.
 */

const fakeClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let clock = 0
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
  }
}

describe("waiting for a box that is not oversubscribed", () => {
  test("an already-quiet box is not waited for at all", async () => {
    const { now, sleep } = fakeClock()
    let samples = 0
    const wait = await waitForQuietBox({
      budgetMs: 180_000,
      now,
      sleep,
      sample: () => {
        samples += 1
        return 0.25
      },
    })
    expect(wait.settled).toBe(true)
    expect(wait.waitedMs).toBe(0)
    expect(samples).toBe(1)
    expect(describeQuietBoxWait(wait)).toBe("box quiet (load/core 0.25)")
  })

  test("it waits while load decays, and reports both ends", async () => {
    const { now, sleep } = fakeClock()
    // The shape of a real campaign: the full suite's own load decaying away.
    const readings = [3.3, 2.4, 1.6, 0.9]
    let index = 0
    const wait = await waitForQuietBox({
      budgetMs: 180_000,
      pollMs: 2_000,
      now,
      sleep,
      sample: () => readings[Math.min(index++, readings.length - 1)] ?? 0,
    })
    expect(wait.settled).toBe(true)
    expect(wait.startPerCore).toBe(3.3)
    expect(wait.endPerCore).toBe(0.9)
    expect(wait.waitedMs).toBe(6_000)
    expect(describeQuietBoxWait(wait)).toBe("waited 6s for a quiet box (load/core 3.30 → 0.90)")
  })

  test("foreign load exhausts the budget and the gate runs anyway — loudly", async () => {
    // This is the case that must NOT block: the 52-load box was held there by
    // another project's runaway, and a verification rail that refuses to run on
    // a working machine is a rail nobody can use. It runs, and says so.
    const { now, sleep } = fakeClock()
    const wait = await waitForQuietBox({
      budgetMs: 180_000,
      pollMs: 2_000,
      now,
      sleep,
      sample: () => 3.28, // 52.5 / 16 cores — the measured saturation
    })
    expect(wait.settled).toBe(false)
    expect(wait.waitedMs).toBe(180_000)
    expect(wait.endPerCore).toBe(3.28)
    const line = describeQuietBoxWait(wait)
    expect(line).toContain("RAN HOT")
    expect(line).toContain("3.28")
    // The attribution the last campaign was missing, in the line itself.
    expect(line).toContain("may be contention, not code")
  })

  test("the threshold is the definition of oversubscribed, not a tuned number", async () => {
    const { now, sleep } = fakeClock()
    // Exactly one runnable thread per CPU is subscribed, not over: it must not
    // wait. Anything above it competes.
    const atOne = await waitForQuietBox({ budgetMs: 1_000, now, sleep, sample: () => 1 })
    expect(atOne.settled).toBe(true)
    expect(atOne.waitedMs).toBe(0)

    const justOver = await waitForQuietBox({
      budgetMs: 0, // no budget: prove it wanted to wait rather than that it did
      now,
      sleep,
      sample: () => 1.01,
    })
    expect(justOver.settled).toBe(false)
  })

  test("loadPerCore divides by the CPUs this box actually has", () => {
    const measured = loadPerCore()
    expect(Number.isFinite(measured)).toBe(true)
    expect(measured).toBeGreaterThanOrEqual(0)
    // Bound it to the live reading rather than to a constant, so the assertion
    // survives whatever this box happens to be doing while the suite runs.
    const expected = (loadavg()[0] ?? 0) / cpus().length
    expect(Math.abs(measured - expected)).toBeLessThan(Math.max(0.5, expected * 0.5 + 0.01))
  })

  test("the budget seam is honoured only for a value that parses", () => {
    // Production never sets this; a fixture sets 0 so it can prove the wait is
    // wired without its duration depending on what else the box is doing. A
    // typo must fall back to the real budget rather than silently disable it.
    expect(quietBoxBudgetMs({}, 180_000)).toBe(180_000)
    // Inside a shard worker the budget is zero whatever else is set: a fixture
    // campaign must not wait on the machine, and this answers "am I inside the
    // test rail" exactly — `run-test-shards` sets it on every worker and
    // nothing else does.
    expect(quietBoxBudgetMs({ QUANTA_TEST_TIMEOUT_SCALE: "2" }, 180_000)).toBe(0)
    expect(
      quietBoxBudgetMs(
        { QUANTA_TEST_TIMEOUT_SCALE: "2", QUANTA_QUIET_BOX_BUDGET_MS: "90000" },
        180_000,
      ),
    ).toBe(0)
    expect(quietBoxBudgetMs({ QUANTA_QUIET_BOX_BUDGET_MS: "0" }, 180_000)).toBe(0)
    expect(quietBoxBudgetMs({ QUANTA_QUIET_BOX_BUDGET_MS: "5000" }, 180_000)).toBe(5_000)
    for (const bad of ["", "abc", "-1", "1e9999"]) {
      expect(quietBoxBudgetMs({ QUANTA_QUIET_BOX_BUDGET_MS: bad }, 180_000), bad).toBe(180_000)
    }
  })
})
