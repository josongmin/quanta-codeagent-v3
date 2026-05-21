/**
 * ADR-0068 Wave B — unit tests for `runPhase2` orchestrator.
 *
 * Strategy: mock every port (Phase2Port, Stage1StorePort, MemoryWriter)
 * with recording fakes so each assertion exercises exactly the
 * orchestration step under test.  No FS, no LLM, no git.
 */
import { describe, expect, test } from "bun:test"
import { MEMORY_MAX_BYTES, MEMORY_SUMMARY_MAX_BYTES } from "@/memory/consolidate/constants"
import { runPhase2 } from "@/memory/consolidate/phase2"
import {
  MemoryWriteError,
  Phase2ConsolidateError,
  type Phase2Input,
  type Phase2Port,
  type Stage1Output,
  type Stage1StorePort,
  WatermarkConflictError,
  type WatermarkState,
} from "@/memory/consolidate/types"
import type { MemoryWriter } from "@/memory/consolidate/writer"

// ─── Helpers ───────────────────────────────────────────────────────────────

const stage1 = (threadId: string, sourceUpdatedAt = 1_000): Stage1Output => ({
  threadId,
  rolloutSlug: `slug-${threadId}`,
  rolloutSummary: `summary ${threadId}`,
  rawMemory: `raw ${threadId}`,
  preferenceSignals: [],
  sourceUpdatedAt,
  selectedForPhase2: true,
  selectedForPhase2SourceUpdatedAt: sourceUpdatedAt,
  lastUsage: null,
  usageCount: 0,
})

const goodPortOut = {
  memoryMd: "# Memory\nconsolidated\n",
  rawMemoriesMd: "raw1\nraw2\n",
  memorySummaryMd: "summary\n",
  tokensUsed: 1234,
}

interface CallLog {
  consolidate: number
  writeAtomic: number
  getWatermark: number
  setWatermark: number
  order: string[]
}

const makePort = (
  out: { ok: typeof goodPortOut } | { throws: Error } | { custom: typeof goodPortOut },
  log: CallLog,
): Phase2Port => ({
  async consolidate(_args) {
    log.consolidate++
    log.order.push("consolidate")
    if ("throws" in out) throw out.throws
    if ("custom" in out) return out.custom
    return out.ok
  },
})

const makeStore = (
  existing: WatermarkState,
  log: CallLog,
  opts: { setThrows?: Error } = {},
): Stage1StorePort => ({
  async upsert(_) {
    throw new Error("not used in phase2 tests")
  },
  async fetchSince(_w, _l) {
    throw new Error("not used in phase2 tests")
  },
  async countSince(_w) {
    throw new Error("not used in phase2 tests")
  },
  async getWatermark() {
    log.getWatermark++
    log.order.push("getWatermark")
    return existing
  },
  async setWatermark(_next) {
    log.setWatermark++
    log.order.push("setWatermark")
    if (opts.setThrows) throw opts.setThrows
  },
})

const makeWriter = (
  log: CallLog,
  opts: { sha?: string | null; throws?: Error } = {},
): MemoryWriter => {
  const fake = {
    async writeAtomic(_content: unknown) {
      log.writeAtomic++
      log.order.push("writeAtomic")
      if (opts.throws) throw opts.throws
      return { gitCommitSha: opts.sha === undefined ? "sha-abc" : opts.sha }
    },
  }
  return fake as unknown as MemoryWriter
}

const makeLog = (): CallLog => ({
  consolidate: 0,
  writeAtomic: 0,
  getWatermark: 0,
  setWatermark: 0,
  order: [],
})

const baseInput = (overrides: Partial<Phase2Input> = {}): Phase2Input => ({
  stage1Entries: [stage1("t1"), stage1("t2")],
  existingMemoryMd: null,
  existingRawMemoriesMd: null,
  existingMemorySummaryMd: null,
  mode: "incremental",
  lastSuccessWatermark: null,
  now: () => 2_000,
  ...overrides,
})

const emptyWatermark: WatermarkState = {
  lastSuccessAt: null,
  lastInitAt: null,
  lastConsolidatedCount: 0,
}

// ─── Skip-gate ─────────────────────────────────────────────────────────────

describe("runPhase2 skip-gate", () => {
  test("incremental + 0 entries → kind:skipped, reason:no_new_entries", async () => {
    const log = makeLog()
    const res = await runPhase2(
      baseInput({ mode: "incremental", stage1Entries: [] }),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res).toEqual({ kind: "skipped", reason: "no_new_entries" })
    expect(log.consolidate).toBe(0)
    expect(log.writeAtomic).toBe(0)
    expect(log.setWatermark).toBe(0)
  })

  test("INIT + 0 entries proceeds (does NOT skip)", async () => {
    const log = makeLog()
    const res = await runPhase2(
      baseInput({ mode: "INIT", stage1Entries: [] }),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind).toBe("consolidated")
    expect(log.consolidate).toBe(1)
    expect(log.writeAtomic).toBe(1)
    expect(log.setWatermark).toBe(1)
  })

  test("incremental + 1 entry proceeds", async () => {
    const log = makeLog()
    const res = await runPhase2(
      baseInput({ mode: "incremental", stage1Entries: [stage1("solo")] }),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind).toBe("consolidated")
  })
})

// ─── Happy path / ordering ─────────────────────────────────────────────────

describe("runPhase2 happy path", () => {
  test("call order: consolidate → writeAtomic → getWatermark → setWatermark", async () => {
    const log = makeLog()
    await runPhase2(
      baseInput(),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(log.order).toEqual(["consolidate", "writeAtomic", "getWatermark", "setWatermark"])
  })

  test("returns gitCommitSha from writer", async () => {
    const log = makeLog()
    const res = await runPhase2(
      baseInput(),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log, { sha: "deadbeef" }),
    )
    expect(res.kind === "consolidated" && res.gitCommitSha).toBe("deadbeef")
  })

  test("null gitCommitSha (NullGitPort or clean tree) propagates", async () => {
    const log = makeLog()
    const res = await runPhase2(
      baseInput(),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log, { sha: null }),
    )
    expect(res.kind === "consolidated" && res.gitCommitSha).toBeNull()
  })

  test("bytesWritten reflects Buffer.byteLength of payloads", async () => {
    const log = makeLog()
    const customOut = {
      memoryMd: "abc",
      rawMemoriesMd: "라면", // 6 bytes utf8
      memorySummaryMd: "z".repeat(10),
    }
    const res = await runPhase2(
      baseInput(),
      makePort({ custom: { ...customOut, tokensUsed: 0 } }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind === "consolidated" && res.bytesWritten).toEqual({
      memory: 3,
      rawMemories: 6,
      memorySummary: 10,
    })
  })

  test("durationMs uses input.now() before and after", async () => {
    const log = makeLog()
    const times = [100, 250]
    const res = await runPhase2(
      baseInput({ now: () => times.shift() ?? 999 }),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind === "consolidated" && res.durationMs).toBe(150)
  })

  test("tokensUsed propagates when port reports it", async () => {
    const log = makeLog()
    const res = await runPhase2(
      baseInput(),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind === "consolidated" && res.tokensUsed).toBe(1234)
  })

  test("tokensUsed defaults to null when port omits it", async () => {
    const log = makeLog()
    const out: typeof goodPortOut = { ...goodPortOut }
    // biome-ignore lint/performance/noDelete: test scaffolding only
    delete (out as Partial<typeof goodPortOut>).tokensUsed
    const res = await runPhase2(
      baseInput(),
      makePort({ custom: out }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind === "consolidated" && res.tokensUsed).toBeNull()
  })

  test("stage1Count equals input length", async () => {
    const log = makeLog()
    const res = await runPhase2(
      baseInput({
        stage1Entries: [stage1("a"), stage1("b"), stage1("c"), stage1("d")],
      }),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind === "consolidated" && res.stage1Count).toBe(4)
  })

  test("mode echoes input.mode", async () => {
    const log = makeLog()
    const res = await runPhase2(
      baseInput({ mode: "INIT" }),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind === "consolidated" && res.mode).toBe("INIT")
  })
})

// ─── Watermark advancement ─────────────────────────────────────────────────

describe("runPhase2 watermark", () => {
  test("INIT updates lastInitAt to now()", async () => {
    const log = makeLog()
    let observed: WatermarkState | null = null
    const store: Stage1StorePort = {
      ...makeStore(emptyWatermark, log),
      async setWatermark(next) {
        observed = next
      },
    }
    await runPhase2(
      baseInput({ mode: "INIT", now: () => 5_000 }),
      makePort({ ok: goodPortOut }, log),
      store,
      makeWriter(log),
    )
    expect(observed).not.toBeNull()
    const w = observed as unknown as WatermarkState
    expect(w.lastInitAt).toBe(5_000)
    expect(w.lastSuccessAt).toBe(5_000)
  })

  test("incremental preserves prior lastInitAt", async () => {
    const log = makeLog()
    let observed: WatermarkState | null = null
    const prior: WatermarkState = {
      lastSuccessAt: 1_000,
      lastInitAt: 500,
      lastConsolidatedCount: 9,
    }
    const store: Stage1StorePort = {
      ...makeStore(prior, log),
      async setWatermark(next) {
        observed = next
      },
    }
    await runPhase2(
      baseInput({ mode: "incremental", now: () => 9_000 }),
      makePort({ ok: goodPortOut }, log),
      store,
      makeWriter(log),
    )
    const w = observed as unknown as WatermarkState
    expect(w.lastInitAt).toBe(500)
    expect(w.lastSuccessAt).toBe(9_000)
  })

  test("lastConsolidatedCount equals input length", async () => {
    const log = makeLog()
    let observed: WatermarkState | null = null
    const store: Stage1StorePort = {
      ...makeStore(emptyWatermark, log),
      async setWatermark(next) {
        observed = next
      },
    }
    await runPhase2(
      baseInput({ stage1Entries: [stage1("a"), stage1("b")] }),
      makePort({ ok: goodPortOut }, log),
      store,
      makeWriter(log),
    )
    expect((observed as unknown as WatermarkState).lastConsolidatedCount).toBe(2)
  })
})

// ─── Error propagation ────────────────────────────────────────────────────

describe("runPhase2 error propagation", () => {
  test("port throws plain Error → wraps as Phase2ConsolidateError", async () => {
    const log = makeLog()
    const err = (await runPhase2(
      baseInput(),
      makePort({ throws: new Error("LLM 500") }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    ).catch((e: unknown) => e)) as Phase2ConsolidateError
    expect(err).toBeInstanceOf(Phase2ConsolidateError)
    expect(err.mode).toBe("incremental")
    expect(err.message).toContain("LLM 500")
    expect(log.writeAtomic).toBe(0)
    expect(log.setWatermark).toBe(0)
  })

  test("port throws Phase2ConsolidateError → rethrows verbatim", async () => {
    const log = makeLog()
    const orig = new Phase2ConsolidateError("inner", "INIT")
    const err = await runPhase2(
      baseInput({ mode: "INIT" }),
      makePort({ throws: orig }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    ).catch((e: unknown) => e)
    expect(err).toBe(orig)
  })

  test("memoryMd cap exceeded → Phase2ConsolidateError before writer", async () => {
    const log = makeLog()
    const oversize = "x".repeat(MEMORY_MAX_BYTES + 1)
    const err = (await runPhase2(
      baseInput(),
      makePort({ custom: { ...goodPortOut, memoryMd: oversize } }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    ).catch((e: unknown) => e)) as Phase2ConsolidateError
    expect(err).toBeInstanceOf(Phase2ConsolidateError)
    expect(err.message).toContain("MEMORY_MAX_BYTES")
    expect(log.writeAtomic).toBe(0)
  })

  test("memorySummaryMd cap exceeded → Phase2ConsolidateError before writer", async () => {
    const log = makeLog()
    const oversize = "y".repeat(MEMORY_SUMMARY_MAX_BYTES + 1)
    const err = (await runPhase2(
      baseInput(),
      makePort({ custom: { ...goodPortOut, memorySummaryMd: oversize } }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    ).catch((e: unknown) => e)) as Phase2ConsolidateError
    expect(err.message).toContain("MEMORY_SUMMARY_MAX_BYTES")
    expect(log.writeAtomic).toBe(0)
  })

  test("rawMemoriesMd is uncapped (huge value succeeds)", async () => {
    const log = makeLog()
    const huge = "z".repeat(MEMORY_MAX_BYTES * 2)
    const res = await runPhase2(
      baseInput(),
      makePort({ custom: { ...goodPortOut, rawMemoriesMd: huge } }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(res.kind).toBe("consolidated")
  })

  test("writer throws MemoryWriteError → propagates", async () => {
    const log = makeLog()
    const writerErr = new MemoryWriteError("disk full", "/mem")
    const err = await runPhase2(
      baseInput(),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      makeWriter(log, { throws: writerErr }),
    ).catch((e: unknown) => e)
    expect(err).toBe(writerErr)
    expect(log.setWatermark).toBe(0)
  })

  test("setWatermark throws WatermarkConflictError → propagates after write", async () => {
    const log = makeLog()
    const conflict = new WatermarkConflictError("stale")
    const store = makeStore(emptyWatermark, log, { setThrows: conflict })
    const err = await runPhase2(
      baseInput(),
      makePort({ ok: goodPortOut }, log),
      store,
      makeWriter(log),
    ).catch((e: unknown) => e)
    expect(err).toBe(conflict)
    expect(log.writeAtomic).toBe(1)
  })
})

// ─── Argument propagation into ports ───────────────────────────────────────

describe("runPhase2 argument plumbing", () => {
  test("port.consolidate receives stage1Entries verbatim", async () => {
    const log = makeLog()
    let observed: ReadonlyArray<Stage1Output> | null = null
    const port: Phase2Port = {
      async consolidate(args) {
        log.consolidate++
        log.order.push("consolidate")
        observed = args.stage1Entries
        return goodPortOut
      },
    }
    const entries = [stage1("aa"), stage1("bb")]
    await runPhase2(
      baseInput({ stage1Entries: entries }),
      port,
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(observed as readonly Stage1Output[] | null).toBe(entries)
  })

  test("port.consolidate receives existingMemoryMd / mode", async () => {
    const log = makeLog()
    let captured: Parameters<Phase2Port["consolidate"]>[0] | null = null
    const port: Phase2Port = {
      async consolidate(args) {
        log.consolidate++
        log.order.push("consolidate")
        captured = args
        return goodPortOut
      },
    }
    await runPhase2(
      baseInput({
        existingMemoryMd: "PRIOR",
        existingRawMemoriesMd: "RAW-PRIOR",
        mode: "INIT",
      }),
      port,
      makeStore(emptyWatermark, log),
      makeWriter(log),
    )
    expect(captured).not.toBeNull()
    const c = captured as unknown as Parameters<Phase2Port["consolidate"]>[0]
    expect(c.existingMemoryMd).toBe("PRIOR")
    expect(c.existingRawMemoriesMd).toBe("RAW-PRIOR")
    expect(c.mode).toBe("INIT")
  })

  test("writer.writeAtomic receives the LLM-produced content verbatim", async () => {
    const log = makeLog()
    let observed: { memoryMd: string; rawMemoriesMd: string; memorySummaryMd: string } | null = null
    const writer = {
      async writeAtomic(content: {
        memoryMd: string
        rawMemoriesMd: string
        memorySummaryMd: string
      }) {
        log.writeAtomic++
        log.order.push("writeAtomic")
        observed = content
        return { gitCommitSha: "x" }
      },
    } as unknown as MemoryWriter
    await runPhase2(
      baseInput(),
      makePort({ ok: goodPortOut }, log),
      makeStore(emptyWatermark, log),
      writer,
    )
    expect(
      observed as { memoryMd: string; rawMemoriesMd: string; memorySummaryMd: string } | null,
    ).toEqual({
      memoryMd: goodPortOut.memoryMd,
      rawMemoriesMd: goodPortOut.rawMemoriesMd,
      memorySummaryMd: goodPortOut.memorySummaryMd,
    })
  })
})
