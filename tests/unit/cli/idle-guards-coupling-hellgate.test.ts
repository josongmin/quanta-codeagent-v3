/**
 * Hellgate — `QUANTA_IDLE_SUPPRESS` must not disarm the approval-rejection rail.
 *
 * `cliBuildIdleGuards` built all three guard fields behind one conjunct:
 *
 *     threshold: runtime.idleSuppressOn && Number.isFinite(runtime.rejectLimit) && …
 *
 * The two idle fields belong there — `idleSuppressOn` is the presence-tracking
 * switch, and with it off there is no idleness to threshold. The reject counter does
 * not. It counts consecutive tool-approval DENIALS, and `reject-counter.ts` documents
 * exactly one way off: "`threshold = Infinity` ⇒ `shouldAutoExit()` is always false.
 * That's how `QUANTA_REJECT_LIMIT=0` disables the mechanism — no internal kill-switch
 * needed."
 *
 * So `QUANTA_IDLE_SUPPRESS=0` was a SECOND kill switch for a safety rail, documented
 * nowhere and named in none of the four affected describes. Measured before the fix:
 * with `QUANTA_IDLE_SUPPRESS=0` and `QUANTA_REJECT_LIMIT=3`, the limit resolved to
 * Infinity and the auto-exit never fired across 50 consecutive denials.
 *
 * The function was a module-local `const`, so no test could reach the decision it
 * owns. It is exported for this file.
 */
import { describe, expect, test } from "bun:test"
import { createRejectCounter } from "@/apps/cli/reject-counter"
import { resolveIdleGuardLimits } from "@/apps/cli/repl"

type Runtime = Parameters<typeof resolveIdleGuardLimits>[0]

const runtime = (over: Partial<Runtime>): Runtime =>
  ({
    idleSuppressOn: true,
    idleMs: 1000,
    snoozeDefaultMs: 7777,
    rejectLimit: 3,
    ...over,
  }) as Runtime

/**
 * Deny until the rail trips, or give up. Returns the denial it tripped on.
 *
 * Drives the REAL counter through the REAL resolved threshold, so this is a
 * behavioural arm and not a restatement of the pure function above it.
 */
const denialsUntilExit = (rt: Runtime, cap = 50): number | "never" => {
  const counter = createRejectCounter({ threshold: resolveIdleGuardLimits(rt).rejectThreshold })
  for (let i = 1; i <= cap; i++) {
    counter.recordDeny()
    if (counter.shouldAutoExit()) return i
  }
  return "never"
}

describe("idle guards — the approval rail is independent of idle presence", () => {
  test("ANTI-VACUITY: the rail trips at its configured limit in the normal posture", () => {
    expect(denialsUntilExit(runtime({}))).toBe(3)
    expect(resolveIdleGuardLimits(runtime({})).rejectThreshold).toBe(3)
  })

  test("QUANTA_IDLE_SUPPRESS=0 does NOT disarm the rejection rail", () => {
    const limits = resolveIdleGuardLimits(runtime({ idleSuppressOn: false }))
    expect(
      limits.rejectThreshold,
      "idle presence tracking is off, which says nothing about tool-approval denials",
    ).toBe(3)
    expect(denialsUntilExit(runtime({ idleSuppressOn: false }))).toBe(3)
  })

  test("QUANTA_REJECT_LIMIT=0 remains the documented way to disable it", () => {
    for (const on of [true, false]) {
      const l = resolveIdleGuardLimits(runtime({ idleSuppressOn: on, rejectLimit: 0 }))
      expect(l.rejectThreshold).toBe(Number.POSITIVE_INFINITY)
      expect(denialsUntilExit(runtime({ idleSuppressOn: on, rejectLimit: 0 }))).toBe("never")
    }
  })

  test("a non-finite limit also disables it, both postures", () => {
    for (const on of [true, false]) {
      const l = resolveIdleGuardLimits(runtime({ idleSuppressOn: on, rejectLimit: Number.NaN }))
      expect(l.rejectThreshold).toBe(Number.POSITIVE_INFINITY)
    }
  })

  /** PAIRED CONTROL: the idle fields SHOULD still follow `idleSuppressOn`, or this
   *  file would pass by decoupling everything. */
  test("the idle monitor still follows idleSuppressOn — the coupling is not removed wholesale", () => {
    expect(resolveIdleGuardLimits(runtime({ idleSuppressOn: true })).idleThresholdMs).toBe(1000)
    expect(resolveIdleGuardLimits(runtime({ idleSuppressOn: false })).idleThresholdMs).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(resolveIdleGuardLimits(runtime({ idleSuppressOn: true })).defaultSnoozeMs).toBe(7777)
    expect(resolveIdleGuardLimits(runtime({ idleSuppressOn: false })).defaultSnoozeMs).toBe(300_000)
  })
})
