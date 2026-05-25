import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
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
import { InMemoryStage1Store } from "@/memory/stage1-store"
import { buildSessionMemoryAutoWires, prepareSessionStartMemory } from "@/runner"

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

  test("prepareSessionStartMemory renders selected cross-session memory into sessionCtx", async () => {
    const stage1 = new InMemoryStage1Store({ now: () => 100 })
    stage1.put({
      threadId: "thr-1",
      sourceUpdatedAt: 100,
      rawMemory: "- raw",
      rolloutSummary: "Remember the repo uses bun and rg first.",
      generatedAt: 100,
      rolloutSlug: "sess-1",
      usageCount: 1,
      lastUsage: 100,
      selectedForPhase2: true,
    })

    const out = await prepareSessionStartMemory({
      env: { QUANTA_MEMORY_AUTO: "on" },
      stage1OutputsStore: stage1,
    })

    expect(out.sessionCtx).toContain("Cross-session memory")
    expect(out.sessionCtx).toContain("Remember the repo uses bun and rg first.")
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

  test("buildSessionMemoryAutoWires returns undefined when the feature is off", async () => {
    const llm = { stream: async function* () {} } as never
    const out = await buildSessionMemoryAutoWires({
      env: {},
      llm,
      sessionId: "sess-off",
      homeDir: tempHome,
    })
    expect(out).toBeUndefined()
  })
})
