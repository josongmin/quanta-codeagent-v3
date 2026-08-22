/** B5 (jul-03) hellgate — composition-root WIRING of the presence gate.
 *  Proves: (1) with `QUANTA_NOTIFY_PRESENCE` opted in, a PRESENT user
 *  (`idle.isIdle() === false` ⇒ `isUserPresent() === true`) suppresses the OSC
 *  write; an IDLE user emits it. (2) With the gate UNSET (default), the presence
 *  probe is NOT attached ⇒ byte-identical always-notify even for a present user.
 *
 *  The factory reads `process.env` + `process.stdout.isTTY` and writes to the
 *  real stdout, so we stub the write sink + TTY around each case (restored in
 *  finally) and drive the built port directly via its slow-turn gate. */

import { afterEach, describe, expect, test } from "bun:test"
import { buildNotifyAndContextWarning } from "../notify-and-warning"

const BEL = "\x07"
const ESC = "\x1b"
const osc = (title: string): string => `${ESC}]0;${title}${BEL}`

const savedEnv = { ...process.env }
const realWrite = process.stdout.write.bind(process.stdout)
const realIsTTY = process.stdout.isTTY

afterEach(() => {
  process.env = { ...savedEnv }
  process.stdout.write = realWrite as typeof process.stdout.write
  Object.defineProperty(process.stdout, "isTTY", { value: realIsTTY, configurable: true })
})

/** Build the notify port under a controlled env + captured stdout sink. */
const buildWithCapture = (args: {
  env: Record<string, string>
  present: boolean
}): { out: string[]; notify: ReturnType<typeof buildNotifyAndContextWarning>["notify"] } => {
  const out: string[] = []
  process.env = { ...args.env }
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  process.stdout.write = ((s: string) => {
    out.push(s)
    return true
  }) as typeof process.stdout.write
  const bundle = buildNotifyAndContextWarning({
    cwd: "/tmp/proj",
    contextUsageView: () => undefined,
    // idle.isIdle() === !present ⇒ isUserPresent() === present
    isUserPresent: () => args.present,
  })
  return { out, notify: bundle.notify }
}

describe("B5 — presence gate wiring at the factory", () => {
  test("gate ON + present user ⇒ turn-complete OSC suppressed", () => {
    const { out, notify } = buildWithCapture({
      env: { QUANTA_NOTIFY: "title_only", QUANTA_NOTIFY_PRESENCE: "1" },
      present: true,
    })
    notify?.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([])
    expect(notify?.getPushStats?.()).toEqual({ sent: 0, suppressedUserPresent: 1 })
  })

  test("gate ON + idle user ⇒ turn-complete OSC emitted", () => {
    const { out, notify } = buildWithCapture({
      env: { QUANTA_NOTIFY: "title_only", QUANTA_NOTIFY_PRESENCE: "1" },
      present: false,
    })
    notify?.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([osc("✓ proj — done")])
    expect(notify?.getPushStats?.()).toEqual({ sent: 1, suppressedUserPresent: 0 })
  })

  test("gate UNSET (default-OFF) ⇒ present user STILL notified (byte-identical legacy)", () => {
    const { out, notify } = buildWithCapture({
      env: { QUANTA_NOTIFY: "title_only" }, // no QUANTA_NOTIFY_PRESENCE
      present: true,
    })
    notify?.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([osc("✓ proj — done")])
    // No presence probe attached ⇒ nothing ever counted as presence-suppressed.
    expect(notify?.getPushStats?.()).toEqual({ sent: 1, suppressedUserPresent: 0 })
  })

  test("gate falsy (=0) ⇒ present user STILL notified (no silent inversion)", () => {
    const { out, notify } = buildWithCapture({
      env: { QUANTA_NOTIFY: "title_only", QUANTA_NOTIFY_PRESENCE: "0" },
      present: true,
    })
    notify?.onTurnComplete({ durationMs: 15_000, ok: true, cwdBasename: "proj" })
    expect(out).toEqual([osc("✓ proj — done")])
  })
})
