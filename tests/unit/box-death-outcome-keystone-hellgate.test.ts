/**
 * BOX-DEATH OUTCOME KEYSTONE (regression guard, jun-24).
 *
 * RCA: `gradeChunkOnBox`'s terminal `finally` once wrapped a co-occurring
 * grade-lock-release failure AROUND the primary grade error. On a dead box BOTH
 * fail (the lock cannot be released on an unreachable host), so the wrapper
 * SWALLOWED the primary box-death signal (ssh-255 / connect-timed-out). The pool's
 * box-death classifier then saw a generic "grade lock cleanup failed" instead of a
 * requeue-able box death — turning a recoverable death into a HARD pool abort and
 * masking ~60 downstream failures.
 *
 * The decision now lives in the pure {@link resolveChunkOutcome}. This guard pins
 * the full outcome matrix with red-on-injection teeth: flip the keystone branch
 * back to `throw cleanupErr` (or wrap the primary) and the "both errors" case turns
 * RED. The end-to-end requeue path is covered by
 * `bench-detached-poll-box-death-hellgate`; this is the focused unit fence.
 */
import { describe, expect, test } from "bun:test"
import { resolveChunkOutcome } from "@/apps/bench/remote/box-session"

const BOX_DEATH = new Error("ssh: connect timed out (255)")
const CLEANUP_FAIL = new Error("grade lock release failed")
const RESULT = { resolved: 3 } as const
const FALLBACK = {} as const

describe("resolveChunkOutcome — box-death keystone", () => {
  test("KEYSTONE: primary box-death AND cleanup failure ⇒ the PRIMARY (box-death) error propagates", () => {
    // The exact dead-box shape: both the grade and the lock-release fail.
    let thrown: unknown
    try {
      resolveChunkOutcome(BOX_DEATH, CLEANUP_FAIL, undefined, FALLBACK)
    } catch (e) {
      thrown = e
    }
    // Must be the BOX-DEATH error by identity — the signal the pool requeues on —
    // NOT the cleanup error and NOT a wrapper.
    expect(thrown).toBe(BOX_DEATH)
    expect(thrown).not.toBe(CLEANUP_FAIL)
  })

  test("primary error only (clean lock release) ⇒ primary propagates", () => {
    expect(() => resolveChunkOutcome(BOX_DEATH, undefined, undefined, FALLBACK)).toThrow(BOX_DEATH)
  })

  test("cleanup failure only (clean grade, stuck lock) ⇒ cleanup surfaces — not swallowed", () => {
    let thrown: unknown
    try {
      resolveChunkOutcome(undefined, CLEANUP_FAIL, RESULT, FALLBACK)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBe(CLEANUP_FAIL)
  })

  test("no errors ⇒ returns the result by reference", () => {
    expect(resolveChunkOutcome(undefined, undefined, RESULT, FALLBACK)).toBe(RESULT)
  })

  test("no errors and no result ⇒ returns the fallback (never undefined)", () => {
    expect(resolveChunkOutcome(undefined, undefined, undefined, FALLBACK)).toBe(FALLBACK)
  })
})
