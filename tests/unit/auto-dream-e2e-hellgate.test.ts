/**
 * H16 — CROSS-SESSION auto-dream END-TO-END hellgate.
 *
 * Wires the trigger to REAL collaborators where practical:
 *   - the codebase's `InMemoryLock` (the dream-lock primitive we reuse)
 *   - the `FileDreamWriteTarget` (team/ target) with an in-memory fs fake
 *   - a `DreamConsolidatePort` that DELEGATES to the EXISTING `runPhase2`
 *     consolidate pipeline (proves we reuse it, not reimplement it)
 *
 * Asserts, after several session-ends crossing the threshold (injected
 * clock):
 *   - the consolidate pipeline (runPhase2) runs exactly ONCE
 *   - the lock is taken and released (a later out-of-band acquire succeeds)
 *   - the team target file is written (NOT MEMORY.md)
 *   - telemetry fired + completed are emitted
 *   - knob OFF ⇒ nothing happens
 *
 * No real Date.now(), no real disk.
 */

import { describe, expect, test } from "bun:test"
import { InMemoryLock } from "../../src/auth/lock-in-memory"
import type {
  Phase2Input,
  Phase2Port,
  Stage1Output,
  Stage1StorePort,
  WatermarkState,
} from "../../src/memory/consolidate"
import { MemoryWriter, type NodeFsLike, runPhase2 } from "../../src/memory/consolidate"
import { NullGitPort } from "../../src/memory/consolidate/git"
import {
  CrossSessionDreamTrigger,
  type DreamConsolidatePort,
  type DreamPolicy,
  type DreamTelemetryPort,
  FileDreamWriteTarget,
  InMemoryDreamState,
} from "../../src/memory/dream"

const mkClock = (start = 1_700_000_000_000) => {
  let t = start
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms
    },
  }
}

const POLICY: DreamPolicy = { sessionsThreshold: 3, hoursThreshold: 24 }

/** Recording telemetry sink. */
const mkTelemetry = (): DreamTelemetryPort & {
  fired: number
  completed: Array<{ outcome: string; bytesWritten: number }>
  skipped: string[]
} => {
  const completed: Array<{ outcome: string; bytesWritten: number }> = []
  const skipped: string[] = []
  let fired = 0
  return {
    get fired() {
      return fired
    },
    completed,
    skipped,
    recordFired: () => {
      fired += 1
    },
    recordCompleted: (e) => {
      completed.push({ outcome: e.outcome, bytesWritten: e.bytesWritten })
    },
    recordSkipped: (e) => {
      skipped.push(e.reason)
    },
  }
}

/** In-memory fs fake satisfying the consolidate writer's `NodeFsLike` AND the
 *  dream write target's `DreamFsPort`. Records writes by path. */
const mkFsFake = () => {
  const files = new Map<string, string>()
  const fs: NodeFsLike = {
    mkdir: async () => undefined,
    chmod: async () => {},
    readFile: async (p: string) => {
      const v = files.get(p)
      if (v === undefined) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        e.code = "ENOENT"
        throw e
      }
      return v
    },
    writeFile: async (p: string, c: string) => {
      files.set(p, c)
    },
    rename: async (from: string, to: string) => {
      const v = files.get(from)
      if (v !== undefined) {
        files.set(to, v)
        files.delete(from)
      }
    },
    unlink: async (p: string) => {
      files.delete(p)
    },
    access: async (p: string) => {
      if (!files.has(p)) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        e.code = "ENOENT"
        throw e
      }
    },
  }
  return { fs, files }
}

/** A deterministic stage1 entry so incremental consolidate does real work. */
const mkStage1Entry = (now: number): Stage1Output => ({
  threadId: "t1",
  rolloutSlug: "bun-session",
  rolloutSummary: "session about bun",
  rawMemory: "- decision: use bun",
  preferenceSignals: ["bun"],
  sourceUpdatedAt: now,
  selectedForPhase2: true,
  selectedForPhase2SourceUpdatedAt: now,
  lastUsage: now,
  usageCount: 1,
  outcome: "pass",
  outcomeEvidence: "tests green",
})

/** Build a `DreamConsolidatePort` backed by the EXISTING runPhase2 pipeline.
 *  Counts how many times the underlying consolidate LLM port is invoked. The
 *  consolidate writer shares the `fs` passed in so its MEMORY.md write lands
 *  in the same in-memory fs the test inspects. */
const mkRealConsolidateAdapter = (clock: { now: () => number }, fs: NodeFsLike) => {
  const calls = { n: 0 }

  // Fake Phase2 LLM port — deterministic consolidated text.
  const phase2Port: Phase2Port = {
    consolidate: async () => {
      calls.n += 1
      return {
        memoryMd: "# MEMORY\n- cross-session decision: prefer bun",
        rawMemoriesMd: "- raw: bun",
        memorySummaryMd: "summary: bun across sessions",
      }
    },
  }

  // Minimal async Stage1StorePort with one pending row.
  let watermark: WatermarkState = {
    lastSuccessAt: null,
    lastInitAt: null,
    lastConsolidatedCount: 0,
  }
  const store: Stage1StorePort = {
    upsert: async () => {},
    fetchSince: async () => [mkStage1Entry(clock.now())],
    countSince: async () => 1,
    getWatermark: async () => watermark,
    setWatermark: async (w: WatermarkState) => {
      watermark = w
    },
  }

  // Real writer with NullGitPort (no git side effects) sharing the test fs.
  const writer = new MemoryWriter(
    {
      root: "/home/u/.quanta/memory",
      memoryMd: "/home/u/.quanta/memory/MEMORY.md",
      rawMemoriesMd: "/home/u/.quanta/memory/raw_memories.md",
      memorySummaryMd: "/home/u/.quanta/memory/memory_summary.md",
    },
    fs,
    new NullGitPort(),
    { gitEnabled: false },
  )

  const port: DreamConsolidatePort = {
    consolidate: async () => {
      const input: Phase2Input = {
        mode: "incremental",
        stage1Entries: await store.fetchSince(null),
        existingMemoryMd: null,
        existingRawMemoriesMd: null,
        existingMemorySummaryMd: null,
        lastSuccessWatermark: null,
        now: clock.now,
      }
      const outcome = await runPhase2(input, phase2Port, store, writer)
      if (outcome.kind === "skipped") return { kind: "no_op" }
      return { kind: "consolidated", content: "summary: bun across sessions" }
    },
  }
  return { port, calls }
}

describe("auto-dream e2e — threshold crossing wires the real consolidate pipeline", () => {
  test("several session-ends → runPhase2 once, lock taken+released, team file written, telemetry", async () => {
    const clock = mkClock()
    const lock = new InMemoryLock(clock)
    const { fs, files } = mkFsFake()
    const { port, calls } = mkRealConsolidateAdapter(clock, fs)
    const writeTarget = new FileDreamWriteTarget({ memoryRoot: "/home/u/.quanta/memory", fs })
    const telemetry = mkTelemetry()
    const state = new InMemoryDreamState()

    const trigger = new CrossSessionDreamTrigger({
      state,
      consolidate: port,
      writeTarget,
      lock,
      now: clock.now,
      policy: POLICY,
      telemetry,
    })

    // 3 session-ends — the 3rd crosses the sessions threshold.
    await trigger.onSessionEnd()
    clock.advance(60_000)
    await trigger.onSessionEnd()
    clock.advance(60_000)
    const o = await trigger.onSessionEnd()

    expect(o.kind).toBe("completed")
    // runPhase2's LLM port invoked exactly once (one consolidation total).
    expect(calls.n).toBe(1)

    // Team target written, NOT MEMORY.md.
    expect(files.has(writeTarget.targetPath)).toBe(true)
    expect(writeTarget.targetPath.endsWith("MEMORY.md")).toBe(false)
    expect(writeTarget.targetPath).toContain("/team/")
    expect(files.get(writeTarget.targetPath)).toContain("bun across sessions")

    // Lock taken + released → out-of-band acquire now succeeds.
    const acq = await lock.tryAcquire("memory-auto-dream", "other", 60_000)
    expect(acq).toBe("acquired")

    // Telemetry: fired once, completed once. The two pre-threshold
    // session-ends each emit a `below_threshold` skip (the trio mirror of
    // Claude's tengu_auto_dream_skipped).
    expect(telemetry.fired).toBe(1)
    expect(telemetry.completed).toEqual([
      {
        outcome: "completed",
        bytesWritten: Buffer.byteLength("summary: bun across sessions", "utf8"),
      },
    ])
    expect(telemetry.skipped).toEqual(["below_threshold", "below_threshold"])

    // Counter reset; clock stamped.
    expect(state.read().sessionsSinceLastDream).toBe(0)
    expect(state.read().lastDreamAtMs).toBe(clock.now())
  })

  test("knob OFF ⇒ nothing happens across many session-ends", async () => {
    const clock = mkClock()
    const lock = new InMemoryLock(clock)
    const { fs, files } = mkFsFake()
    const { port, calls } = mkRealConsolidateAdapter(clock, fs)
    const writeTarget = new FileDreamWriteTarget({ memoryRoot: "/home/u/.quanta/memory", fs })
    const telemetry = mkTelemetry()

    const trigger = new CrossSessionDreamTrigger({
      state: new InMemoryDreamState(),
      consolidate: port,
      writeTarget,
      lock,
      now: clock.now,
      // no policy ⇒ OFF
      telemetry,
    })

    for (let i = 0; i < 10; i++) {
      clock.advance(60 * 60 * 1000) // even hours passing never matters when OFF
      await trigger.onSessionEnd()
    }

    expect(calls.n).toBe(0)
    expect(files.size).toBe(0)
    expect(telemetry.fired).toBe(0)
    expect(telemetry.completed).toHaveLength(0)
    expect(telemetry.skipped).toHaveLength(0)
  })
})
