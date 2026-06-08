/**
 * ADR-0087 — additive eval schema fields (Cursor EvalTracking absorption §7.3).
 *
 * Verifies the new OPTIONAL fields are non-breaking on the REAL on-disk path:
 *  (a) records WITHOUT the new fields survive a write→read round-trip,
 *  (b) records WITH metrics[]/tokens/costUsd/status/params survive intact,
 *  (d) Metric.unit / Metric.step are optional (absent fields stay absent).
 * (c) zod round-trip is N/A — schema.ts is plain TS interfaces, no zod.
 *
 * There is no zod parser, but the JSONL append-only store IS the production
 * (de)serializer: `ResultStore.append`/`finish` write a line via JSON.stringify
 * and `readRunRecords`/`readRunSummary` parse + validate it back. Routing the
 * round-trips through that store (instead of a no-op JSON.parse(JSON.stringify)
 * on a test-local literal) means a regression in the store's envelope stamping,
 * line framing, or validation drop-rules is actually caught here.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type {
  Metric,
  PublicPayload,
  RunSummaryRecord,
  SyntheticPayload,
  TokenUsage,
} from "@/../src/apps/eval/storage/schema"
import { ResultStore, makeRunId } from "@/../src/apps/eval/storage/result-store"

describe("ADR-0087 eval schema additive fields", () => {
  let dir: string
  let store: ResultStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-additive-"))
    store = new ResultStore({ dir, now: () => 1_700_000_000_000 })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(a) synthetic/public payloads WITHOUT new fields survive write→read", async () => {
    const syn: SyntheticPayload = {
      kind: "synthetic",
      scenarioId: "pure-function-tests",
      verdict: "pass",
      score: 1,
      rubric: [{ name: "covers-happy-path", pass: true }],
      toolsUsed: ["Read", "Write"],
      durationMs: 1234,
    }
    const pub: PublicPayload = {
      kind: "public",
      bench: "swebench-verified",
      instanceId: "astropy__astropy-12345",
      verdict: "fail",
      durationMs: 9000,
    }
    const synRun = makeRunId("synthetic", () => 1_700_000_000_000, () => "aaaa0001")
    const pubRun = makeRunId("public", () => 1_700_000_000_000, () => "bbbb0001")
    await store.append(synRun, { tier: "synthetic", usecase: "uc", payload: syn })
    await store.append(pubRun, { tier: "public", usecase: "uc", payload: pub })

    const [synBack] = [...store.readRunRecords(synRun)]
    const [pubBack] = [...store.readRunRecords(pubRun)]
    expect(synBack?.payload).toEqual(syn)
    expect(pubBack?.payload).toEqual(pub)
    // Optional additive fields are genuinely absent after the on-disk round-trip.
    expect((synBack?.payload as SyntheticPayload).metrics).toBeUndefined()
    expect((pubBack?.payload as PublicPayload).tokens).toBeUndefined()
  })

  test("(b) payloads WITH metrics[]/tokens/costUsd survive write→read", async () => {
    const tokens: TokenUsage = { prompt: 1200, completion: 340, cacheRead: 800 }
    const metrics: readonly Metric[] = [
      { key: "judge.helpfulness", value: 0.92 },
      { key: "tokens.per_turn", value: 512, unit: "tokens", step: 3 },
    ]
    const syn: SyntheticPayload = {
      kind: "synthetic",
      scenarioId: "s1",
      verdict: "pass",
      rubric: [],
      toolsUsed: [],
      durationMs: 10,
      metrics,
      tokens,
      costUsd: 0.0123,
    }
    const pub: PublicPayload = {
      kind: "public",
      bench: "swebench-verified",
      instanceId: "i1",
      verdict: "pass",
      durationMs: 20,
      metrics,
      tokens,
      costUsd: 0.5,
    }
    const synRun = makeRunId("synthetic", () => 1_700_000_000_000, () => "aaaa0002")
    const pubRun = makeRunId("public", () => 1_700_000_000_000, () => "bbbb0002")
    await store.append(synRun, { tier: "synthetic", usecase: "uc", payload: syn })
    await store.append(pubRun, { tier: "public", usecase: "uc", payload: pub })

    const [synBack] = [...store.readRunRecords(synRun)] as { payload: SyntheticPayload }[]
    const [pubBack] = [...store.readRunRecords(pubRun)] as { payload: PublicPayload }[]
    expect(synBack?.payload).toEqual(syn)
    expect(pubBack?.payload).toEqual(pub)
    expect(synBack?.payload.tokens?.cacheRead).toBe(800)
    expect(synBack?.payload.metrics?.[1]?.unit).toBe("tokens")
    expect(pubBack?.payload.costUsd).toBe(0.5)
  })

  test("(b) RunSummaryRecord WITH status/params survives; WITHOUT stays valid", async () => {
    const baseRun = makeRunId("synthetic", () => 1_700_000_000_000, () => "cccc0001")
    const base: Omit<RunSummaryRecord, "ts" | "schema"> = {
      runId: baseRun,
      tier: "synthetic",
      argv: ["eval", "synthetic"],
      counts: { pass: 3, partial: 0, fail: 1, error: 0, skipped: 0 },
      durationMs: 5000,
    }
    await store.finish(base)
    const baseBack = store.readRunSummary(baseRun)
    expect(baseBack?.counts).toEqual(base.counts)
    expect(baseBack?.status).toBeUndefined()
    expect(baseBack?.params).toBeUndefined()

    const enrichedRun = makeRunId("synthetic", () => 1_700_000_000_000, () => "cccc0002")
    const enriched: Omit<RunSummaryRecord, "ts" | "schema"> = {
      ...base,
      runId: enrichedRun,
      status: "finished",
      params: { model: "claude-opus-4-7", temperature: 0, seed: 42, plan: true },
    }
    await store.finish(enriched)
    const back = store.readRunSummary(enrichedRun)
    expect(back?.status).toBe("finished")
    expect(back?.params?.seed).toBe(42)
    expect(back?.params?.plan).toBe(true)
  })

  test("(d) Metric.unit and Metric.step are optional through the on-disk round-trip", async () => {
    const minimal: Metric = { key: "k", value: 1 }
    const full: Metric = { key: "k", value: 1, unit: "ms", step: 7 }
    const runId = makeRunId("synthetic", () => 1_700_000_000_000, () => "dddd0001")
    const payload: SyntheticPayload = {
      kind: "synthetic",
      scenarioId: "metric-optionality",
      verdict: "pass",
      rubric: [],
      toolsUsed: [],
      durationMs: 1,
      metrics: [minimal, full],
    }
    await store.append(runId, { tier: "synthetic", usecase: "uc", payload })

    const [back] = [...store.readRunRecords(runId)] as { payload: SyntheticPayload }[]
    const m = back?.payload.metrics
    expect(m?.[0]?.unit).toBeUndefined()
    expect(m?.[0]?.step).toBeUndefined()
    expect(m?.[1]?.unit).toBe("ms")
    expect(m?.[1]?.step).toBe(7)
  })
})
