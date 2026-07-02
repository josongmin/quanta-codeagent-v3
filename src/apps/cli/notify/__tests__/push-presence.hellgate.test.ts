/** B5 (jul-03) hellgate — presence gate wired into the OSC adapter. A PRESENT
 *  user (injected `isUserPresent() === true`, i.e. `!idle.isIdle()`) suppresses
 *  the OSC/BEL write on turn-complete AND idle-awaiting-input; an ABSENT user
 *  emits it. Default (no `isUserPresent` injected) ⇒ byte-identical to legacy.
 *  Uses the buffer write-sink + presence toggle — zero real terminal I/O. */

import { describe, expect, test } from "bun:test"
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
