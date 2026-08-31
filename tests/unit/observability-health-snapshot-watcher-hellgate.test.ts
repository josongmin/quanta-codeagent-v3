/**
 * ADR-0187 hellgate — periodic re-emit + SIGHUP hot-reload watcher around
 * ADR-0180's health-snapshot file. ADR-0180 writes once at construction;
 * this round adds interval, signal, and manual re-emit.
 *
 * 14-case coverage:
 *   A. Interval-based emit (3 cases)
 *   B. SIGHUP-driven emit (3 cases)
 *   C. emitNow contract (3 cases)
 *   D. stop semantics (2 cases)
 *   E. Fresh bag every tick (1 case)
 *   F. Preserved build opts + overlap serialization (2 cases)
 *
 * SOTA reference (cited in ADR-0187):
 *   - systemd `notify` socket — file-based health update on heartbeat.
 *   - Kubernetes livenessProbe `periodSeconds: 30` — default-interval choice.
 *   - Cursor 3-tier drift defense (event + interval + handshake) — multi-channel
 *     refresh layering; never trust one channel.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HealthSnapshot } from "@/observability/metrics/health-snapshot"
import { startHealthSnapshotWatcher } from "@/observability/metrics/health-snapshot-watcher"
import type { ObservabilityBag } from "@/observability/metrics/observability-helper"

/* ────────────────────────────────────────────────────────────────────────── */
/* Fixtures                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

type Bag = {
  readonly [K in keyof ObservabilityBag]: ObservabilityBag[K] | undefined
}

const emptyBag = (): Bag => ({
  llmProvider: undefined,
  scheduler: undefined,
  shadowOdb: undefined,
  planQueue: undefined,
  budgetLedger: undefined,
  lspClient: undefined,
  tools: undefined,
})

// Captured signal registrar helper. Returns the registered handler so tests
// can simulate the OS firing the signal.
const makeSignalCapture = (): {
  readonly onSignal: (sig: "SIGHUP", handler: () => void) => void
  readonly offSignal: (sig: "SIGHUP", handler: () => void) => void
  readonly registered: { sig: string; handler: () => void }[]
  readonly removed: { sig: string; handler: () => void }[]
} => {
  const registered: { sig: string; handler: () => void }[] = []
  const removed: { sig: string; handler: () => void }[] = []
  return {
    onSignal: (sig, handler) => {
      registered.push({ sig, handler })
    },
    offSignal: (sig, handler) => {
      removed.push({ sig, handler })
    },
    registered,
    removed,
  }
}

const flushTurn = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

// Captured interval helper. Returns hooks so tests can manually fire the
// interval callback (no real timers — deterministic).
const makeIntervalCapture = (): {
  readonly setInterval: (handler: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
  readonly intervals: { handler: () => void; ms: number; handle: object }[]
  readonly cleared: object[]
} => {
  const intervals: { handler: () => void; ms: number; handle: object }[] = []
  const cleared: object[] = []
  return {
    setInterval: (handler, ms) => {
      const handle = {}
      intervals.push({ handler, ms, handle })
      return handle
    },
    clearInterval: (handle) => {
      cleared.push(handle as object)
    },
    intervals,
    cleared,
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* A. Interval-based emit                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0187 interval-based emit", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-snap-watcher-A-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("[1] intervalMs:1000 + fake setInterval → handler registered with 1000ms", async () => {
    const iv = makeIntervalCapture()
    const sig = makeSignalCapture()
    const writes: { path: string; len: number }[] = []
    let resolveWrite!: () => void
    const wrote = new Promise<void>((resolve) => {
      resolveWrite = resolve
    })
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: 1000,
      hotReloadOnSighup: false,
      onSignal: sig.onSignal,
      offSignal: sig.offSignal,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: {
        write: {
          path: join(dir, "health.json"),
          writeFile: async (p, c) => {
            writes.push({ path: p, len: c.length })
            resolveWrite()
          },
        },
      },
    })
    expect(iv.intervals.length).toBe(1)
    expect(iv.intervals[0]?.ms).toBe(1000)
    // Firing the interval callback triggers emit.
    iv.intervals[0]?.handler()
    await wrote
    expect(writes.length).toBe(1)
    h.stop()
  })

  test("[2] default interval = 30_000ms when intervalMs absent", () => {
    const iv = makeIntervalCapture()
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      hotReloadOnSighup: false,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: { write: { path: join(dir, "health.json"), writeFile: async () => undefined } },
    })
    expect(iv.intervals.length).toBe(1)
    expect(iv.intervals[0]?.ms).toBe(30_000)
    h.stop()
  })

  test("[3] clearInterval called on stop()", () => {
    const iv = makeIntervalCapture()
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: 5000,
      hotReloadOnSighup: false,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: { write: { path: join(dir, "health.json"), writeFile: async () => undefined } },
    })
    expect(iv.cleared.length).toBe(0)
    h.stop()
    expect(iv.cleared.length).toBe(1)
    expect(iv.cleared[0]).toBe(iv.intervals[0]?.handle as object)
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* B. SIGHUP-driven emit                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0187 SIGHUP-driven emit", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-snap-watcher-B-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("[4] hotReloadOnSighup default true → onSignal called for SIGHUP", () => {
    const sig = makeSignalCapture()
    const iv = makeIntervalCapture()
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: -1, // disable timer to isolate signal wiring
      onSignal: sig.onSignal,
      offSignal: sig.offSignal,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: { write: { path: join(dir, "health.json"), writeFile: async () => undefined } },
    })
    expect(sig.registered.length).toBe(1)
    expect(sig.registered[0]?.sig).toBe("SIGHUP")
    h.stop()
  })

  test("[5] firing the registered SIGHUP handler triggers emit", async () => {
    const sig = makeSignalCapture()
    const iv = makeIntervalCapture()
    const writes: { path: string; len: number }[] = []
    let resolveWrite!: () => void
    const wrote = new Promise<void>((resolve) => {
      resolveWrite = resolve
    })
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: -1,
      onSignal: sig.onSignal,
      offSignal: sig.offSignal,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: {
        write: {
          path: join(dir, "health.json"),
          writeFile: async (p, c) => {
            writes.push({ path: p, len: c.length })
            resolveWrite()
          },
        },
      },
    })
    sig.registered[0]?.handler()
    await wrote
    expect(writes.length).toBe(1)
    expect(writes[0]?.path).toBe(join(dir, "health.json"))
    h.stop()
    expect(sig.removed.length).toBe(1)
  })

  test("[6] hotReloadOnSighup:false → onSignal NOT called", () => {
    const sig = makeSignalCapture()
    const iv = makeIntervalCapture()
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: -1,
      hotReloadOnSighup: false,
      onSignal: sig.onSignal,
      offSignal: sig.offSignal,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: { write: { path: join(dir, "health.json"), writeFile: async () => undefined } },
    })
    expect(sig.registered.length).toBe(0)
    h.stop()
    expect(sig.removed.length).toBe(0)
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* C. emitNow contract                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0187 emitNow contract", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-snap-watcher-C-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("[7] emitNow builds snapshot from getBag() and writes to snapshot.path", async () => {
    const iv = makeIntervalCapture()
    const target = join(dir, "health.json")
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: -1,
      hotReloadOnSighup: false,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: { write: { path: target } },
    })
    await h.emitNow()
    const parsed = JSON.parse(await readFile(target, "utf8")) as HealthSnapshot
    expect(parsed.version).toBe(1)
    expect(parsed.slices.length).toBe(7)
    h.stop()
  })

  test("[8] write throws → warn called; subsequent emitNow still runs (state not poisoned)", async () => {
    const iv = makeIntervalCapture()
    const warnings: string[] = []
    let throwNext = true
    const calls: number[] = []
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: -1,
      hotReloadOnSighup: false,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      warn: (m) => warnings.push(m),
      snapshot: {
        write: {
          path: join(dir, "health.json"),
          writeFile: async () => {
            calls.push(Date.now())
            if (throwNext) {
              throwNext = false
              throw new Error("simulated EIO")
            }
          },
        },
      },
    })
    await h.emitNow()
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("simulated EIO")
    // Second call must succeed (writer no longer throws) — proves no
    // poisoned internal state from the first failure.
    await h.emitNow()
    expect(calls.length).toBe(2)
    expect(warnings.length).toBe(1) // no second warn
    h.stop()
  })

  test("[9] emitNow returns Promise that resolves AFTER write completes", async () => {
    const iv = makeIntervalCapture()
    const events: string[] = []
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: -1,
      hotReloadOnSighup: false,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: {
        write: {
          path: join(dir, "health.json"),
          writeFile: async () => {
            await new Promise<void>((r) => setTimeout(r, 20))
            events.push("write-done")
          },
        },
      },
    })
    const p = h.emitNow()
    events.push("emit-returned")
    await p
    events.push("await-resolved")
    expect(events).toEqual(["emit-returned", "write-done", "await-resolved"])
    h.stop()
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* D. stop semantics                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0187 stop semantics", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-snap-watcher-D-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("[10] stop() called twice → idempotent (no throw, no double-clear)", () => {
    const iv = makeIntervalCapture()
    const sig = makeSignalCapture()
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: 5000,
      onSignal: sig.onSignal,
      offSignal: sig.offSignal,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: { write: { path: join(dir, "health.json"), writeFile: async () => undefined } },
    })
    h.stop()
    h.stop() // second call must not throw
    // No double-clear: clearInterval called exactly once; removeListener once.
    expect(iv.cleared.length).toBe(1)
    expect(sig.removed.length).toBe(1)
  })

  test("[11] after stop(), emitNow() still works manually", async () => {
    const iv = makeIntervalCapture()
    const writes: { path: string; len: number }[] = []
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: 5000,
      hotReloadOnSighup: false,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: {
        write: {
          path: join(dir, "health.json"),
          writeFile: async (p, c) => {
            writes.push({ path: p, len: c.length })
          },
        },
      },
    })
    h.stop()
    // The interval is gone — but emitNow primitive lives.
    await h.emitNow()
    expect(writes.length).toBe(1)
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* E. Fresh bag every tick                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0187 fresh bag every tick", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-snap-watcher-E-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("[12] getBag changes between intervals → snapshot reflects latest state", async () => {
    const iv = makeIntervalCapture()
    const target = join(dir, "health.json")
    const writes: string[] = []
    let observeSecondWrite = (): void => {}
    const secondWrite = new Promise<void>((resolve) => {
      observeSecondWrite = resolve
    })
    // Mutable bag — first poll has nothing wired; after we flip the flag,
    // subsequent polls see planQueue wired.
    let planQueueWired = false
    const getBag = (): Bag => ({
      ...emptyBag(),
      planQueue: planQueueWired ? ({} as never) : undefined,
    })
    const h = startHealthSnapshotWatcher({
      getBag,
      intervalMs: 1000,
      hotReloadOnSighup: false,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: {
        write: {
          path: target,
          writeFile: async (_path, content) => {
            writes.push(content)
            if (writes.length === 2) observeSecondWrite()
          },
        },
      },
    })
    // First emit: empty.
    await h.emitNow()
    let parsed = JSON.parse(writes[0] ?? "") as HealthSnapshot
    expect(parsed.summary.wiredCount).toBe(0)
    // Flip the wiring and re-emit (simulate the interval firing).
    planQueueWired = true
    iv.intervals[0]?.handler()
    await secondWrite
    parsed = JSON.parse(writes[1] ?? "") as HealthSnapshot
    expect(parsed.summary.wiredCount).toBe(1)
    const pq = parsed.slices.find((s) => s.slice === "planQueue")
    expect(pq?.wired).toBe(true)
    h.stop()
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* F. Preserved build opts + overlap serialization                            */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0187 preserved build opts + overlap serialization", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-snap-watcher-F-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("[13] repeated refresh preserves snapshot.build opts", async () => {
    const target = join(dir, "health.json")
    let tick = 0
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: 1000,
      hotReloadOnSighup: false,
      snapshot: {
        build: {
          skippedExpected: new Set<keyof ObservabilityBag>(["lspClient"]),
          quantaVersion: "watcher-version",
          now: () => 1_700_000_000_100 + tick++,
        },
        write: { path: target },
      },
    })
    await h.emitNow()
    let parsed = JSON.parse(await readFile(target, "utf8")) as HealthSnapshot
    expect(parsed.quantaVersion).toBe("watcher-version")
    expect(parsed.writtenAt).toBe(1_700_000_000_100)
    expect(parsed.slices.find((s) => s.slice === "lspClient")?.note).toBe("skipped intentionally")

    await h.emitNow()

    parsed = JSON.parse(await readFile(target, "utf8")) as HealthSnapshot
    expect(parsed.quantaVersion).toBe("watcher-version")
    expect(parsed.writtenAt).toBe(1_700_000_000_101)
    expect(parsed.slices.find((s) => s.slice === "lspClient")?.note).toBe("skipped intentionally")
    h.stop()
  })

  test("[14] overlapping triggers serialize writes and collapse to one follow-up emit", async () => {
    const iv = makeIntervalCapture()
    const sig = makeSignalCapture()
    let writes = 0
    let activeWrites = 0
    let maxActiveWrites = 0
    const releases: Array<() => void> = []
    const h = startHealthSnapshotWatcher({
      getBag: emptyBag,
      intervalMs: 1000,
      onSignal: sig.onSignal,
      offSignal: sig.offSignal,
      setInterval: iv.setInterval,
      clearInterval: iv.clearInterval,
      snapshot: {
        write: {
          path: join(dir, "health.json"),
          writeFile: async () => {
            writes += 1
            activeWrites += 1
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
            await new Promise<void>((resolve) => {
              releases.push(resolve)
            })
            activeWrites -= 1
          },
        },
      },
    })

    const first = h.emitNow()
    expect(activeWrites).toBe(1)

    const second = h.emitNow()
    iv.intervals[0]?.handler()
    sig.registered[0]?.handler()
    expect(writes).toBe(1)
    expect(maxActiveWrites).toBe(1)

    releases.shift()?.()
    await flushTurn()
    expect(writes).toBe(2)
    expect(activeWrites).toBe(1)
    expect(maxActiveWrites).toBe(1)

    releases.shift()?.()
    await Promise.all([first, second])
    expect(writes).toBe(2)
    expect(activeWrites).toBe(0)
    expect(maxActiveWrites).toBe(1)
    h.stop()
  })
})
