/**
 * ADR-0216 hellgate — `Stage1StorePortV2` adversarial battery (12 cases).
 *
 * Covers:
 *   - in-memory + sqlite parity (round-trip semantics match)
 *   - write upsert: re-write REPLACES (per Stage1Store semantics)
 *   - read of missing thread → ok:true value:null (not an error)
 *   - read with empty threadId → invalid-input
 *   - incrementUsageCount on missing thread → not-found
 *   - incrementUsageCount is monotonic (+1 each call)
 *   - selectForPhase2 marks flag + bumps usage_count + skips unknown ids
 *   - default-OFF parity: write→read round-trips outcome enum + evidence
 *   - exactOptional: omitted outcome stays absent (no `field: undefined`)
 *   - empty threadId on write → invalid-input
 *   - SQLite adapter survives schema migration twice (idempotent)
 *   - selectForPhase2 with empty input → empty output (no throw)
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { Stage1StorePortV2, WriteInput } from "@/agent/memory/stage1-store"
import { inMemoryStage1Store, sqliteStage1Store } from "@/agent/memory/stage1-store"

const baseWrite = (over: Partial<WriteInput> = {}): WriteInput => ({
  threadId: "thr-1",
  rolloutSlug: "20260525-101010-test",
  rolloutSummary: "summary",
  rawMemory: "raw",
  preferenceSignals: ["bun"],
  generatedAt: 1_000_000,
  ...over,
})

const both = (): { mem: Stage1StorePortV2; sql: Stage1StorePortV2; db: Database } => {
  const db = new Database(":memory:")
  return { mem: inMemoryStage1Store(), sql: sqliteStage1Store(db), db }
}

describe("ADR-0216 — Stage1StorePortV2 adversarial battery", () => {
  test("[1] write then read round-trips the record (in-memory)", async () => {
    const s = inMemoryStage1Store()
    const w = await s.write(baseWrite())
    expect(w.ok).toBe(true)
    if (!w.ok) throw new Error("unreachable")
    expect(w.value.threadId).toBe("thr-1")
    expect(w.value.usageCount).toBe(0)
    expect(w.value.selectedForPhase2).toBe(false)
    const r = await s.read("thr-1")
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).not.toBeNull()
    expect(r.value!.threadId).toBe("thr-1")
  })

  test("[2] sqlite parity — write then read matches in-memory semantics", async () => {
    const { mem, sql } = both()
    await mem.write(baseWrite())
    await sql.write(baseWrite())
    const mr = await mem.read("thr-1")
    const sr = await sql.read("thr-1")
    if (!mr.ok || !sr.ok) throw new Error("unreachable")
    if (mr.value === null || sr.value === null) throw new Error("missing")
    expect(mr.value.threadId).toBe(sr.value.threadId)
    expect(mr.value.rolloutSummary).toBe(sr.value.rolloutSummary)
    expect(mr.value.usageCount).toBe(sr.value.usageCount)
  })

  test("[3] re-write REPLACES prior row (upsert semantics)", async () => {
    const s = inMemoryStage1Store()
    await s.write(baseWrite({ rolloutSummary: "v1" }))
    await s.write(baseWrite({ rolloutSummary: "v2" }))
    const r = await s.read("thr-1")
    if (!r.ok) throw new Error("unreachable")
    expect(r.value!.rolloutSummary).toBe("v2")
  })

  test("[4] read of missing thread → ok:true value:null", async () => {
    const s = inMemoryStage1Store()
    const r = await s.read("ghost")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBeNull()
  })

  test("[5] read with empty threadId → invalid-input", async () => {
    const s = inMemoryStage1Store()
    const r = await s.read("")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe("invalid-input")
  })

  test("[6] incrementUsageCount on missing thread → not-found", async () => {
    const s = inMemoryStage1Store()
    const r = await s.incrementUsageCount("ghost")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe("not-found")
  })

  test("[7] incrementUsageCount monotonic +1 each call", async () => {
    const s = inMemoryStage1Store()
    await s.write(baseWrite())
    await s.incrementUsageCount("thr-1")
    await s.incrementUsageCount("thr-1")
    await s.incrementUsageCount("thr-1")
    const r = await s.read("thr-1")
    if (!r.ok) throw new Error("unreachable")
    expect(r.value!.usageCount).toBe(3)
  })

  test("[8] selectForPhase2 marks flag + bumps usage_count + skips unknown ids", async () => {
    const s = inMemoryStage1Store()
    await s.write(baseWrite({ threadId: "thr-a" }))
    await s.write(baseWrite({ threadId: "thr-b" }))
    const sel = await s.selectForPhase2(["thr-a", "ghost", "thr-b"])
    if (!sel.ok) throw new Error("unreachable")
    expect(sel.value).toHaveLength(2)
    const a = await s.read("thr-a")
    if (!a.ok || a.value === null) throw new Error("unreachable")
    expect(a.value.selectedForPhase2).toBe(true)
    expect(a.value.usageCount).toBe(1)
  })

  test("[9] write with outcome+evidence round-trips (in-memory + sqlite)", async () => {
    const { mem, sql } = both()
    const input = baseWrite({
      outcome: "success",
      outcomeEvidence: "src/foo.ts:42",
    })
    await mem.write(input)
    await sql.write(input)
    const mr = await mem.read("thr-1")
    const sr = await sql.read("thr-1")
    if (!mr.ok || !sr.ok || mr.value === null || sr.value === null) throw new Error("unreachable")
    expect(mr.value.outcome).toBe("success")
    expect(sr.value.outcome).toBe("success")
    expect(mr.value.outcomeEvidence).toBe("src/foo.ts:42")
    expect(sr.value.outcomeEvidence).toBe("src/foo.ts:42")
  })

  test("[10] exactOptional: omitted outcome stays absent on the record", async () => {
    const s = inMemoryStage1Store()
    await s.write(baseWrite()) // no outcome / outcomeEvidence
    const r = await s.read("thr-1")
    if (!r.ok || r.value === null) throw new Error("unreachable")
    expect(Object.hasOwn(r.value, "outcome")).toBe(false)
    expect(Object.hasOwn(r.value, "outcomeEvidence")).toBe(false)
  })

  test("[11] empty threadId on write → invalid-input", async () => {
    const s = inMemoryStage1Store()
    const r = await s.write(baseWrite({ threadId: "" }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe("invalid-input")
  })

  test("[12] SQLite adapter survives construction twice over same DB (idempotent migration)", () => {
    const db = new Database(":memory:")
    expect(() => sqliteStage1Store(db)).not.toThrow()
    expect(() => sqliteStage1Store(db)).not.toThrow()
  })

  test("[13] selectForPhase2 with empty input → empty output (no throw)", async () => {
    const s = inMemoryStage1Store()
    const r = await s.selectForPhase2([])
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toHaveLength(0)
  })
})
