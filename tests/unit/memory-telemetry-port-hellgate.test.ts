/**
 * ★ HELLGATE — S6-Memory MemoryTelemetryPort + observability adapter.
 *
 * Adversarial proofs of the anti-leak invariant: counts + latencies + outcome
 * enums are the ONLY data crossing the port surface. Entry content, score
 * values, ranked results, query text — NONE may leak.
 *
 * Surface under test:
 *   - src/memory/telemetry-port.ts (port + no-op + allow-lists)
 *   - src/observability/memory-telemetry.ts (MetricsRegistry adapter)
 *   - src/memory/consolidate/phase1.ts (telemetry?: wiring)
 *   - src/memory/consolidate/phase2.ts (telemetry?: wiring)
 *   - src/memory/ranking.ts (telemetry?: wiring)
 */

import { describe, expect, test } from "bun:test"
import {
  FORBIDDEN_TELEMETRY_KEYS,
  type MemoryTelemetryPort,
  noopMemoryTelemetry,
  PHASE1_EVENT_ALLOWED_KEYS,
  PHASE2_EVENT_ALLOWED_KEYS,
  type Phase1OutcomeKind,
  type Phase1TelemetryEvent,
  type Phase2OutcomeKind,
  type Phase2TelemetryEvent,
  RECALL_EVENT_ALLOWED_KEYS,
  type RecallTelemetryEvent,
  rankEntries,
} from "@/memory"
import { runPhase1 } from "@/memory/consolidate/phase1"
import { runPhase2 } from "@/memory/consolidate/phase2"
import {
  Phase1DistillError,
  type Phase1Input,
  type Phase1Port,
  Phase2ConsolidateError,
  type Phase2Input,
  type Phase2Port,
  type Stage1Output,
  type Stage1StorePort,
  type WatermarkState,
} from "@/memory/consolidate/types"
import type { MemoryWriter } from "@/memory/consolidate/writer"
import type { MemoryEntry, MemoryQuery } from "@/memory/types"
import { buildMemoryTelemetry, MEMORY_TELEMETRY_KEYS } from "@/observability/memory-telemetry"
import type { MetricSnapshot, MetricsRegistry } from "@/observability/metrics/port"
import { nth } from "../_helpers/expect-present"

// ─── Test fakes ────────────────────────────────────────────────────────────

/** Recording port that captures every event verbatim for assertions. */
function recordingPort(): {
  port: MemoryTelemetryPort
  phase1: Phase1TelemetryEvent[]
  phase2: Phase2TelemetryEvent[]
  recall: RecallTelemetryEvent[]
} {
  const phase1: Phase1TelemetryEvent[] = []
  const phase2: Phase2TelemetryEvent[] = []
  const recall: RecallTelemetryEvent[] = []
  return {
    port: {
      recordPhase1: (e) => phase1.push(e),
      recordPhase2: (e) => phase2.push(e),
      recordRecall: (e) => recall.push(e),
    },
    phase1,
    phase2,
    recall,
  }
}

/** In-memory MetricsRegistry stub — just enough surface for the adapter. */
function fakeRegistry(): {
  registry: MetricsRegistry
  increments: { name: string; delta: number; labels?: Record<string, string> }[]
  observations: { name: string; value: number; labels?: Record<string, string> }[]
} {
  const increments: { name: string; delta: number; labels?: Record<string, string> }[] = []
  const observations: { name: string; value: number; labels?: Record<string, string> }[] = []
  const registry: MetricsRegistry = {
    increment(name, delta = 1, labels) {
      increments.push({ name, delta, ...(labels ? { labels } : {}) })
    },
    observe(name, value, labels) {
      observations.push({ name, value, ...(labels ? { labels } : {}) })
    },
    gauge(_name, _value, _labels) {
      /* unused in this adapter */
    },
    snapshot(): ReadonlyArray<MetricSnapshot> {
      return []
    },
    reset() {
      increments.length = 0
      observations.length = 0
    },
    async flush() {},
  }
  return { registry, increments, observations }
}

/** Stage1 store stub that succeeds on upsert + watermark. */
function fakeStage1Store(): Stage1StorePort {
  let watermark: WatermarkState = {
    lastSuccessAt: null,
    lastInitAt: null,
    lastConsolidatedCount: 0,
  }
  return {
    async upsert(_row) {},
    async fetchSince(_w, _limit) {
      return []
    },
    async countSince(_w) {
      return 0
    },
    async getWatermark() {
      return watermark
    },
    async setWatermark(next) {
      watermark = next
    },
  }
}

function fakeWriter(): MemoryWriter {
  return {
    async writeAtomic(_args: { memoryMd: string; rawMemoriesMd: string; memorySummaryMd: string }) {
      return { gitCommitSha: null }
    },
  } as unknown as MemoryWriter
}

function phase1InputSuccess(overrides?: Partial<Phase1Input>): Phase1Input {
  let t = 1000
  return {
    threadId: "thread-a",
    sessionId: "session-a",
    rolloutMessages: [{ role: "user", content: "hi" }],
    turnCount: 5,
    memoryMode: "enabled",
    now: () => {
      t += 10
      return t
    },
    ...overrides,
  }
}

function phase2InputSuccess(overrides?: Partial<Phase2Input>): Phase2Input {
  let t = 1000
  const stage1: Stage1Output = {
    threadId: "t-1",
    rolloutSlug: "slug",
    rolloutSummary: "summary",
    rawMemory: "raw",
    preferenceSignals: [],
    sourceUpdatedAt: 1000,
    selectedForPhase2: true,
    selectedForPhase2SourceUpdatedAt: 1000,
    lastUsage: null,
    usageCount: 0,
  }
  return {
    stage1Entries: [stage1],
    existingMemoryMd: null,
    existingRawMemoriesMd: null,
    existingMemorySummaryMd: null,
    mode: "incremental",
    lastSuccessWatermark: null,
    now: () => {
      t += 5
      return t
    },
    ...overrides,
  }
}

function distillPort(): Phase1Port {
  return {
    async distill() {
      return { rolloutSummary: "ok", rawMemory: "raw", preferenceSignals: [] }
    },
  }
}

function consolidatePort(): Phase2Port {
  return {
    async consolidate() {
      return { memoryMd: "m", rawMemoriesMd: "r", memorySummaryMd: "s" }
    },
  }
}

// ─── Group 1 — port surface + no-op + Default-OFF ────────────────────────

describe("MemoryTelemetryPort surface", () => {
  test("noopMemoryTelemetry is frozen and all methods are no-throw", () => {
    expect(Object.isFrozen(noopMemoryTelemetry)).toBe(true)
    expect(() =>
      noopMemoryTelemetry.recordPhase1({ outcome: "stored", turnsConsumed: 1, latencyMs: 1 }),
    ).not.toThrow()
    expect(() =>
      noopMemoryTelemetry.recordPhase2({
        outcome: "incremental_ok",
        filesProcessed: 1,
        latencyMs: 1,
      }),
    ).not.toThrow()
    expect(() =>
      noopMemoryTelemetry.recordRecall({ hits: 0, totalScanned: 0, latencyMs: 0 }),
    ).not.toThrow()
  })

  test("Default-OFF: phase1 with no telemetry parameter does not throw", async () => {
    const out = await runPhase1(phase1InputSuccess(), distillPort(), fakeStage1Store())
    expect(out.kind).toBe("distilled")
  })

  test("Default-OFF: phase2 with no telemetry parameter does not throw", async () => {
    const out = await runPhase2(
      phase2InputSuccess(),
      consolidatePort(),
      fakeStage1Store(),
      fakeWriter(),
    )
    expect(out.kind).toBe("consolidated")
  })

  test("Default-OFF: rankEntries with no telemetry parameter behaves identically", () => {
    const candidates: MemoryEntry[] = [
      {
        id: "a",
        kind: "fact",
        text: "alpha",
        tier: "semantic",
        importance: 0.5,
        createdAt: 1000,
        updatedAt: 1000,
        tags: ["x"],
        accessCount: 0,
      },
    ]
    const query: MemoryQuery = { tags: ["x"] }
    const rec = recordingPort()
    const a = rankEntries(candidates, query, 2000)
    const b = rankEntries(candidates, query, 2000, rec.port)
    expect(a).toEqual(b)
    expect(rec.recall).toHaveLength(1)
    expect(rec.recall[0]).toMatchObject({ hits: 1, totalScanned: 1 })
  })
})

// ─── Group 2 — Anti-leak: forbidden keys NEVER appear ───────────────────

describe("anti-leak: forbidden keys never cross the port boundary", () => {
  test("FORBIDDEN_TELEMETRY_KEYS contains the content-plane allow-list", () => {
    // Sanity: structural invariant — these are the keys that would indicate
    // memory entry content / score leaked through the seam.
    for (const k of ["content", "score", "entries", "text", "body", "patterns", "redacted"]) {
      expect(FORBIDDEN_TELEMETRY_KEYS.has(k)).toBe(true)
    }
  })

  test("FORBIDDEN and allow-list sets do not overlap (phase1)", () => {
    for (const k of FORBIDDEN_TELEMETRY_KEYS) {
      expect(PHASE1_EVENT_ALLOWED_KEYS.has(k)).toBe(false)
    }
  })

  test("FORBIDDEN and allow-list sets do not overlap (phase2)", () => {
    for (const k of FORBIDDEN_TELEMETRY_KEYS) {
      expect(PHASE2_EVENT_ALLOWED_KEYS.has(k)).toBe(false)
    }
  })

  test("FORBIDDEN and allow-list sets do not overlap (recall)", () => {
    for (const k of FORBIDDEN_TELEMETRY_KEYS) {
      expect(RECALL_EVENT_ALLOWED_KEYS.has(k)).toBe(false)
    }
  })

  test("phase1 emit: every event key is within the allow-list", async () => {
    const rec = recordingPort()
    await runPhase1(phase1InputSuccess(), distillPort(), fakeStage1Store(), rec.port)
    expect(rec.phase1.length).toBe(1)
    for (const ev of rec.phase1) {
      for (const k of Object.keys(ev)) {
        expect(PHASE1_EVENT_ALLOWED_KEYS.has(k)).toBe(true)
        expect(FORBIDDEN_TELEMETRY_KEYS.has(k)).toBe(false)
      }
    }
  })

  test("phase2 emit: every event key is within the allow-list", async () => {
    const rec = recordingPort()
    await runPhase2(
      phase2InputSuccess(),
      consolidatePort(),
      fakeStage1Store(),
      fakeWriter(),
      rec.port,
    )
    expect(rec.phase2.length).toBe(1)
    for (const ev of rec.phase2) {
      for (const k of Object.keys(ev)) {
        expect(PHASE2_EVENT_ALLOWED_KEYS.has(k)).toBe(true)
        expect(FORBIDDEN_TELEMETRY_KEYS.has(k)).toBe(false)
      }
    }
  })

  test("recall emit: every event key is within the allow-list", () => {
    const rec = recordingPort()
    const candidates: MemoryEntry[] = [
      {
        id: "a",
        kind: "fact",
        text: "alpha-secret",
        tier: "semantic",
        importance: 0.5,
        createdAt: 1000,
        updatedAt: 1000,
        tags: ["x"],
        accessCount: 0,
      },
    ]
    rankEntries(candidates, { tags: ["x"] }, 2000, rec.port)
    expect(rec.recall.length).toBe(1)
    for (const ev of rec.recall) {
      for (const k of Object.keys(ev)) {
        expect(RECALL_EVENT_ALLOWED_KEYS.has(k)).toBe(true)
        expect(FORBIDDEN_TELEMETRY_KEYS.has(k)).toBe(false)
      }
    }
  })

  test("recall emit: entry text NEVER appears in any event field", () => {
    const rec = recordingPort()
    const SECRET = "SECRET-CANARY-9b8c7a"
    const candidates: MemoryEntry[] = [
      {
        id: "a",
        kind: "fact",
        text: SECRET,
        tier: "semantic",
        importance: 0.5,
        createdAt: 1000,
        updatedAt: 1000,
        tags: ["x"],
        accessCount: 0,
      },
    ]
    rankEntries(candidates, { tags: ["x"], text: SECRET }, 2000, rec.port)
    const serialized = JSON.stringify(rec.recall)
    expect(serialized).not.toContain(SECRET)
  })
})

// ─── Group 3 — Outcome enum mapping ──────────────────────────────────────

describe("outcome enum mapping (phase1)", () => {
  test("phase1 'stored' on happy path", async () => {
    const rec = recordingPort()
    await runPhase1(phase1InputSuccess(), distillPort(), fakeStage1Store(), rec.port)
    const e = nth(rec.phase1, 0, "e")
    expect(e.outcome).toBe("stored")
    expect(e.turnsConsumed).toBe(5)
    expect(e.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test("phase1 'skipped' on memory_mode disabled", async () => {
    const rec = recordingPort()
    await runPhase1(
      phase1InputSuccess({ memoryMode: "disabled" }),
      distillPort(),
      fakeStage1Store(),
      rec.port,
    )
    expect(nth(rec.phase1, 0, "rec.phase1").outcome).toBe("skipped")
  })

  test("phase1 'skipped' on thread_id empty", async () => {
    const rec = recordingPort()
    await runPhase1(
      phase1InputSuccess({ threadId: "" }),
      distillPort(),
      fakeStage1Store(),
      rec.port,
    )
    expect(nth(rec.phase1, 0, "rec.phase1").outcome).toBe("skipped")
  })

  test("phase1 'skipped' on turns below threshold", async () => {
    const rec = recordingPort()
    await runPhase1(
      phase1InputSuccess({ turnCount: 1 }),
      distillPort(),
      fakeStage1Store(),
      rec.port,
    )
    expect(nth(rec.phase1, 0, "rec.phase1").outcome).toBe("skipped")
  })

  test("phase1 'error' when distill throws", async () => {
    const rec = recordingPort()
    const failingPort: Phase1Port = {
      async distill() {
        throw new Error("boom")
      },
    }
    await expect(
      runPhase1(phase1InputSuccess(), failingPort, fakeStage1Store(), rec.port),
    ).rejects.toThrow(Phase1DistillError)
    expect(nth(rec.phase1, 0, "rec.phase1").outcome).toBe("error")
  })

  test("phase1 'error' when store upsert throws", async () => {
    const rec = recordingPort()
    const badStore: Stage1StorePort = {
      ...fakeStage1Store(),
      async upsert() {
        throw new Error("db dead")
      },
    }
    await expect(
      runPhase1(phase1InputSuccess(), distillPort(), badStore, rec.port),
    ).rejects.toThrow("db dead")
    expect(nth(rec.phase1, 0, "rec.phase1").outcome).toBe("error")
  })
})

describe("outcome enum mapping (phase2)", () => {
  test("phase2 'incremental_ok' on incremental happy path", async () => {
    const rec = recordingPort()
    await runPhase2(
      phase2InputSuccess(),
      consolidatePort(),
      fakeStage1Store(),
      fakeWriter(),
      rec.port,
    )
    expect(nth(rec.phase2, 0, "rec.phase2").outcome).toBe("incremental_ok")
    expect(nth(rec.phase2, 0, "rec.phase2").filesProcessed).toBe(1)
  })

  test("phase2 'full_ok' on INIT happy path", async () => {
    const rec = recordingPort()
    await runPhase2(
      phase2InputSuccess({ mode: "INIT" }),
      consolidatePort(),
      fakeStage1Store(),
      fakeWriter(),
      rec.port,
    )
    expect(nth(rec.phase2, 0, "rec.phase2").outcome).toBe("full_ok")
  })

  test("phase2 'no_op' on incremental with zero entries", async () => {
    const rec = recordingPort()
    await runPhase2(
      phase2InputSuccess({ stage1Entries: [] }),
      consolidatePort(),
      fakeStage1Store(),
      fakeWriter(),
      rec.port,
    )
    expect(nth(rec.phase2, 0, "rec.phase2").outcome).toBe("no_op")
    expect(nth(rec.phase2, 0, "rec.phase2").filesProcessed).toBe(0)
  })

  test("phase2 'error' when port throws", async () => {
    const rec = recordingPort()
    const failing: Phase2Port = {
      async consolidate() {
        throw new Error("model down")
      },
    }
    await expect(
      runPhase2(phase2InputSuccess(), failing, fakeStage1Store(), fakeWriter(), rec.port),
    ).rejects.toThrow(Phase2ConsolidateError)
    expect(nth(rec.phase2, 0, "rec.phase2").outcome).toBe("error")
  })
})

// ─── Group 4 — Adapter emits the right OTel keys ──────────────────────────

describe("buildMemoryTelemetry adapter", () => {
  test("phase1 stored emits outcome counter + latency histogram + turns counter", () => {
    const { registry, increments, observations } = fakeRegistry()
    const port = buildMemoryTelemetry(registry)
    port.recordPhase1({ outcome: "stored", turnsConsumed: 7, latencyMs: 42 })
    expect(increments).toContainEqual({
      name: "quanta.memory.phase1.outcome",
      delta: 1,
      labels: { outcome: "stored" },
    })
    expect(increments).toContainEqual({ name: "quanta.memory.phase1.turns", delta: 7 })
    expect(observations).toContainEqual({ name: "quanta.memory.phase1.e2e_ms", value: 42 })
  })

  test("phase1 tokensIn/Out emitted only when present", () => {
    const a = fakeRegistry()
    buildMemoryTelemetry(a.registry).recordPhase1({
      outcome: "stored",
      turnsConsumed: 1,
      latencyMs: 1,
    })
    const tokenNames = a.increments.map((i) => i.name)
    expect(tokenNames).not.toContain("quanta.memory.phase1.tokens_in")
    expect(tokenNames).not.toContain("quanta.memory.phase1.tokens_out")

    const b = fakeRegistry()
    buildMemoryTelemetry(b.registry).recordPhase1({
      outcome: "stored",
      turnsConsumed: 1,
      latencyMs: 1,
      tokensIn: 100,
      tokensOut: 50,
    })
    expect(b.increments).toContainEqual({ name: "quanta.memory.phase1.tokens_in", delta: 100 })
    expect(b.increments).toContainEqual({ name: "quanta.memory.phase1.tokens_out", delta: 50 })
  })

  test("phase2 incremental_ok emits outcome counter + e2e histogram + stage1_count counter", () => {
    const { registry, increments, observations } = fakeRegistry()
    buildMemoryTelemetry(registry).recordPhase2({
      outcome: "incremental_ok",
      filesProcessed: 12,
      latencyMs: 200,
    })
    expect(increments).toContainEqual({
      name: "quanta.memory.phase2.outcome",
      delta: 1,
      labels: { outcome: "incremental_ok" },
    })
    expect(increments).toContainEqual({ name: "quanta.memory.phase2.stage1_count", delta: 12 })
    expect(observations).toContainEqual({ name: "quanta.memory.phase2.e2e_ms", value: 200 })
  })

  test("recall emits hits, scanned, latency_ms — NO score/text keys", () => {
    const { registry, increments, observations } = fakeRegistry()
    buildMemoryTelemetry(registry).recordRecall({ hits: 3, totalScanned: 50, latencyMs: 1.5 })
    expect(increments).toContainEqual({ name: "quanta.memory.recall.hits", delta: 3 })
    expect(increments).toContainEqual({ name: "quanta.memory.recall.scanned", delta: 50 })
    expect(observations).toContainEqual({ name: "quanta.memory.recall.latency_ms", value: 1.5 })
    const allNames = [...increments.map((i) => i.name), ...observations.map((o) => o.name)]
    for (const name of allNames) {
      expect(name).not.toContain("score")
      expect(name).not.toContain("content")
      expect(name).not.toContain("text")
    }
  })

  test("MEMORY_TELEMETRY_KEYS lists every key the adapter writes", () => {
    const { registry, increments, observations } = fakeRegistry()
    const port = buildMemoryTelemetry(registry)
    // Drive every branch.
    const allP1: Phase1OutcomeKind[] = ["stored", "merged", "rejected", "skipped", "error"]
    for (const o of allP1) {
      port.recordPhase1({ outcome: o, turnsConsumed: 1, latencyMs: 1, tokensIn: 1, tokensOut: 1 })
    }
    const allP2: Phase2OutcomeKind[] = ["incremental_ok", "full_ok", "no_op", "error"]
    for (const o of allP2) {
      port.recordPhase2({
        outcome: o,
        filesProcessed: 1,
        latencyMs: 1,
        tokensIn: 1,
        tokensOut: 1,
      })
    }
    port.recordRecall({ hits: 1, totalScanned: 1, latencyMs: 1 })

    const observed = new Set<string>()
    for (const i of increments) observed.add(i.name)
    for (const o of observations) observed.add(o.name)
    for (const k of MEMORY_TELEMETRY_KEYS) {
      expect(observed.has(k)).toBe(true)
    }
    // And nothing extra (allow-list discipline).
    for (const k of observed) {
      expect(MEMORY_TELEMETRY_KEYS).toContain(k)
    }
  })
})

// ─── Group 5 — Sink-throw resilience ──────────────────────────────────────

describe("sink resilience", () => {
  test("phase1 swallows telemetry sink throws on success path", async () => {
    const throwingPort: MemoryTelemetryPort = {
      recordPhase1() {
        throw new Error("sink dead")
      },
      recordPhase2() {},
      recordRecall() {},
    }
    const out = await runPhase1(
      phase1InputSuccess(),
      distillPort(),
      fakeStage1Store(),
      throwingPort,
    )
    expect(out.kind).toBe("distilled")
  })

  test("phase2 swallows telemetry sink throws on success path", async () => {
    const throwingPort: MemoryTelemetryPort = {
      recordPhase1() {},
      recordPhase2() {
        throw new Error("sink dead")
      },
      recordRecall() {},
    }
    const out = await runPhase2(
      phase2InputSuccess(),
      consolidatePort(),
      fakeStage1Store(),
      fakeWriter(),
      throwingPort,
    )
    expect(out.kind).toBe("consolidated")
  })

  test("rankEntries swallows telemetry sink throws", () => {
    const throwingPort: MemoryTelemetryPort = {
      recordPhase1() {},
      recordPhase2() {},
      recordRecall() {
        throw new Error("sink dead")
      },
    }
    const candidates: MemoryEntry[] = [
      {
        id: "a",
        kind: "fact",
        text: "x",
        tier: "semantic",
        importance: 0.5,
        createdAt: 1000,
        updatedAt: 1000,
        tags: ["x"],
        accessCount: 0,
      },
    ]
    expect(() => rankEntries(candidates, { tags: ["x"] }, 2000, throwingPort)).not.toThrow()
  })
})
