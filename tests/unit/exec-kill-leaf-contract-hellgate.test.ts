/**
 * OWNER-LOCAL LEAF-UNIT hellgate — `src/subagent/exec-kill.ts` :: `legacyKillHandle`.
 *
 * This suite is the LEAF contract for the makeKill-absent single-pid fallback,
 * complementing (NOT duplicating) `subagent-exec-tree-kill-hellgate` §3, which
 * already pins: a single kill() ⇒ one proc.kill(), disarm() is a no-op, and
 * kill() swallows a throwing proc.kill (already-dead pid).
 *
 * NET-NEW gaps pinned here — each asserts a structural property of the CURRENT
 * source (`kill: () => { try { proc.kill() } catch {} }`, `disarm: () => {}`)
 * that a plausible future refactor could silently break:
 *
 *   §A  kill() IDEMPOTENCY — the source holds NO "already killed" latch, so a
 *       second kill() delivers a second, legitimate SIGTERM. Pinned so that if
 *       legacy grows a suppress-second-kill guard, this test RED (see comment).
 *   §B  disarm() MULTI-CALL safety — repeated disarm(), and disarm() after
 *       kill(), stay a no-op and never throw.
 *   §C  kill()→disarm() ORDERING — disarm after a kill is safe; the legacy
 *       handle has no timer, so this is trivially true — pinned so a refactor
 *       that adds a timer to legacy MUST update this.
 *   §D  NO grace timer armed by legacy — proven via the observable proxy: kill()
 *       calls proc.kill() with NO signal argument, exactly once per kill(), and
 *       disarm() is genuinely empty (the escalating SIGKILL timer is the
 *       tree-killer's job, not legacy's).
 */

import { describe, expect, test } from "bun:test"
import type { Subprocess } from "bun"
import { legacyKillHandle } from "../../src/subagent/exec-kill"

/** Minimal Subprocess-shaped fake — only `.kill` is exercised. Records every
 *  signal passed so we can assert arity AND the (absent) signal argument. */
const fakeProc = (onKill: (sig?: unknown) => void): Subprocess<"pipe", "pipe", "pipe"> =>
  ({ pid: 1234, kill: onKill, exited: Promise.resolve(0) }) as unknown as Subprocess<
    "pipe",
    "pipe",
    "pipe"
  >

describe("exec-kill leaf — legacyKillHandle owner-local contract", () => {
  // §A — kill() idempotency. RED-ON-INJECTION: if legacy ever grows an
  // `if (killed) return` latch (or memoizes the first kill), the SECOND
  // proc.kill() below never fires and `calls.length` stays 1 ⇒ this RED.
  test("§A kill() twice ⇒ proc.kill() twice, no throw, no latch suppressing the 2nd SIGTERM", () => {
    const calls: Array<unknown> = []
    const h = legacyKillHandle(fakeProc((sig) => calls.push(sig)))
    expect(() => {
      h.kill()
      h.kill()
    }).not.toThrow()
    expect(calls.length).toBe(2)
  })

  // §B — disarm() multi-call safety, including after kill().
  test("§B disarm() repeated (and after kill()) stays a no-op and never throws", () => {
    let kills = 0
    const h = legacyKillHandle(fakeProc(() => (kills += 1)))
    expect(() => {
      h.disarm()
      h.disarm()
      h.kill()
      h.disarm()
      h.disarm()
    }).not.toThrow()
    // disarm never touches proc.kill; only the single kill() above signaled.
    expect(kills).toBe(1)
  })

  // §C — kill() then disarm() ordering is safe. Legacy has no timer, so disarm
  // after kill is trivially safe; pinned so a refactor adding a timer to legacy
  // MUST update this (a throwing/latched disarm after kill would RED here).
  test("§C kill() then disarm() ordering is safe (no timer ⇒ disarm trivially safe)", () => {
    const calls: Array<unknown> = []
    const h = legacyKillHandle(fakeProc((sig) => calls.push(sig)))
    expect(() => {
      h.kill()
      h.disarm()
    }).not.toThrow()
    expect(calls.length).toBe(1)
  })

  // §D — no grace timer armed by legacy. Observable proxy: kill() calls
  // proc.kill() with NO signal argument (default SIGTERM), exactly once per
  // kill(), and disarm() does nothing. If legacy started arming an escalating
  // SIGKILL (a second delayed proc.kill("SIGKILL")), `sigs` would carry a
  // "SIGKILL" and/or length would exceed the kill() count ⇒ this RED.
  test("§D legacy arms NO escalating SIGKILL: kill() ⇒ exactly one proc.kill() with no signal arg; disarm empty", () => {
    const sigs: Array<unknown> = []
    const h = legacyKillHandle(fakeProc((sig) => sigs.push(sig)))
    h.kill()
    expect(sigs).toEqual([undefined]) // no signal argument passed
    h.disarm()
    expect(sigs).toEqual([undefined]) // disarm arms/fires nothing
  })

  // Paired-control NON-VACUOUS positive: proves the fake + assertions can
  // observe a real signal, so none of the "no extra kill" assertions above
  // pass merely because proc.kill is never wired.
  test("paired control — kill() DOES signal (non-vacuous witness)", () => {
    let signaled = false
    const h = legacyKillHandle(fakeProc(() => (signaled = true)))
    expect(signaled).toBe(false)
    h.kill()
    expect(signaled).toBe(true)
  })
})
