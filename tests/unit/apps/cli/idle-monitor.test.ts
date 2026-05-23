import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createIdleMonitor, parseSnoozeDuration } from "../../../../src/apps/cli/idle-monitor"

const mkClock = (initial: number): { now: () => number; advance: (ms: number) => void } => {
  let t = initial
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms
    },
  }
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "quanta-idle-"))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("idle-monitor", () => {
  test("isIdle=false immediately after construction", () => {
    const clock = mkClock(1_000_000)
    const idle = createIdleMonitor({ now: clock.now, loadSnoozeFromDisk: false })
    expect(idle.isIdle()).toBe(false)
    expect(idle.isSnoozed()).toBe(false)
  })

  test("markActive updates the last-active timestamp", () => {
    const clock = mkClock(1_000_000)
    const idle = createIdleMonitor({
      now: clock.now,
      idleThresholdMs: 60_000,
      loadSnoozeFromDisk: false,
    })
    clock.advance(59_999)
    expect(idle.isIdle()).toBe(false)
    idle.markActive()
    clock.advance(59_999)
    expect(idle.isIdle()).toBe(false)
    clock.advance(1)
    expect(idle.isIdle()).toBe(true)
  })

  test("60s threshold (Cursor §4.2 default) becomes idle after exact threshold", () => {
    const clock = mkClock(0)
    const idle = createIdleMonitor({ now: clock.now, loadSnoozeFromDisk: false })
    clock.advance(59_999)
    expect(idle.isIdle()).toBe(false)
    clock.advance(1)
    expect(idle.isIdle()).toBe(true)
  })

  test("snooze 5min default activates and decays after the window", () => {
    const clock = mkClock(0)
    const idle = createIdleMonitor({
      now: clock.now,
      defaultSnoozeMs: 300_000,
      snoozeFile: join(tmp, "snooze"),
    })
    expect(idle.isSnoozed()).toBe(false)
    idle.snooze()
    expect(idle.isSnoozed()).toBe(true)
    clock.advance(299_999)
    expect(idle.isSnoozed()).toBe(true)
    clock.advance(1)
    expect(idle.isSnoozed()).toBe(false)
  })

  test("snooze persists to disk + re-load picks up an active record", () => {
    const path = join(tmp, "snooze")
    const clock = mkClock(1_000_000)
    const a = createIdleMonitor({ now: clock.now, snoozeFile: path })
    a.snooze(600_000)
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, "utf8")
    expect(raw).toContain("snoozedUntil")

    // A fresh monitor at the same clock time re-loads the active snooze.
    const b = createIdleMonitor({ now: clock.now, snoozeFile: path })
    expect(b.isSnoozed()).toBe(true)
    clock.advance(600_001)
    expect(b.isSnoozed()).toBe(false)
  })

  test("ephemeral mode (loadSnoozeFromDisk=false) ignores the disk record", () => {
    const path = join(tmp, "snooze")
    const clock = mkClock(0)
    const a = createIdleMonitor({ now: clock.now, snoozeFile: path })
    a.snooze(60_000)
    const b = createIdleMonitor({ now: clock.now, snoozeFile: path, loadSnoozeFromDisk: false })
    expect(b.isSnoozed()).toBe(false)
  })

  test("unsnooze clears state and disk record", () => {
    const path = join(tmp, "snooze")
    const clock = mkClock(0)
    const idle = createIdleMonitor({ now: clock.now, snoozeFile: path })
    idle.snooze(60_000)
    expect(idle.isSnoozed()).toBe(true)
    idle.unsnooze()
    expect(idle.isSnoozed()).toBe(false)
    // Disk record cleared to `{}` — reload of a fresh monitor sees no snooze.
    const b = createIdleMonitor({ now: clock.now, snoozeFile: path })
    expect(b.isSnoozed()).toBe(false)
  })

  test("disk write to an unwritable path falls back silently (in-memory still works)", () => {
    const clock = mkClock(0)
    // /dev/null/foo can't be created → write throws → graceful fallback.
    const idle = createIdleMonitor({
      now: clock.now,
      snoozeFile: "/dev/null/forbidden/snooze",
      loadSnoozeFromDisk: false,
    })
    idle.snooze(60_000)
    expect(idle.isSnoozed()).toBe(true) // in-memory state holds
  })

  test("Infinity / 0 / negative threshold disables idle detection", () => {
    const clock = mkClock(0)
    const a = createIdleMonitor({
      now: clock.now,
      idleThresholdMs: Number.POSITIVE_INFINITY,
      loadSnoozeFromDisk: false,
    })
    clock.advance(10_000_000)
    expect(a.isIdle()).toBe(false)

    const b = createIdleMonitor({
      now: clock.now,
      idleThresholdMs: 0,
      loadSnoozeFromDisk: false,
    })
    clock.advance(1)
    expect(b.isIdle()).toBe(false)
  })

  test("reset clears in-memory state but not the disk record", () => {
    const path = join(tmp, "snooze")
    const clock = mkClock(0)
    const idle = createIdleMonitor({ now: clock.now, snoozeFile: path })
    idle.snooze(60_000)
    idle.reset()
    expect(idle.isSnoozed()).toBe(false)
    // Disk record still present — a fresh monitor reloads it.
    const b = createIdleMonitor({ now: clock.now, snoozeFile: path })
    expect(b.isSnoozed()).toBe(true)
  })

  test("snooze with non-positive duration is rejected (no state change)", () => {
    const clock = mkClock(0)
    const idle = createIdleMonitor({ now: clock.now, loadSnoozeFromDisk: false })
    idle.snooze(0)
    expect(idle.isSnoozed()).toBe(false)
    idle.snooze(-1)
    expect(idle.isSnoozed()).toBe(false)
    idle.snooze(Number.POSITIVE_INFINITY)
    expect(idle.isSnoozed()).toBe(false)
  })
})

describe("parseSnoozeDuration", () => {
  test("accepts 30s / 5m / 1h / bare ms", () => {
    expect(parseSnoozeDuration("30s")).toBe(30_000)
    expect(parseSnoozeDuration("5m")).toBe(300_000)
    expect(parseSnoozeDuration("1h")).toBe(3_600_000)
    expect(parseSnoozeDuration("1500")).toBe(1_500)
    expect(parseSnoozeDuration("1500ms")).toBe(1_500)
  })

  test("rejects malformed / zero / negative tokens", () => {
    expect(parseSnoozeDuration("")).toBeNull()
    expect(parseSnoozeDuration("abc")).toBeNull()
    expect(parseSnoozeDuration("5d")).toBeNull()
    expect(parseSnoozeDuration("0")).toBeNull()
    expect(parseSnoozeDuration("-5m")).toBeNull()
    expect(parseSnoozeDuration("5m ago")).toBeNull()
  })
})
