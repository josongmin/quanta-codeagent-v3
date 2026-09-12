import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  MemoryWriter,
  Phase2Port,
  Stage1Output,
  Stage1StorePort,
  WatermarkState,
} from "@/memory"
import {
  buildSessionMemoryAutoWires,
  prepareSessionStartMemory,
} from "@/runner/session-memory-auto"

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("session-memory-auto", () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "q-session-memory-auto-"))
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  test("prepareSessionStartMemory schedules phase2 auto-trigger when thresholds are met", async () => {
    const stage1Entry: Stage1Output = {
      threadId: "thr-1",
      rolloutSlug: "sess-1",
      rolloutSummary: "summary",
      rawMemory: "- raw",
      preferenceSignals: [],
      sourceUpdatedAt: 100,
      selectedForPhase2: true,
      selectedForPhase2SourceUpdatedAt: 100,
      lastUsage: 100,
      usageCount: 1,
    }
    const watermark: WatermarkState = {
      lastSuccessAt: null,
      lastInitAt: null,
      lastConsolidatedCount: 0,
    }
    const store: Stage1StorePort = {
      upsert: async () => undefined,
      fetchSince: async () => [stage1Entry],
      countSince: async () => 99,
      getWatermark: async () => watermark,
      setWatermark: async () => undefined,
    }
    const writes: string[] = []
    const writer = {
      readExisting: async () => ({
        memoryMd: null,
        rawMemoriesMd: null,
        memorySummaryMd: null,
      }),
      writeAtomic: async (content: {
        memoryMd: string
        rawMemoriesMd: string
        memorySummaryMd: string
      }) => {
        writes.push(content.memorySummaryMd)
        return { gitCommitSha: null }
      },
    } as unknown as MemoryWriter
    const phase2: Phase2Port = {
      consolidate: async () => ({
        memoryMd: "# memory",
        rawMemoriesMd: "raw",
        memorySummaryMd: "summary",
      }),
    }

    await prepareSessionStartMemory({
      env: { QUANTA_MEMORY_AUTO: "on" },
      phase2: { store, writer, port: phase2 },
    })
    await flushMicrotasks()

    expect(writes).toEqual(["summary"])
  })

  test("buildSessionMemoryAutoWires returns undefined when the feature is explicitly off (ADR-0414: default-ON, off via QUANTA_MEMORY_AUTO=off)", async () => {
    const llm = { stream: async function* () {} } as never
    const out = await buildSessionMemoryAutoWires({
      env: { QUANTA_MEMORY_AUTO: "off" },
      llm,
      sessionId: "sess-off",
      homeDir: tempHome,
    })
    expect(out).toBeUndefined()
  })

  test("buildSessionMemoryAutoWires returns wires by default (ADR-0414: empty env ⇒ default-ON)", async () => {
    const llm = { stream: async function* () {} } as never
    const out = await buildSessionMemoryAutoWires({
      env: {},
      llm,
      sessionId: "sess-default-on",
      homeDir: tempHome,
    })
    expect(out).toBeDefined()
    expect(out?.memoryConsolidator.enabled).toBe(true)
    const rawKey = "AKIAIOSFODNN7EXAMPLE"
    expect(out?.memoryConsolidator.redact?.(`key=${rawKey}`)).not.toContain(rawKey)
    out?.dispose()
  })

  test("buildSessionMemoryAutoWires loads memory_summary.md as a separate field", async () => {
    // `homeDir` is the QUANTA HOME, so the consolidator layout is `<home>/memory/`.
    // It was `<home>/.quanta/memory/` while the memory plane resolved against an OS
    // home instead of following QUANTA_HOME.
    mkdirSync(join(tempHome, "memory"), { recursive: true })
    writeFileSync(join(tempHome, "memory", "memory_summary.md"), "- durable hint\n")

    const llm = { stream: async function* () {} } as never
    const out = await buildSessionMemoryAutoWires({
      env: {},
      llm,
      sessionId: "sess-memory-summary",
      homeDir: tempHome,
    })

    expect(out?.memorySummaryMd).toBe("- durable hint\n")
    out?.dispose()
  })

  test("bundle wires the deferred-consolidation lane: consolidator.defer present + drain exposed", async () => {
    const llm = { stream: async function* () {} } as never
    const out = await buildSessionMemoryAutoWires({
      env: {},
      llm,
      sessionId: "sess-lane-wire",
      homeDir: tempHome,
    })
    expect(out).toBeDefined()
    // The consolidator block carries the lane's defer — this is what makes
    // runAgent hand the distill off instead of blocking turn completion.
    expect(typeof out?.memoryConsolidator.defer).toBe("function")
    expect(typeof out?.drain).toBe("function")
    out?.dispose()
  })

  test("lane: single-flight + latest-pending coalescing; drain awaits in-flight AND the coalesced rerun", async () => {
    const llm = { stream: async function* () {} } as never
    const out = await buildSessionMemoryAutoWires({
      env: {},
      llm,
      sessionId: "sess-lane-coalesce",
      homeDir: tempHome,
    })
    const defer = out?.memoryConsolidator.defer
    if (out === undefined || defer === undefined) throw new Error("lane not wired")

    const events: string[] = []
    let releaseA = (): void => undefined
    const gateA = new Promise<void>((r) => {
      releaseA = r
    })
    defer(async () => {
      events.push("A:start")
      await gateA
      events.push("A:end")
    })
    // While A is in flight, B is queued then SUPERSEDED by C (latest wins —
    // each run distills a full snapshot for the same threadId row).
    defer(async () => {
      events.push("B")
    })
    defer(async () => {
      events.push("C")
    })

    let drained = false
    const drainP = out.drain().then(() => {
      drained = true
    })
    await flushMicrotasks()
    // drain must NOT resolve while A is still in flight.
    expect(drained).toBe(false)
    expect(events).toEqual(["A:start"])

    releaseA()
    await drainP
    // A completed, then the COALESCED rerun (C) — B never ran.
    expect(events).toEqual(["A:start", "A:end", "C"])

    // Idle lane: drain resolves immediately (no pending work invented).
    await out.drain()
    out.dispose()
  })

  test("lane: drain that actually waits announces ONCE via logWarn; idle drain stays silent", async () => {
    const llm = { stream: async function* () {} } as never
    const warns: string[] = []
    const out = await buildSessionMemoryAutoWires({
      env: {},
      llm,
      sessionId: "sess-lane-notice",
      homeDir: tempHome,
      logWarn: (msg) => warns.push(msg),
    })
    const defer = out?.memoryConsolidator.defer
    if (out === undefined || defer === undefined) throw new Error("lane not wired")

    // Idle drain: no in-flight work ⇒ no notice (a notice here would cry wolf
    // on every clean exit).
    await out.drain()
    expect(warns.filter((w) => w.includes("memory consolidation"))).toEqual([])

    let release = (): void => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    defer(async () => {
      await gate
    })
    const drainP = out.drain()
    // The notice fires as soon as drain commits to waiting — before release.
    expect(warns.filter((w) => w.includes("memory consolidation"))).toHaveLength(1)
    release()
    await drainP
    expect(warns.filter((w) => w.includes("memory consolidation"))).toHaveLength(1)
    out.dispose()
  })

  test("lane: a rejecting run does not wedge the lane (drain resolves; later defers still run)", async () => {
    const llm = { stream: async function* () {} } as never
    const out = await buildSessionMemoryAutoWires({
      env: {},
      llm,
      sessionId: "sess-lane-reject",
      homeDir: tempHome,
    })
    const defer = out?.memoryConsolidator.defer
    if (out === undefined || defer === undefined) throw new Error("lane not wired")

    defer(async () => {
      throw new Error("hostile run boom")
    })
    await out.drain()

    const ran: string[] = []
    defer(async () => {
      ran.push("after-reject")
    })
    await out.drain()
    expect(ran).toEqual(["after-reject"])
    out.dispose()
  })
})
