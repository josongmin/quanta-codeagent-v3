/**
 * ADR-0180 hellgate — file-based JSON health snapshot. Default-OFF
 * (`healthSnapshotPath` absent) → byte-identical to ADR-0172 baseline (no I/O,
 * no snapshot file). Opt-in mode writes a versioned envelope mirroring the
 * `observability.wired.total` gauge to `~/.quanta/health.json` (or a custom
 * path) atomically (tmp + rename).
 *
 * 12-case coverage:
 *   A. buildHealthSnapshot — pure (5 cases)
 *   B. writeHealthSnapshot — I/O atomicity + error mapping (4 cases)
 *   C. withFullObservability integration (2 cases)
 *   D. byte-identical determinism (1 case)
 *
 * SOTA reference (cited in ADR-0180):
 *   - K8s pod liveness probe `exec.command: ["cat","~/.quanta/health.json"]`
 *   - systemd notify socket — file-based health surfaces are universal
 *   No SOTA agent (Claude Desktop / Cursor / Codex) writes a JSON health
 *   file; all rely on Sentry events or IPC RPC. quanta first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildHealthSnapshot,
  type HealthSnapshot,
  HealthSnapshotError,
  type SliceHealth,
  writeHealthSnapshot,
} from "@/observability/metrics/health-snapshot"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  lastHealthSnapshotInFlight,
  type ObservabilityBag,
  withFullObservability,
} from "@/observability/metrics/observability-helper"
import { quantaHomeDir } from "@/shared/quanta-home"

/* ────────────────────────────────────────────────────────────────────────── */
/* Fixtures                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

const ALL_KEYS: ReadonlyArray<keyof ObservabilityBag> = [
  "llmProvider",
  "scheduler",
  "shadowOdb",
  "planQueue",
  "budgetLedger",
  "lspClient",
  "tools",
] as const

const fixedClock = (): number => 1_700_000_000_000

const emptyBag = (): {
  readonly [K in keyof ObservabilityBag]: ObservabilityBag[K] | undefined
} => ({
  llmProvider: undefined,
  scheduler: undefined,
  shadowOdb: undefined,
  planQueue: undefined,
  budgetLedger: undefined,
  lspClient: undefined,
  tools: undefined,
})

// Minimal stub for "this slice IS wired" — only presence (not behavior) matters
// to buildHealthSnapshot (it just checks `!== undefined`).
const wiredStub = (): unknown => ({})

/* ────────────────────────────────────────────────────────────────────────── */
/* A. buildHealthSnapshot — pure                                              */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0180 buildHealthSnapshot — pure", () => {
  test("[1] empty bag → 7 slices, all wired=false, summary {wiredCount:0, totalCount:7, ratio:0}", () => {
    const snap = buildHealthSnapshot(emptyBag(), { now: fixedClock })
    expect(snap.version).toBe(1)
    expect(snap.slices.length).toBe(7)
    for (const s of snap.slices) {
      expect(s.wired).toBe(false)
      expect(s.note).toBe("missing")
    }
    expect(snap.summary.wiredCount).toBe(0)
    expect(snap.summary.totalCount).toBe(7)
    expect(snap.summary.completenessRatio).toBe(0)
  })

  test("[2] all 7 wired → all wired=true, note='wired', ratio=1", () => {
    const bag = {
      llmProvider: wiredStub() as never,
      scheduler: wiredStub() as never,
      shadowOdb: wiredStub() as never,
      planQueue: wiredStub() as never,
      budgetLedger: wiredStub() as never,
      lspClient: wiredStub() as never,
      tools: [] as never,
    }
    const snap = buildHealthSnapshot(bag, { now: fixedClock })
    expect(snap.slices.length).toBe(7)
    for (const s of snap.slices) {
      expect(s.wired).toBe(true)
      expect(s.note).toBe("wired")
    }
    expect(snap.summary.wiredCount).toBe(7)
    expect(snap.summary.completenessRatio).toBe(1)
  })

  test("[3] partial (3 wired) → 3 wired=true note='wired', 4 wired=false note='missing'", () => {
    const bag = {
      ...emptyBag(),
      planQueue: wiredStub() as never,
      budgetLedger: wiredStub() as never,
      tools: [] as never,
    }
    const snap = buildHealthSnapshot(bag, { now: fixedClock })
    const bySlice = new Map(snap.slices.map((s) => [s.slice, s]))
    const expectSlice = (k: keyof ObservabilityBag, wired: boolean, note: SliceHealth["note"]) => {
      const s = bySlice.get(k)
      expect(s).toBeDefined()
      expect(s?.wired).toBe(wired)
      expect(s?.note).toBe(note)
    }
    expectSlice("planQueue", true, "wired")
    expectSlice("budgetLedger", true, "wired")
    expectSlice("tools", true, "wired")
    expectSlice("llmProvider", false, "missing")
    expectSlice("scheduler", false, "missing")
    expectSlice("shadowOdb", false, "missing")
    expectSlice("lspClient", false, "missing")
    expect(snap.summary.wiredCount).toBe(3)
    expect(snap.summary.completenessRatio).toBeCloseTo(3 / 7, 10)
  })

  test("[4] skippedExpected → those slices wired=false, note='skipped intentionally'", () => {
    const snap = buildHealthSnapshot(emptyBag(), {
      now: fixedClock,
      skippedExpected: new Set<keyof ObservabilityBag>(["llmProvider", "lspClient"]),
    })
    const bySlice = new Map(snap.slices.map((s) => [s.slice, s]))
    expect(bySlice.get("llmProvider")?.note).toBe("skipped intentionally")
    expect(bySlice.get("lspClient")?.note).toBe("skipped intentionally")
    // Others are still "missing" (not in skippedExpected).
    expect(bySlice.get("scheduler")?.note).toBe("missing")
    expect(bySlice.get("shadowOdb")?.note).toBe("missing")
  })

  test("[5] quantaVersion override is reflected", () => {
    const snap = buildHealthSnapshot(emptyBag(), { now: fixedClock, quantaVersion: "9.9.9-rc" })
    expect(snap.quantaVersion).toBe("9.9.9-rc")
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* B. writeHealthSnapshot — I/O                                               */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0180 writeHealthSnapshot — I/O", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-health-snap-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("[6] happy: writes JSON to path; content parses to HealthSnapshot", async () => {
    const snap = buildHealthSnapshot(emptyBag(), { now: fixedClock })
    const target = join(dir, "health.json")
    const written = await writeHealthSnapshot(snap, { path: target })
    expect(written).toBe(target)
    const raw = await readFile(target, "utf8")
    const parsed = JSON.parse(raw) as HealthSnapshot
    expect(parsed.version).toBe(1)
    expect(parsed.slices.length).toBe(7)
    expect(parsed.summary.totalCount).toBe(7)
  })

  test("[7] atomic: never writes partial — injected writer records single call to FINAL path", async () => {
    const snap = buildHealthSnapshot(emptyBag(), { now: fixedClock })
    const target = join(dir, "atomic.json")
    const calls: Array<{ path: string; len: number }> = []
    const written = await writeHealthSnapshot(snap, {
      path: target,
      writeFile: async (p, c) => {
        calls.push({ path: p, len: c.length })
      },
    })
    expect(written).toBe(target)
    // Exactly one call, with the FINAL path (not a tmp path); the writer is
    // contractually atomic from the helper's perspective.
    expect(calls.length).toBe(1)
    expect(calls[0]?.path).toBe(target)
    expect((calls[0]?.len ?? 0) > 0).toBe(true)
  })

  test("[8] write failure → throws HealthSnapshotError('write-failed')", async () => {
    const snap = buildHealthSnapshot(emptyBag(), { now: fixedClock })
    let caught: unknown
    try {
      await writeHealthSnapshot(snap, {
        path: join(dir, "boom.json"),
        writeFile: async () => {
          throw new Error("disk on fire")
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HealthSnapshotError)
    expect((caught as HealthSnapshotError).errorCode).toBe("write-failed")
    expect((caught as Error).message).toContain("disk on fire")
  })

  test("[9] concurrent default writes allocate distinct tmp paths before rename", async () => {
    const snap = buildHealthSnapshot(emptyBag(), { now: fixedClock })
    const target = join(dir, "concurrent.json")
    const tmpWrites: string[] = []
    const renameCalls: string[] = []
    let started = 0
    let releaseBoth!: () => void
    const release = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    const fsOps: NonNullable<NonNullable<Parameters<typeof writeHealthSnapshot>[1]>["fsOps"]> = {
      mkdir: async () => undefined,
      writeFile: async (path) => {
        tmpWrites.push(String(path))
        started += 1
        if (started === 2) releaseBoth()
        await release
      },
      rename: async (from) => {
        renameCalls.push(String(from))
      },
    }
    await Promise.all([
      writeHealthSnapshot(snap, { path: target, fsOps }),
      writeHealthSnapshot(snap, { path: target, fsOps }),
    ])
    expect(tmpWrites.length).toBe(2)
    expect(new Set(tmpWrites).size).toBe(2)
    expect([...renameCalls].sort()).toEqual([...tmpWrites].sort())
    for (const tmpPath of tmpWrites) {
      expect(tmpPath.startsWith(`${target}.tmp.${process.pid}.`)).toBe(true)
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* C. withFullObservability integration                                       */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0180 withFullObservability integration", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "quanta-health-integ-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("[10] healthSnapshotPath: <absolute custom path> → file written, read it back", async () => {
    const m = defaultMetricsRegistry()
    const target = join(dir, "custom-health.json")
    withFullObservability({}, { metrics: m, healthSnapshotPath: target })
    const inflight = lastHealthSnapshotInFlight()
    expect(inflight).toBeDefined()
    const finalPath = await inflight
    expect(finalPath).toBe(target)
    const parsed = JSON.parse(await readFile(target, "utf8")) as HealthSnapshot
    expect(parsed.version).toBe(1)
    expect(parsed.slices.length).toBe(7)
    // Empty bag → all unwired.
    for (const s of parsed.slices) expect(s.wired).toBe(false)
    expect(parsed.summary.wiredCount).toBe(0)
  })

  test("[11] healthSnapshotPath: true → default path resolved (write attempted under ~/.quanta/)", async () => {
    // We can't safely write to the real ~/.quanta/health.json in CI, so we
    // verify the in-flight promise resolves successfully AND the resolved
    // path ends with `.quanta/health.json` — proving default-path semantics
    // were used without polluting the operator's actual file. The test
    // accepts the actual write (it's idempotent for the test machine and
    // matches operator workflow); if the directory cannot be created in a
    // sandboxed CI, the promise resolves to "" via the warn-swallow path.
    const m = defaultMetricsRegistry()
    const warnings: string[] = []
    withFullObservability(
      {},
      { metrics: m, healthSnapshotPath: true, warn: (msg) => warnings.push(msg) },
    )
    const inflight = lastHealthSnapshotInFlight()
    expect(inflight).toBeDefined()
    const finalPath = (await inflight) ?? ""
    // Either success (path ends with .quanta/health.json) OR swallowed (empty
    // string + warning recorded). Both prove the helper attempted the default
    // path resolution; neither shape proves anything else escaped.
    if (finalPath !== "") {
      // EXACT, and hermetic: the default is `<quanta home>/health.json`, and the test
      // preload points the quanta home at scratch. The previous suffix check passed by
      // writing the operator's real `~/.quanta/health.json`, which its comment accepted.
      expect(finalPath).toBe(join(quantaHomeDir(), "health.json"))
    } else {
      expect(warnings.length).toBeGreaterThan(0)
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* D. Determinism                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

describe("ADR-0180 determinism", () => {
  test("[12] same bag + injected clock → byte-identical JSON output", () => {
    const a = buildHealthSnapshot(emptyBag(), { now: fixedClock, quantaVersion: "test-1" })
    const b = buildHealthSnapshot(emptyBag(), { now: fixedClock, quantaVersion: "test-1" })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // Stable slice order — never alphabetic, never randomized; follows ALL_KEYS.
    const aOrder = a.slices.map((s) => s.slice)
    expect(aOrder).toEqual([...ALL_KEYS])
  })
})
