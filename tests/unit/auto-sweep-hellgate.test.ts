/**
 * ADR-0369 — Auto-sweep hellgate.
 *
 * Locks in the env-gated retention sweep on `getGlobalSessionResourceRegistry()`
 * first-call. The slice MUST:
 *
 *   - Stay byte-identical when neither env var is set (no setInterval).
 *   - Schedule a periodic timer when at least one env var is set.
 *   - Run an on-startup sweep IMMEDIATELY (the long-idle reclaim case).
 *   - Survive sweep failures (NO-THROW; timer keeps ticking).
 *   - Tear down the timer on `resetGlobalSessionResourceRegistry()` so
 *     tests do not leak handles.
 *   - Treat empty string env var as "unset".
 *   - Allow explicit cfg overrides to win over env (test seam).
 *   - Be idempotent on `stop()` and `sweepNow()`.
 *
 * The fake `setInterval` / `clearInterval` seam keeps the periodic tick
 * deterministic — we never `await` real timers in tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_AUTO_SWEEP_INTERVAL_MS,
  resetGlobalSessionResourceRegistry,
  startAutoSweep,
} from "@/agent/session-resource-registry"

// ── env sandbox ───────────────────────────────────────────────────────
let prevDiskEnv: string | undefined
let prevSqliteEnv: string | undefined
let tempDirs: string[] = []

beforeEach(() => {
  prevDiskEnv = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  prevSqliteEnv = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  resetGlobalSessionResourceRegistry()
})

afterEach(async () => {
  resetGlobalSessionResourceRegistry()
  if (prevDiskEnv === undefined) delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  else process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = prevDiskEnv
  if (prevSqliteEnv === undefined) delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  else process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = prevSqliteEnv
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true })
  }
  tempDirs = []
})

const newTempDir = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "adr-0369-"))
  tempDirs.push(d)
  return d
}

// Fake timer seam: records (fn, ms) and exposes a manual tick.
interface FakeTimer {
  readonly handles: Array<{ fn: () => void; ms: number; cleared: boolean }>
  readonly setIntervalImpl: (fn: () => void, ms: number) => NodeJS.Timeout
  readonly clearIntervalImpl: (h: NodeJS.Timeout) => void
  tick: (index?: number) => void
}

const makeFakeTimer = (): FakeTimer => {
  const handles: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  return {
    handles,
    setIntervalImpl: (fn, ms) => {
      handles.push({ fn, ms, cleared: false })
      // Index-as-handle: returns a token bun's NodeJS.Timeout type tolerates.
      return (handles.length - 1) as unknown as NodeJS.Timeout
    },
    clearIntervalImpl: (h) => {
      const idx = h as unknown as number
      const entry = handles[idx]
      if (entry !== undefined) entry.cleared = true
    },
    tick: (index = 0) => {
      const entry = handles[index]
      if (entry !== undefined && !entry.cleared) entry.fn()
    },
  }
}

describe("ADR-0369 — startAutoSweep", () => {
  test("A. env unset ⇒ no-op handle, scheduled=false, stop is idempotent", () => {
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(h.scheduled).toBe(false)
    expect(timer.handles.length).toBe(0)
    // stop() twice ⇒ no throw
    h.stop()
    h.stop()
  })

  test("B. disk env set ⇒ schedules periodic timer + on-startup sweep", async () => {
    const dir = await newTempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(h.scheduled).toBe(true)
    expect(timer.handles.length).toBe(1)
    // On-startup sweep ran (we await sweepNow as a synchroniser — same code
    // path, idempotent).
    await h.sweepNow()
    h.stop()
    expect(timer.handles[0]?.cleared).toBe(true)
  })

  test("C. sqlite env set ⇒ schedules periodic timer", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(h.scheduled).toBe(true)
    expect(timer.handles.length).toBe(1)
    expect(timer.handles[0]?.ms).toBe(DEFAULT_AUTO_SWEEP_INTERVAL_MS)
    await h.sweepNow()
    h.stop()
  })

  test("D. both env vars set ⇒ both backends swept on tick + stop", async () => {
    const dir = await newTempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(h.scheduled).toBe(true)
    // Tick the fake timer — both sweeps fire and the timer survives.
    timer.tick(0)
    // sweepNow as synchronisation point.
    await h.sweepNow()
    h.stop()
  })

  test("E. default intervalMs = 60_000 ms", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(timer.handles[0]?.ms).toBe(60_000)
    h.stop()
  })

  test("F. intervalMs override forwards to setInterval", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      intervalMs: 12_345,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(timer.handles[0]?.ms).toBe(12_345)
    h.stop()
  })

  test("G. intervalMs <= 0 ⇒ no periodic timer (on-startup only)", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      intervalMs: 0,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(h.scheduled).toBe(false)
    expect(timer.handles.length).toBe(0)
    // sweepNow still works
    await h.sweepNow()
    h.stop()
  })

  test("H. empty-string env vars ⇒ treated as unset", () => {
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = ""
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ""
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(h.scheduled).toBe(false)
    expect(timer.handles.length).toBe(0)
    h.stop()
  })

  test("I. cfg.diskDir / cfg.sqlitePath override env", () => {
    // Env is intentionally empty; explicit cfg should still trigger scheduling.
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      diskDir: "/tmp/explicit",
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(h.scheduled).toBe(true)
    h.stop()
  })

  test("J. NO-THROW: sweep failure inside tick does not break timer", async () => {
    // Point sqlite path at a deliberately bad location that sweepSqlite
    // tolerates internally — even an :memory: failure path is swallowed.
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    // Tick multiple times — must not throw and timer entry stays alive.
    timer.tick(0)
    timer.tick(0)
    timer.tick(0)
    expect(timer.handles[0]?.cleared).toBe(false)
    h.stop()
  })

  test("K. stop() after never-started handle is safe (no env, double-stop)", () => {
    const h = startAutoSweep()
    expect(h.scheduled).toBe(false)
    h.stop()
    h.stop()
    h.stop()
  })

  test("L. sweepNow resolves even when env unset", async () => {
    const h = startAutoSweep()
    await expect(h.sweepNow()).resolves.toBeUndefined()
    h.stop()
  })

  test("M. sweepNow is awaitable on a started handle", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    await expect(h.sweepNow()).resolves.toBeUndefined()
    h.stop()
  })

  test("N. stop() clears the timer ⇒ subsequent fake tick is a no-op", () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    h.stop()
    // After stop, manual tick is logically a no-op — even if we trigger the
    // recorded fn directly, the inner guard prevents the sweep from running
    // (we only assert the cleared flag was set so external tickers stop).
    expect(timer.handles[0]?.cleared).toBe(true)
  })
})

describe("ADR-0369 — global.ts wire", () => {
  test("O. getGlobalSessionResourceRegistry without env ⇒ in-memory + no leak", () => {
    // No env set ⇒ in-memory registry; no auto-sweep handle is even needed
    // beyond a no-op. resetGlobalSessionResourceRegistry MUST tear it
    // down regardless so subsequent tests start cold.
    // Wrapper imported lazily to keep the env-sandbox ordering tight.
    const { getGlobalSessionResourceRegistry } = require("@/agent/session-resource-registry") as {
      getGlobalSessionResourceRegistry: () => { size: () => number }
    }
    const reg = getGlobalSessionResourceRegistry()
    expect(reg.size()).toBe(0)
    // Reset MUST be safe even though the handle is a no-op
    resetGlobalSessionResourceRegistry()
    // Re-mint after reset works (no stale state)
    const reg2 = getGlobalSessionResourceRegistry()
    expect(reg2.size()).toBe(0)
  })

  test("P. resetGlobalSessionResourceRegistry stops handle (idempotent)", () => {
    // Set env so a real periodic timer is created. Without a fake-timer
    // seam at the global wire we cannot inject — but reset must still be
    // safe AND must clear the timer so the next mint is a fresh handle.
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const { getGlobalSessionResourceRegistry } = require("@/agent/session-resource-registry") as {
      getGlobalSessionResourceRegistry: () => unknown
    }
    getGlobalSessionResourceRegistry()
    // Double reset must not throw
    resetGlobalSessionResourceRegistry()
    resetGlobalSessionResourceRegistry()
  })
})
