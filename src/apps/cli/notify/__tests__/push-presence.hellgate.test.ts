/** B5 (jul-03) hellgate — presence gate wired into the OSC adapter. A PRESENT
 *  user (injected `isUserPresent() === true`, i.e. `!idle.isIdle()`) suppresses
 *  the OSC/BEL write on turn-complete AND idle-awaiting-input; an ABSENT user
 *  emits it. Default (no `isUserPresent` injected) ⇒ byte-identical to legacy.
 *  Uses the buffer write-sink + presence toggle — zero real terminal I/O. */

import { describe, expect, test } from "bun:test"
import { createIdleMonitor } from "../../idle-monitor"
import { createOscNotificationPort } from "../osc-adapter"

const BEL = "\x07"
const ESC = "\x1b"
const osc = (title: string): string => `${ESC}]0;${title}${BEL}`

const makeSink = (): { out: string[]; write: (s: string) => void } => {
  const out: string[] = []
  return { out, write: (s) => out.push(s) }
}

describe("B5 — presence gate on onTurnComplete", () => {
  test("PRESENT user suppresses the done OSC (no write)", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 0,
      isUserPresent: () => true, // !idle.isIdle() — user typed recently
    })
    port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([])
  })

  test("ABSENT user (idle) emits the done OSC exactly as legacy", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 0,
      isUserPresent: () => false, // idle.isIdle() === true
    })
    port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([osc("✓ proj — done")])
  })

  test("presence is re-read per event (toggle mid-session)", () => {
    const { out, write } = makeSink()
    let present = true
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 0,
      isUserPresent: () => present,
    })
    port.onTurnComplete({ durationMs: 1, ok: true, cwdBasename: "p" }) // present ⇒ suppressed
    expect(out).toEqual([])
    present = false // user went idle
    port.onTurnComplete({ durationMs: 1, ok: true, cwdBasename: "p" }) // absent ⇒ emit
    expect(out).toEqual([osc("✓ p — done")])
  })

  test("PRESENT user also suppresses idle-awaiting-input notify + BEL", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "bell",
      isUserPresent: () => true,
    })
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    expect(out).toEqual([])
  })

  // HOLE (audit): the commit claims "idle-latch is NOT consumed on presence
  // suppression — the push still fires if the user goes idle before the next
  // markActive". This is a stated behavioral invariant with NO test. A bug that
  // consumes the latch under presence would silently DROP the idle-awaiting push
  // even after the user walks away — the exact failure B5 exists to prevent.
  test("idle-awaiting latch is NOT consumed by presence suppression (walk-away still fires)", () => {
    const { out, write } = makeSink()
    let present = true
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      isUserPresent: () => present,
    })
    // Present at the moment of idle entry ⇒ suppressed, latch MUST stay open.
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    expect(out).toEqual([])
    // User walks away WITHOUT any intervening markActive (no new turn).
    present = false
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    // The push must now fire (latch was never consumed by the suppression).
    expect(out).toEqual([osc("… p — waiting")])
    // And it is latched THEREAFTER (a genuine second emit is anti-spammed).
    port.onIdleAwaitingInput({ cwdBasename: "p" })
    expect(out).toEqual([osc("… p — waiting")])
  })

  // HOLE (audit item 5): throw-safety of the probe. The port accepts an
  // arbitrary injected isUserPresent; the loop call sites (prompt-pipeline /
  // turn-helpers) have NO try/catch. A throwing probe must NOT crash the notify
  // event — fail-closed toward NOTIFYING (a notification beats a crash; matches
  // the always-notify default). Assert both events survive AND emit.
  test("a THROWING presence probe does not crash onTurnComplete (fail-open ⇒ emits)", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 0,
      isUserPresent: () => {
        throw new Error("probe blew up")
      },
    })
    expect(() =>
      port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" }),
    ).not.toThrow()
    expect(out).toEqual([osc("✓ proj — done")])
    // A crashed probe is not a presence suppression — do not count it as one.
    expect(port.getPushStats?.()).toEqual({ sent: 1, suppressedUserPresent: 0 })
  })

  test("a THROWING presence probe does not crash onIdleAwaitingInput (fail-open ⇒ emits)", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "bell",
      isUserPresent: () => {
        throw new Error("probe blew up")
      },
    })
    expect(() => port.onIdleAwaitingInput({ cwdBasename: "p" })).not.toThrow()
    expect(out).toEqual([osc("… p — waiting"), BEL])
  })
})

describe("B5 — default-OFF byte-identical (no isUserPresent injected)", () => {
  test("no presence dep ⇒ legacy always-notify behavior preserved", () => {
    const { out, write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 0,
    })
    port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([osc("✓ proj — done")])
  })
})

describe("B5 — getPushStats accounting", () => {
  test("counts sent vs suppressed-by-presence (measurable suppression)", () => {
    const { write } = makeSink()
    let present = true
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 0,
      isUserPresent: () => present,
    })
    port.onTurnComplete({ durationMs: 1, ok: true, cwdBasename: "p" }) // suppressed (present)
    present = false
    port.onTurnComplete({ durationMs: 1, ok: true, cwdBasename: "p" }) // sent (absent)
    port.onIdleAwaitingInput({ cwdBasename: "p" }) // sent (absent)
    const stats = port.getPushStats?.()
    expect(stats).toEqual({ sent: 2, suppressedUserPresent: 1 })
  })

  test("fast-turn anti-spam suppression is NOT counted as presence suppression", () => {
    const { write } = makeSink()
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 10_000,
      isUserPresent: () => false, // absent — presence never suppresses
    })
    port.onTurnComplete({ durationMs: 5, ok: true, cwdBasename: "p" }) // fast ⇒ silent (not presence)
    const stats = port.getPushStats?.()
    expect(stats).toEqual({ sent: 0, suppressedUserPresent: 0 })
  })

  test("no getPushStats without a presence dep is fine (optional)", () => {
    const { write } = makeSink()
    const port = createOscNotificationPort({ write, channel: "title_only" })
    // Optional method — legacy callers never touch it. Present-but-zero is OK.
    const stats = port.getPushStats?.()
    expect(stats).toEqual({ sent: 0, suppressedUserPresent: 0 })
  })
})

// Audit item 4: presence semantics must reuse the REAL IdleMonitor SSOT (no
// invented threshold). The wiring-level tests inject a raw boolean, which does
// NOT prove `present === !idle.isIdle()` against the QUANTA_IDLE_MS window. Bind
// the ACTUAL createIdleMonitor exactly as repl.ts does and drive a controlled
// clock across the threshold boundary: activity within the window ⇒ present ⇒
// suppress; a genuinely-away user (past the threshold) ⇒ absent ⇒ notify.
describe("B5 — presence bound to the real IdleMonitor SSOT (QUANTA_IDLE_MS window)", () => {
  test("present (activity within threshold) suppresses; away (>threshold) notifies", () => {
    let clock = 1_000_000
    const idle = createIdleMonitor({
      idleThresholdMs: 60_000, // QUANTA_IDLE_MS default (Cursor §4.2)
      now: () => clock,
      loadSnoozeFromDisk: false,
    })
    const { out, write } = makeSink()
    // repl.ts SSOT binding — no parallel focus tracker.
    const port = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 0,
      isUserPresent: () => !idle.isIdle(),
    })

    // t=0: user just typed (constructor markActive) ⇒ present ⇒ push suppressed.
    port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([])
    expect(port.getPushStats?.()).toEqual({ sent: 0, suppressedUserPresent: 1 })

    // Still within the 60s window (59s) ⇒ still present ⇒ still suppressed.
    clock += 59_000
    port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([])

    // Cross the threshold: 61s of no activity ⇒ genuinely away ⇒ MUST notify.
    clock += 2_000 // total 61s since last markActive
    port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([osc("✓ proj — done")])
    expect(port.getPushStats?.()).toEqual({ sent: 1, suppressedUserPresent: 2 })

    // Fresh activity (markActive) ⇒ present again ⇒ suppressed again.
    idle.markActive()
    port.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([osc("✓ proj — done")]) // unchanged
    expect(port.getPushStats?.()).toEqual({ sent: 1, suppressedUserPresent: 3 })
  })
})
