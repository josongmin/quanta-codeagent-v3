/**
 * ★ HELLGATE — a campaign may only signal a process group it can PROVE is its
 * own, and "the `ps` that would have proved it failed" is not a proof.
 *
 * MEASURED DEFECT (2026-09-12): `leaderIdentity(pgid)` returned
 * `string | undefined` and folded two opposite facts into `undefined` —
 *
 *   - the leader has EXITED  → safe to kill (anything left is our descendant)
 *   - `ps` could not be read → no evidence at all
 *
 * — while `killTracked` short-circuited on `current !== undefined && recorded
 * !== undefined`. So whenever `ps` was unavailable (a wedged probe, a box at
 * load 100, no `ps` on PATH), the pid-recycle guard was entirely OFF and a
 * `kill(-pgid, SIGKILL)` could land on a stranger's process tree. The same hole
 * opened if `ps` merely failed at SPAWN time, hours before the kill.
 *
 * These cases use a REAL detached `/bin/sleep` worker (cheap: no bun startup)
 * with the OBSERVER injected, and the signal sink both records and FORWARDS to
 * the kernel — so "zero signals" is checked twice: against the recorded sink
 * and against the child still being alive afterwards.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { closeSync, openSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  createProcessObserver,
  isRunningState,
  type LeaderIdentity,
  type ProcessObserver,
  type ProcessSnapshot,
} from "../../tools/dev/process-observer"
import { ShardProcessRegistry, type ShardWorkerHandle } from "../../tools/dev/test-shard-lifecycle"

type ObserverMode = "real" | "unavailable" | "recycled"

/**
 * Ground truth, straight from the kernel — and deliberately NOT
 * `process.kill(pid, 0)`, which answers YES for a zombie. A killed child is a
 * `<defunct>` table entry until it is reaped, so "the signal landed" and "the
 * pid still exists" are both true at the same instant.
 */
const pidRunning = (pid: number): boolean => {
  const snapshot = createProcessObserver().snapshot()
  if (snapshot.kind !== "ok") throw new Error(`ps unavailable: ${snapshot.reason}`)
  return snapshot.rows.some((row) => row.pid === pid && isRunningState(row.stat))
}

const leaked: number[] = []
const openFds: number[] = []

afterEach(() => {
  // No case may leak a sleep into the host, even when it fails early.
  for (const pid of leaked.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // already gone — the expected case for the paired control
    }
  }
  for (const fd of openFds.splice(0)) {
    try {
      closeSync(fd)
    } catch {
      // best effort
    }
  }
})

const devNull = (): number => {
  const fd = openSync("/dev/null", "w")
  openFds.push(fd)
  return fd
}

interface Harness {
  readonly registry: ShardProcessRegistry
  readonly signals: string[]
  setMode(mode: ObserverMode): void
  setRecycledPid(pid: number): void
  observerCalls(): number
}

/**
 * A registry whose view of the process table is scripted, but whose spawning,
 * signalling and group membership are entirely real.
 */
const harness = (mode: ObserverMode): Harness => {
  const real = createProcessObserver()
  const signals: string[] = []
  let current = mode
  let recycledPid = -1
  let calls = 0
  const observer: ProcessObserver = {
    snapshot(): ProcessSnapshot {
      calls += 1
      if (current === "unavailable") {
        return { kind: "unavailable", reason: "timeout", detail: "injected: ps never returned" }
      }
      const snapshot = real.snapshot()
      if (current !== "recycled" || snapshot.kind !== "ok") return snapshot
      // The OS handed our pgid to somebody else: same number, different leader.
      return {
        kind: "ok",
        rows: snapshot.rows.map((row) =>
          row.pid === recycledPid
            ? { ...row, comm: "/usr/bin/someone-elses-daemon", started: "Thu Jan 1 00:00:00 1970" }
            : row,
        ),
      }
    },
    // Spawn-time identity takes the targeted path, so the injected mode has to
    // govern BOTH reads or a case could silently record a real identity while
    // believing it recorded none.
    identity(pid: number): LeaderIdentity {
      calls += 1
      if (current === "unavailable") {
        return { kind: "unknown", reason: "timeout", detail: "injected: ps never returned" }
      }
      return real.identity(pid)
    },
    get calls(): number {
      return calls
    },
  }
  const registry = new ShardProcessRegistry({
    termGraceMs: 1_500,
    killGraceMs: 3_000,
    pollMs: 20,
    maxPollMs: 200,
    deps: {
      observer,
      signal: (pgid: number, signal: NodeJS.Signals) => {
        signals.push(`${pgid}:${signal}`)
        try {
          process.kill(-pgid, signal)
        } catch {
          // group already gone
        }
      },
    },
  })
  return {
    registry,
    signals,
    setMode: (next) => {
      current = next
    },
    setRecycledPid: (pid) => {
      recycledPid = pid
    },
    observerCalls: () => calls,
  }
}

const spawnSleeper = (h: Harness): ShardWorkerHandle => {
  const handle = h.registry.spawnWorker({
    cmd: ["sleep", "120"],
    cwd: tmpdir(),
    env: process.env,
    stdoutFd: devNull(),
    stderrFd: devNull(),
  })
  // A spawn failure would reject; nothing else awaits it in these cases.
  handle.exited.catch(() => undefined)
  expect(handle.pid).toBeGreaterThan(1)
  leaked.push(handle.pid)
  return handle
}

describe("shard registry — identity-unsafe groups are abandoned, never signalled", () => {
  test("PAIRED CONTROL — a group whose identity still matches IS killed", async () => {
    // Without this the 'zero signals' cases below would pass against a harness
    // that simply cannot kill anything.
    const h = harness("real")
    const handle = spawnSleeper(h)
    const pid = handle.pid
    expect(pidRunning(pid)).toBe(true)

    const outcome = await h.registry.cancelAll()

    expect(h.signals[0]).toBe(`${pid}:SIGTERM`)
    expect((await handle.exited).signal).toBe("SIGTERM")
    expect(pidRunning(pid)).toBe(false)
    expect(outcome.drained).toBe(true)
    expect(outcome.abandoned).toEqual([])
    expect(outcome.survivors).toEqual([])
  }, 20_000)

  test("★ `ps` unavailable at KILL time → ZERO signals, drained false, reported unverified", async () => {
    const h = harness("real")
    const pid = spawnSleeper(h).pid
    // Identity was recorded fine at spawn; the table goes dark at kill time.
    h.setMode("unavailable")

    const outcome = await h.registry.cancelAll()

    expect(h.signals).toEqual([])
    expect(pidRunning(pid)).toBe(true) // ground truth: nothing was signalled
    expect(outcome.drained).toBe(false)
    expect(outcome.survivors).toEqual([pid])
    expect(outcome.abandoned).toEqual([
      { pgid: pid, reason: "unverified", detail: "identity unreadable at kill time (timeout)" },
    ])
  }, 20_000)

  test("★ identity unknown at SPAWN + a live stranger at kill time → ZERO signals", async () => {
    // The subtler half: `ps` failed when the worker started, so there is no
    // recorded identity to compare the live leader against. The old code read
    // that missing record as "leader exited — safe to kill".
    const h = harness("unavailable")
    const pid = spawnSleeper(h).pid
    h.setMode("real")

    const outcome = await h.registry.cancelAll()

    expect(h.signals).toEqual([])
    expect(pidRunning(pid)).toBe(true)
    expect(outcome.drained).toBe(false)
    expect(outcome.abandoned).toEqual([
      { pgid: pid, reason: "unverified", detail: "identity unreadable at spawn time (timeout)" },
    ])
  }, 20_000)

  test("★ a CONFIRMED different leader (pid recycle) → ZERO signals, abandoned as recycled", async () => {
    const h = harness("real")
    const pid = spawnSleeper(h).pid
    h.setRecycledPid(pid)
    h.setMode("recycled")

    const outcome = await h.registry.cancelAll()

    expect(h.signals).toEqual([])
    expect(pidRunning(pid)).toBe(true)
    expect(outcome.drained).toBe(false)
    expect(outcome.abandoned).toHaveLength(1)
    expect(outcome.abandoned[0]?.reason).toBe("recycled")
    expect(outcome.abandoned[0]?.detail).toContain("someone-elses-daemon")
    expect(outcome.survivors).toEqual([pid])
  }, 20_000)

  test("a drain that cannot be observed does not cost a poll per 50ms", async () => {
    // The budget, measured through the registry rather than the raw loop: an
    // unreadable table for the whole TERM+KILL window must stay cheap.
    const h = harness("real")
    spawnSleeper(h)
    h.setMode("unavailable")
    const before = h.observerCalls()

    await h.registry.cancelAll()

    // sweep + identity read, and NO kill-poll at all, because an unverified
    // group is never signalled and therefore never waited on.
    const spent = h.observerCalls() - before
    expect(spent).toBeGreaterThan(0) // ANTI-VACUUM FLOOR: it did look
    expect(spent).toBeLessThanOrEqual(6)
  }, 20_000)
})
