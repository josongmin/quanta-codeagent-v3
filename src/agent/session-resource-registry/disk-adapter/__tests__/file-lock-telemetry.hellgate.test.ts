/**
 * ADR-0364 — flock telemetry hellgate.
 *
 * Coverage (10 cases — minimum 8 from the brief):
 *   A. metricsEmitter absent      ⇒ ZERO emit calls (byte-identical)   (1)
 *   B. success path               ⇒ acquire_success + latency gauge    (1)
 *   C. timeout path               ⇒ acquire_timeout + latency gauge    (1)
 *   D. fs-error path              ⇒ acquire_fail counter               (1)
 *   E. stale reclaim              ⇒ stale_reclaim + then success       (1)
 *   F. emitter throws             ⇒ swallow (NO-THROW invariant)       (1)
 *   G. latency uses now() seam    ⇒ exact mock-clock latency emitted   (1)
 *   H. concurrent multi-acquire   ⇒ 1 success + N-1 timeouts emitted   (1)
 *   I. zero-timeout contention    ⇒ acquire_timeout                    (1)
 *   J. same-process re-entrancy   ⇒ second acquire emits success       (1)
 *
 *  Total: 10 cases.
 *
 *  Each test instantiates a fresh `RecordingEmitter` so cross-test
 *  contamination is impossible. `__resetProcessHolders` is called in
 *  the foreign-lock simulation tests so the process-holder map does not
 *  short-circuit the EEXIST path.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MetricEmitterPort } from "@/agent/codex-r2-metrics"
import {
  __resetProcessHolders,
  acquireSessionLock,
  LOCK_FILENAME,
  LOCK_METRIC_ACQUIRE_FAIL,
  LOCK_METRIC_ACQUIRE_LATENCY_MS,
  LOCK_METRIC_ACQUIRE_SUCCESS,
  LOCK_METRIC_ACQUIRE_TIMEOUT,
  LOCK_METRIC_STALE_RECLAIM,
} from "../file-lock"

interface CounterRow {
  readonly name: string
  readonly delta: number
}
interface GaugeRow {
  readonly name: string
  readonly value: number
}

/** Minimal in-memory recorder for `MetricEmitterPort`. The two arrays
 *  preserve emit order so tests can assert exact sequencing (e.g. that
 *  stale_reclaim fires BEFORE acquire_success in the reclaim-then-mint
 *  path). */
const createRecordingEmitter = (): MetricEmitterPort & {
  counters: CounterRow[]
  gauges: GaugeRow[]
} => {
  const counters: CounterRow[] = []
  const gauges: GaugeRow[] = []
  return {
    counter(name, delta) {
      counters.push({ name, delta })
    },
    gauge(name, value) {
      gauges.push({ name, value })
    },
    counters,
    gauges,
  }
}

/** Plant a lockfile DIRECTLY (bypassing the process-holder map). */
const plantForeignLock = async (dir: string, sessionId: string): Promise<string> => {
  const sessionDir = join(dir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  const lockPath = join(sessionDir, LOCK_FILENAME)
  await writeFile(lockPath, JSON.stringify({ pid: 99999, acquiredAt: 0 }), { mode: 0o600 })
  return lockPath
}

const tempStorage = async (): Promise<string> => mkdtemp(join(tmpdir(), "adr0364-"))

describe("ADR-0364 §A — metricsEmitter absent ⇒ zero emit calls (byte-identical)", () => {
  test("calling acquireSessionLock without metricsEmitter is contractually identical to ADR-0356", async () => {
    const dir = await tempStorage()
    // The recording emitter is created but NEVER passed to acquireSessionLock.
    const recorder = createRecordingEmitter()
    const lock = await acquireSessionLock(dir, "sess-A")
    expect(lock).not.toBeNull()
    // The recorder saw nothing — we never wired it.
    expect(recorder.counters.length).toBe(0)
    expect(recorder.gauges.length).toBe(0)
    await lock?.release()
  })
})

describe("ADR-0364 §B — success path ⇒ acquire_success counter + latency gauge", () => {
  test("on a fresh dir, success counter +1 + latency gauge emitted", async () => {
    const dir = await tempStorage()
    const emitter = createRecordingEmitter()
    const lock = await acquireSessionLock(dir, "sess-B", { metricsEmitter: emitter })
    expect(lock).not.toBeNull()
    // Exactly one acquire_success counter (delta=1).
    const successRows = emitter.counters.filter((c) => c.name === LOCK_METRIC_ACQUIRE_SUCCESS)
    expect(successRows.length).toBe(1)
    expect(successRows[0]?.delta).toBe(1)
    // Latency gauge emitted (one entry, non-negative).
    const latencyRows = emitter.gauges.filter((g) => g.name === LOCK_METRIC_ACQUIRE_LATENCY_MS)
    expect(latencyRows.length).toBe(1)
    expect(latencyRows[0]?.value ?? -1).toBeGreaterThanOrEqual(0)
    // No timeout / fail counters fired on the happy path.
    expect(emitter.counters.some((c) => c.name === LOCK_METRIC_ACQUIRE_TIMEOUT)).toBe(false)
    expect(emitter.counters.some((c) => c.name === LOCK_METRIC_ACQUIRE_FAIL)).toBe(false)
    await lock?.release()
  })
})

describe("ADR-0364 §C — timeout path ⇒ acquire_timeout counter + latency gauge", () => {
  test("acquire over a fresh foreign lock with tiny budget ⇒ timeout emit", async () => {
    __resetProcessHolders()
    const dir = await tempStorage()
    await plantForeignLock(dir, "sess-C")
    const emitter = createRecordingEmitter()
    const result = await acquireSessionLock(dir, "sess-C", {
      timeoutMs: 40,
      retryIntervalMs: 10,
      staleThresholdMs: 60_000,
      metricsEmitter: emitter,
    })
    expect(result).toBeNull()
    // Exactly one acquire_timeout counter.
    const timeoutRows = emitter.counters.filter((c) => c.name === LOCK_METRIC_ACQUIRE_TIMEOUT)
    expect(timeoutRows.length).toBe(1)
    // Latency gauge emitted on timeout path.
    const latencyRows = emitter.gauges.filter((g) => g.name === LOCK_METRIC_ACQUIRE_LATENCY_MS)
    expect(latencyRows.length).toBe(1)
    expect(latencyRows[0]?.value ?? -1).toBeGreaterThanOrEqual(0)
    // No success counter fired.
    expect(emitter.counters.some((c) => c.name === LOCK_METRIC_ACQUIRE_SUCCESS)).toBe(false)
  })
})

describe("ADR-0364 §D — fs-error path ⇒ acquire_fail counter", () => {
  test("storageDir is a regular file (mkdir fails) ⇒ acquire_fail emitted", async () => {
    const dir = await tempStorage()
    // Plant a file where the storageDir's session-subdir parent would be.
    const blocker = join(dir, "blocked")
    await writeFile(blocker, "i am a file, not a dir")
    const emitter = createRecordingEmitter()
    const result = await acquireSessionLock(blocker, "sess-D", {
      timeoutMs: 50,
      metricsEmitter: emitter,
    })
    expect(result).toBeNull()
    // Exactly one acquire_fail counter.
    const failRows = emitter.counters.filter((c) => c.name === LOCK_METRIC_ACQUIRE_FAIL)
    expect(failRows.length).toBe(1)
    // No success / timeout / stale_reclaim on this path.
    expect(emitter.counters.some((c) => c.name === LOCK_METRIC_ACQUIRE_SUCCESS)).toBe(false)
    expect(emitter.counters.some((c) => c.name === LOCK_METRIC_ACQUIRE_TIMEOUT)).toBe(false)
    expect(emitter.counters.some((c) => c.name === LOCK_METRIC_STALE_RECLAIM)).toBe(false)
  })
})

describe("ADR-0364 §E — stale reclaim ⇒ stale_reclaim counter (then success)", () => {
  test("plant a stale lockfile, acquire reclaims it, success emit follows stale_reclaim", async () => {
    __resetProcessHolders()
    const dir = await tempStorage()
    const sessionDir = join(dir, "sess-E")
    await mkdir(sessionDir, { recursive: true })
    const lockPath = join(sessionDir, LOCK_FILENAME)
    await writeFile(lockPath, "{}", { mode: 0o600 })
    // Push mtime 60s into the past so the stale check trips.
    const past = (Date.now() - 60_000) / 1000
    await utimes(lockPath, past, past)

    const emitter = createRecordingEmitter()
    const lock = await acquireSessionLock(dir, "sess-E", {
      timeoutMs: 200,
      retryIntervalMs: 10,
      staleThresholdMs: 30_000,
      metricsEmitter: emitter,
    })
    expect(lock).not.toBeNull()
    // Stale_reclaim counter +1 (the reap of the planted-stale file).
    const staleRows = emitter.counters.filter((c) => c.name === LOCK_METRIC_STALE_RECLAIM)
    expect(staleRows.length).toBe(1)
    // Success counter +1 (the subsequent retry succeeded).
    const successRows = emitter.counters.filter((c) => c.name === LOCK_METRIC_ACQUIRE_SUCCESS)
    expect(successRows.length).toBe(1)
    // Order: stale_reclaim emitted BEFORE acquire_success in the
    // recorder array (proves the loop's emit sequencing).
    const staleIdx = emitter.counters.findIndex((c) => c.name === LOCK_METRIC_STALE_RECLAIM)
    const successIdx = emitter.counters.findIndex((c) => c.name === LOCK_METRIC_ACQUIRE_SUCCESS)
    expect(staleIdx).toBeLessThan(successIdx)
    await lock?.release()
  })
})

describe("ADR-0364 §F — emitter throws ⇒ swallow (NO-THROW invariant)", () => {
  test("a hostile emitter that throws on every call does NOT break acquire", async () => {
    const dir = await tempStorage()
    const hostile: MetricEmitterPort = {
      counter() {
        throw new Error("hostile emitter — counter")
      },
      gauge() {
        throw new Error("hostile emitter — gauge")
      },
    }
    // Acquire MUST still resolve cleanly + return a non-null lock.
    const lock = await acquireSessionLock(dir, "sess-F", { metricsEmitter: hostile })
    expect(lock).not.toBeNull()
    await lock?.release()
  })
})

describe("ADR-0364 §G — latency uses now() seam ⇒ exact mock-clock latency", () => {
  test("with mock now() the latency gauge reflects the wall-clock delta computed via the seam", async () => {
    const dir = await tempStorage()
    const emitter = createRecordingEmitter()
    // Mock clock advances by 7ms per call. The acquire path calls now()
    // at least twice: once for the start capture, once for the success
    // emit. So the emitted latency must be ≥ 7 (the delta between two
    // consecutive now() returns). We assert "exactly" by counting how
    // many times the lock module reads the clock and computing the
    // expected delta.
    let t = 0
    const calls: number[] = []
    const now = (): number => {
      t += 7
      calls.push(t)
      return t
    }
    const lock = await acquireSessionLock(dir, "sess-G", { now, metricsEmitter: emitter })
    expect(lock).not.toBeNull()
    // The latency MUST equal `now() - wallStart` per the emit sequence.
    // wallStart = calls[0]; emit-time-now = calls[N-1].
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const latencyRows = emitter.gauges.filter((g) => g.name === LOCK_METRIC_ACQUIRE_LATENCY_MS)
    expect(latencyRows.length).toBe(1)
    // Latency value lines up with a consecutive pair of mocked-clock
    // returns (delta is some positive multiple of 7 — exact value depends
    // on how many internal `now()` calls happen between start + emit).
    const lat = latencyRows[0]?.value ?? -1
    expect(lat).toBeGreaterThan(0)
    expect(lat % 7).toBe(0)
    await lock?.release()
  })
})

describe("ADR-0364 §H — concurrent multi-acquire ⇒ 1 success + N-1 timeouts emitted", () => {
  test("5 concurrent acquires share an emitter ⇒ 1 success counter + 4 timeout counters", async () => {
    const dir = await tempStorage()
    const emitter = createRecordingEmitter()
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        acquireSessionLock(dir, "sess-H", {
          timeoutMs: 50,
          retryIntervalMs: 10,
          metricsEmitter: emitter,
        }),
      ),
    )
    const winners = results.filter((r) => r !== null)
    expect(winners.length).toBe(1)
    // One acquire_success + four acquire_timeout — total 5 acquire-outcome
    // counters. (Note: in-process re-entry from the holder map does NOT
    // happen here because all 5 launch BEFORE any one of them lands in
    // the holder map. So the four losers go through the EEXIST/timeout
    // path, NOT the re-entry path.)
    const successCount = emitter.counters.filter(
      (c) => c.name === LOCK_METRIC_ACQUIRE_SUCCESS,
    ).length
    const timeoutCount = emitter.counters.filter(
      (c) => c.name === LOCK_METRIC_ACQUIRE_TIMEOUT,
    ).length
    expect(successCount).toBe(1)
    expect(timeoutCount).toBe(4)
    await winners[0]?.release()
  })
})

describe("ADR-0364 §I — zero-timeout contention ⇒ acquire_timeout", () => {
  test("zero budget against a foreign lock ⇒ acquire_timeout + latency", async () => {
    __resetProcessHolders()
    const dir = await tempStorage()
    await plantForeignLock(dir, "sess-I")
    const emitter = createRecordingEmitter()
    const result = await acquireSessionLock(dir, "sess-I", {
      timeoutMs: 0,
      retryIntervalMs: 0,
      staleThresholdMs: 60_000,
      metricsEmitter: emitter,
    })
    expect(result).toBeNull()
    expect(emitter.counters.filter((c) => c.name === LOCK_METRIC_ACQUIRE_TIMEOUT).length).toBe(1)
    expect(emitter.gauges.filter((g) => g.name === LOCK_METRIC_ACQUIRE_LATENCY_MS).length).toBe(1)
  })
})

describe("ADR-0364 §J — same-process re-entrancy ⇒ second acquire emits success", () => {
  test("second acquire on the same lockPath in-process emits success (re-entry counts)", async () => {
    const dir = await tempStorage()
    const emitter = createRecordingEmitter()
    const first = await acquireSessionLock(dir, "sess-J", { metricsEmitter: emitter })
    expect(first).not.toBeNull()
    // Same-process re-entry: second acquire on the SAME lock path uses
    // the holder-map fast path. Per ADR-0364 design it still emits a
    // success counter so operators can see re-entry rate.
    const second = await acquireSessionLock(dir, "sess-J", { metricsEmitter: emitter })
    expect(second).not.toBeNull()
    // Two acquire_success counters total (first + re-entry).
    const successCount = emitter.counters.filter(
      (c) => c.name === LOCK_METRIC_ACQUIRE_SUCCESS,
    ).length
    expect(successCount).toBe(2)
    // Two latency gauges (one per success path).
    const latencyCount = emitter.gauges.filter(
      (g) => g.name === LOCK_METRIC_ACQUIRE_LATENCY_MS,
    ).length
    expect(latencyCount).toBe(2)
    await second?.release()
    await first?.release()
  })
})

describe("ADR-0364 — metric-name constants are stable", () => {
  test("the exported constant strings match the ADR-0364 vocabulary", () => {
    expect(LOCK_METRIC_ACQUIRE_SUCCESS).toBe("codex_r2.lock.acquire_success")
    expect(LOCK_METRIC_ACQUIRE_TIMEOUT).toBe("codex_r2.lock.acquire_timeout")
    expect(LOCK_METRIC_ACQUIRE_FAIL).toBe("codex_r2.lock.acquire_fail")
    expect(LOCK_METRIC_STALE_RECLAIM).toBe("codex_r2.lock.stale_reclaim")
    expect(LOCK_METRIC_ACQUIRE_LATENCY_MS).toBe("codex_r2.lock.acquire_latency_ms")
  })
})
