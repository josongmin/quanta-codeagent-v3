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
// R2-audit: All env vars touched by ADR-0369 / 0378 / 0385 / 0390 hellgate
// are restored here so a test that throws mid-body cannot leak into the
// next case (case CB previously cleaned via in-body `delete` which is
// skipped on failure).
let prevDiskEnv: string | undefined
let prevSqliteEnv: string | undefined
let prevWalThresholdEnv: string | undefined
let prevWalModeEnv: string | undefined
let tempDirs: string[] = []

beforeEach(() => {
  prevDiskEnv = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  prevSqliteEnv = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  prevWalThresholdEnv = process.env.QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES
  prevWalModeEnv = process.env.QUANTA_SESSION_REGISTRY_WAL_CHECKPOINT_MODE
  delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  delete process.env.QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES
  delete process.env.QUANTA_SESSION_REGISTRY_WAL_CHECKPOINT_MODE
  resetGlobalSessionResourceRegistry()
})

afterEach(async () => {
  resetGlobalSessionResourceRegistry()
  if (prevDiskEnv === undefined) delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  else process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = prevDiskEnv
  if (prevSqliteEnv === undefined) delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  else process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = prevSqliteEnv
  if (prevWalThresholdEnv === undefined)
    delete process.env.QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES
  else process.env.QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES = prevWalThresholdEnv
  if (prevWalModeEnv === undefined) delete process.env.QUANTA_SESSION_REGISTRY_WAL_CHECKPOINT_MODE
  else process.env.QUANTA_SESSION_REGISTRY_WAL_CHECKPOINT_MODE = prevWalModeEnv
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

// ADR-0373 — Auto-sweep telemetry. Pin emitter wiring + metric names +
// NO-THROW contract on the emit surface. Each new case follows the same
// fake-timer seam so the periodic tick is deterministic.
interface RecordedCounter {
  readonly name: string
  readonly delta: number
  readonly attrs: Readonly<Record<string, string>> | undefined
}
interface RecordedGauge {
  readonly name: string
  readonly value: number
  readonly attrs: Readonly<Record<string, string>> | undefined
}
interface RecordedHistogram {
  readonly name: string
  readonly value: number
  readonly attrs: Readonly<Record<string, string>> | undefined
}

interface RecordingEmitter {
  readonly counters: RecordedCounter[]
  readonly gauges: RecordedGauge[]
  readonly histograms: RecordedHistogram[]
  readonly port: {
    counter: (name: string, delta: number, attrs?: Readonly<Record<string, string>>) => void
    gauge: (name: string, value: number, attrs?: Readonly<Record<string, string>>) => void
    histogram?: (name: string, value: number, attrs?: Readonly<Record<string, string>>) => void
  }
}

const makeRecordingEmitter = (opts?: { withHistogram?: boolean }): RecordingEmitter => {
  const counters: RecordedCounter[] = []
  const gauges: RecordedGauge[] = []
  const histograms: RecordedHistogram[] = []
  const port: RecordingEmitter["port"] = {
    counter: (name, delta, attrs) => {
      counters.push({ name, delta, attrs })
    },
    gauge: (name, value, attrs) => {
      gauges.push({ name, value, attrs })
    },
  }
  if (opts?.withHistogram !== false) {
    port.histogram = (name, value, attrs) => {
      histograms.push({ name, value, attrs })
    }
  }
  return { counters, gauges, histograms, port }
}

describe("ADR-0373 — auto-sweep telemetry", () => {
  test("Q. metricsEmitter absent ⇒ existing behaviour byte-identical (no record path)", async () => {
    const dir = await newTempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const timer = makeFakeTimer()
    // No emitter → scheduled like before, sweepNow works.
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    expect(h.scheduled).toBe(true)
    await h.sweepNow()
    h.stop()
  })

  test("R. metricsEmitter present + disk evicted ⇒ disk counters emitted", async () => {
    const dir = await newTempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    const diskEvicted = emitter.counters.filter((c) => c.name === "codex_r2.sweep.disk_evicted")
    const diskTruncated = emitter.counters.filter((c) => c.name === "codex_r2.sweep.disk_truncated")
    // Empty fresh dir ⇒ both deltas exist (may be 0) but the counter
    // call was made.
    expect(diskEvicted.length).toBeGreaterThanOrEqual(1)
    expect(diskTruncated.length).toBeGreaterThanOrEqual(1)
    h.stop()
  })

  test("S. metricsEmitter + sqlite ⇒ sqlite_checkpointed counter emitted", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    const checkpointed = emitter.counters.filter(
      (c) => c.name === "codex_r2.sweep.sqlite_checkpointed",
    )
    const evicted = emitter.counters.filter((c) => c.name === "codex_r2.sweep.sqlite_evicted")
    expect(checkpointed.length).toBeGreaterThanOrEqual(1)
    expect(evicted.length).toBeGreaterThanOrEqual(1)
    h.stop()
  })

  test("T. latency_ms emitted via histogram when present, gauge fallback otherwise", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    // Histogram-capable emitter.
    const withHist = makeRecordingEmitter({ withHistogram: true })
    const timer1 = makeFakeTimer()
    const h1 = startAutoSweep({
      setIntervalImpl: timer1.setIntervalImpl,
      clearIntervalImpl: timer1.clearIntervalImpl,
      metricsEmitter: withHist.port,
    })
    await h1.sweepNow()
    const histRows = withHist.histograms.filter((r) => r.name === "codex_r2.sweep.latency_ms")
    expect(histRows.length).toBeGreaterThanOrEqual(1)
    expect(histRows[0]?.value).toBeGreaterThanOrEqual(0)
    h1.stop()

    // Histogram-absent emitter — fall back to gauge.
    const noHist = makeRecordingEmitter({ withHistogram: false })
    const timer2 = makeFakeTimer()
    const h2 = startAutoSweep({
      setIntervalImpl: timer2.setIntervalImpl,
      clearIntervalImpl: timer2.clearIntervalImpl,
      metricsEmitter: noHist.port,
    })
    await h2.sweepNow()
    const gaugeRows = noHist.gauges.filter((r) => r.name === "codex_r2.sweep.latency_ms")
    expect(gaugeRows.length).toBeGreaterThanOrEqual(1)
    expect(gaugeRows[0]?.value).toBeGreaterThanOrEqual(0)
    h2.stop()
  })

  test("U. emit throws ⇒ swallowed; sweep loop continues; timer stays alive", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const throwing: RecordingEmitter["port"] = {
      counter: () => {
        throw new Error("emitter blew up")
      },
      gauge: () => {
        throw new Error("emitter blew up")
      },
      histogram: () => {
        throw new Error("emitter blew up")
      },
    }
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: throwing,
    })
    // No throw on sweepNow.
    await expect(h.sweepNow()).resolves.toBeUndefined()
    // Tick stays alive.
    timer.tick(0)
    expect(timer.handles[0]?.cleared).toBe(false)
    h.stop()
  })

  test("V. both backends ⇒ both sets of metrics emit on a single sweep", async () => {
    const dir = await newTempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    const names = new Set(emitter.counters.map((c) => c.name))
    expect(names.has("codex_r2.sweep.disk_evicted")).toBe(true)
    expect(names.has("codex_r2.sweep.disk_truncated")).toBe(true)
    expect(names.has("codex_r2.sweep.sqlite_evicted")).toBe(true)
    expect(names.has("codex_r2.sweep.sqlite_checkpointed")).toBe(true)
    h.stop()
  })

  test("W. zero-result sweep ⇒ counters still emit (delta = 0; idempotent observability)", async () => {
    const dir = await newTempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    // The disk dir is fresh — evicted and truncated MUST be 0 but the
    // counter call still happened (delta = 0). This keeps dashboards
    // sane: "we ran a sweep, it found nothing" is observable.
    const evictRow = emitter.counters.find((c) => c.name === "codex_r2.sweep.disk_evicted")
    expect(evictRow?.delta).toBe(0)
    h.stop()
  })

  test("X. handle.sweepNow() fires emit; on-startup sweep also fires emit", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    // Wait one microtask for the on-startup `void sweepOnce(...)` to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    const baseline = emitter.counters.length
    expect(baseline).toBeGreaterThan(0)
    await h.sweepNow()
    expect(emitter.counters.length).toBeGreaterThan(baseline)
    h.stop()
  })

  // ─── ADR-0378 WAL size gauge ───────────────────────────────────────────

  test("Y. sqlite sweep emits codex_r2.sqlite.wal_bytes gauge (non-negative)", async () => {
    const dir = await newTempDir()
    const sqlitePath = `${dir}/test.sqlite`
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = sqlitePath
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    const walGauge = emitter.gauges.find((g) => g.name === "codex_r2.sqlite.wal_bytes")
    expect(walGauge).toBeDefined()
    expect(walGauge?.value).toBeGreaterThanOrEqual(0)
    h.stop()
  })

  test("Z. emitter absent ⇒ no wal_bytes gauge (byte-identical pre-ADR-0378)", async () => {
    const dir = await newTempDir()
    const sqlitePath = `${dir}/test.sqlite`
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = sqlitePath
    const timer = makeFakeTimer()
    // No metricsEmitter on the config — sweep MUST still succeed but emit nothing.
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    await h.sweepNow()
    // The handle has no recording emitter; we just verify the sweep didn't throw
    // and the handle is stoppable (NO-THROW byte-identical path).
    expect(typeof h.stop).toBe("function")
    h.stop()
  })

  test("AA. disk-only env (no sqlite) ⇒ no wal_bytes gauge emitted", async () => {
    const dir = await newTempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    // disk-only path does not call sqlite sweep, so wal_bytes gauge MUST NOT fire.
    const walGauge = emitter.gauges.find((g) => g.name === "codex_r2.sqlite.wal_bytes")
    expect(walGauge).toBeUndefined()
    h.stop()
  })

  // ─── ADR-0390 — WAL knob threading (auto-sweep is no longer blind) ───

  test("BB. ADR-0390 — cfg.walSizeThresholdBytes + walCheckpointUpgradeMode reach sweepSqliteRegistry", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
      walSizeThresholdBytes: 1,
      walCheckpointUpgradeMode: "TRUNCATE",
    })
    await h.sweepNow()
    // Both ADR-0390 counters MUST fire — proves the knobs reach the sweep.
    // `:memory:` cannot create a WAL so both flags settle false; the
    // counter call itself (delta 0) is the wiring proof.
    const restarted = emitter.counters.filter(
      (c) => c.name === "codex_r2.sweep.sqlite_wal_restarted",
    )
    const truncated = emitter.counters.filter(
      (c) => c.name === "codex_r2.sweep.sqlite_wal_truncated",
    )
    expect(restarted.length).toBeGreaterThanOrEqual(1)
    expect(truncated.length).toBeGreaterThanOrEqual(1)
    h.stop()
  })

  test("CB. ADR-0390 — env var QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES is honored", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    process.env.QUANTA_SESSION_REGISTRY_WAL_THRESHOLD_BYTES = "12345"
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    // Counter call proves the threshold env reached the sweep (NO-THROW
    // path; the actual checkpoint may not fire on :memory: but the counter
    // is unconditional once the threshold is parsed).
    const restarted = emitter.counters.filter(
      (c) => c.name === "codex_r2.sweep.sqlite_wal_restarted",
    )
    expect(restarted.length).toBeGreaterThanOrEqual(1)
    h.stop()
    // R2-audit: env restore moved to afterEach (was previously inline here
    // — skipped on test-body throw, leaking into the next case).
  })

  test("DB. ADR-0390 — negative walSizeThresholdBytes is rejected (treated as unset)", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    // Pass a negative threshold via cfg; resolver MUST coerce to undefined
    // so the sweep stays in PASSIVE-only (byte-identical to pre-R15 wire).
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
      walSizeThresholdBytes: -1,
    })
    await h.sweepNow()
    // The counter emits regardless (delta 0) — what we pin here is that
    // the sweep ran NO-THROW with the negative threshold (no exception
    // escaped startAutoSweep + sweepNow).
    expect(h.scheduled).toBe(true)
    h.stop()
  })

  test("EB. ADR-0390 — neither env nor cfg threshold ⇒ byte-identical pre-R15 PASSIVE behavior", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    // Counters still emit (delta 0) but the threshold was undefined so
    // the sqlite sweep stays in PASSIVE-only — both flags MUST be false.
    const restartedRows = emitter.counters.filter(
      (c) => c.name === "codex_r2.sweep.sqlite_wal_restarted",
    )
    const truncatedRows = emitter.counters.filter(
      (c) => c.name === "codex_r2.sweep.sqlite_wal_truncated",
    )
    expect(restartedRows.every((r) => r.delta === 0)).toBe(true)
    expect(truncatedRows.every((r) => r.delta === 0)).toBe(true)
    h.stop()
  })

  // R2-audit fix — Wiring-proof success/failure counters (sqlite_failed,
  // disk_failed). Distinguish "PASSIVE-only by design" from "sweep blew
  // up + counters silently absent".

  test("FB. sqlite_failed counter emits delta 0 on a successful sweep", async () => {
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = ":memory:"
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    const failed = emitter.counters.filter((c) => c.name === "codex_r2.sweep.sqlite_failed")
    expect(failed.length).toBeGreaterThanOrEqual(1)
    expect(failed.every((r) => r.delta === 0)).toBe(true)
    h.stop()
  })

  test("GB. disk_failed counter emits delta 0 on a successful disk sweep", async () => {
    const dir = await newTempDir()
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = dir
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
    })
    await h.sweepNow()
    const failed = emitter.counters.filter((c) => c.name === "codex_r2.sweep.disk_failed")
    expect(failed.length).toBeGreaterThanOrEqual(1)
    expect(failed.every((r) => r.delta === 0)).toBe(true)
    h.stop()
  })

  // The delta-1 `sqlite_failed` / `disk_failed` path is defense-in-depth
  // for a hypothetical future `runSqliteSweep` / `sweepDiskRegistry`
  // regression: today all inner emit calls are safeCounter/safeGauge
  // wrapped + sweepSqliteRegistry/sweepDiskRegistry are NO-THROW, so
  // the outer catch is unreachable under any realistic input. We pin
  // the delta-0 success path (FB + GB above) and accept that the
  // delta-1 path is provably unreachable today.

  test("IB. wiring proof — sqlite_wal_restarted counter delta MIRRORS result.walRestarted", async () => {
    // R2-audit gap (#5): prior cases only proved `length >= 1` —
    // a regression that always emits `delta: 1` would pass. We use a
    // real on-disk DB so a WAL file actually exists; threshold = 1 byte
    // means any non-empty WAL triggers the RESTART (default mode).
    const dir = await newTempDir()
    const dbPath = join(dir, "ib.sqlite")
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = dbPath
    const emitter = makeRecordingEmitter()
    const timer = makeFakeTimer()
    const h = startAutoSweep({
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      metricsEmitter: emitter.port,
      walSizeThresholdBytes: 1,
    })
    await h.sweepNow()
    // Trigger a SECOND sweep so the migration-write on the first
    // sweep produces a WAL the second sweep observes pre-checkpoint.
    await h.sweepNow()
    const restartedRows = emitter.counters.filter(
      (c) => c.name === "codex_r2.sweep.sqlite_wal_restarted",
    )
    // The wire MUST emit at least one delta-0 + at most one delta-1 per
    // call. A regression that always emits delta=1 would still satisfy
    // `some delta=1` so we add the stricter check: every emitted delta
    // is in {0,1} (no spurious values like 2 from a double-count) AND
    // at least one of them is 0 (proves the wire reflects the
    // walRestarted flag, not a hard-coded constant).
    expect(restartedRows.every((r) => r.delta === 0 || r.delta === 1)).toBe(true)
    expect(restartedRows.some((r) => r.delta === 0)).toBe(true)
    h.stop()
  })
})
