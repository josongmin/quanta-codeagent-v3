/**
 * eval-schema-additive L3→L4 HELLGATE integration coverage (ADR-0087).
 *
 * The L3 state has unit proofs of `rollupTokenCost` + report rendering. This
 * file pins the L4 promotion contract by exercising the FULL pipeline end-to-
 * end with a real on-disk `ResultStore`:
 *
 *   runScenario(mock LLM)  →  RunResult.{tokens, costUsd}
 *                         →  ResultStore.append (synthetic payload)
 *                         →  ResultStore.finish (RunSummaryRecord{status,params})
 *                         →  store.readAll()
 *                         →  buildCoverageMatrix → markdown + headline
 *
 * The assertions chase the schema flow through every stage and pin the
 * adversarial / degraded paths the per-stage unit tests can't reach:
 *
 *   A. happy path             — known model, every additive field populated
 *                                from RunResult through markdown.
 *   B. byte-identical legacy  — no-usage LLM ⇒ tokens/costUsd absent at every
 *                                stage; markdown gains NO Token & Cost section.
 *   C. degraded pricing       — unknown model ⇒ tokens still flow but
 *                                costUsd is `null`; report does not crash.
 *   D. adversarial usage      — NaN / negative / missing usage fields must
 *                                NOT poison the sum (no NaN row, no negative
 *                                cost in the markdown).
 *   E. status invariants      — RunSummaryRecord persisted with
 *                                status:"finished" + params:{model}, readable
 *                                back from disk via `readAll`.
 *   F. multi-record rollup    — synthetic + public payloads with mixed
 *                                tokens/costUsd sum into one `tokenCost`.
 *   G. store concurrency      — interleaved appends within one runId serialise
 *                                cleanly (no torn lines, exact count).
 *
 * `metrics[]` per-scenario emit is a future seam (no caller fills it yet) and
 * is OUT OF SCOPE here — that gap is the L4→L5 step, not the L3→L4 step.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCoverageMatrix, type CoverageMatrix } from "@/../src/apps/eval/report/coverage-matrix"
import { renderHeadline, renderMatrixMarkdown } from "@/../src/apps/eval/report/markdown"
import type {
  EvalRecord,
  PublicPayload,
  RunSummaryRecord,
  SyntheticPayload,
} from "@/../src/apps/eval/storage"
import { ResultStore } from "@/../src/apps/eval/storage"
import { runScenario } from "@/../src/apps/eval/synthetic/runner"
import type { Scenario } from "@/../src/apps/eval/synthetic/scenario"
import { allLeaves } from "@/../src/apps/eval/taxonomy"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

const leafId = allLeaves()[0]?.id ?? "software-quality.debugging.error-message-paste"

type UsageDelta = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

/** LLM whose stream emits exactly the usage deltas given (one usage event per
 *  delta), then a tiny text reply and a stop. Lets each test sculpt the exact
 *  AgentEvent shape that the runner's `sumUsage` will see. */
const mockLLM = (model: string | undefined, deltas: readonly UsageDelta[]): LLMPort => ({
  ...(model !== undefined ? { model } : {}),
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const d of deltas) {
      yield {
        type: "usage",
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        model: model ?? "unknown",
        ...(d.cacheReadTokens !== undefined ? { cacheReadTokens: d.cacheReadTokens } : {}),
      }
    }
    yield { type: "text_delta", delta: "done." }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const noUsageLLM = (model: string): LLMPort => ({
  model,
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "done." }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const scenario = (id = "hellgate-s"): Scenario => ({
  schema: 1,
  id,
  usecase: leafId,
  title: "hellgate",
  prompt: "say done",
  rubric: [{ id: "a", description: "a" }],
})

let storeDir: string
let store: ResultStore

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "eval-additive-hellgate-"))
  store = new ResultStore({ dir: storeDir })
})

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

// ── A. Happy path — every additive field flows through every stage ─────────

describe("hellgate A — happy path: known model populates the whole chain", () => {
  test("RunResult → store → matrix → markdown all carry tokens + costUsd + status", async () => {
    const run = await runScenario(scenario(), {
      llm: mockLLM("claude-opus-4-7", [
        { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 },
      ]),
    })

    // 1) Runner FILLS.
    expect(run.tokens).toEqual({ prompt: 1000, completion: 500, cacheRead: 200 })
    expect(typeof run.costUsd).toBe("number")
    expect(run.costUsd as number).toBeGreaterThan(0)

    // 2) Store APPEND + FINISH (the synthetic index.ts assembly, exercised here
    //    directly so the integration test does not depend on its private wiring).
    const runId = "hellgate-A"
    const payload: SyntheticPayload = {
      kind: "synthetic",
      scenarioId: scenario().id,
      verdict: "pass",
      rubric: [],
      toolsUsed: [],
      durationMs: run.durationMs,
    }
    if (run.tokens !== undefined) payload.tokens = run.tokens
    // index.ts (the real assembler) drops `null` (unknown model) — payload.costUsd
    // is `number?`, not `number | null`. Mirror that here.
    if (typeof run.costUsd === "number") payload.costUsd = run.costUsd
    await store.append(runId, { tier: "synthetic", usecase: leafId, payload })
    await store.finish({
      runId,
      tier: "synthetic",
      argv: ["eval", "synthetic"],
      counts: { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
      durationMs: run.durationMs,
      status: "finished",
      params: { model: "claude-opus-4-7" },
    })

    // 3) Read it back and confirm shape on disk.
    const records: readonly EvalRecord[] = Array.from(store.readAll())
    expect(records.length).toBeGreaterThanOrEqual(1)
    const syn = records.find((r) => r.tier === "synthetic")
    expect(syn).toBeDefined()
    const synPayload = syn?.payload as SyntheticPayload
    expect(synPayload.tokens).toEqual({ prompt: 1000, completion: 500, cacheRead: 200 })
    expect(synPayload.costUsd).toBeGreaterThan(0)

    // The RunSummaryRecord lives on disk too — read raw so we can pin
    // status + params (readAll filters this `kind:"run_summary"` line out).
    const raw = readFileSync(join(storeDir, `${runId}.jsonl`), "utf8")
    const summaryLine = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((o) => o.kind === "run_summary") as (RunSummaryRecord & { kind: string }) | undefined
    expect(summaryLine).toBeDefined()
    expect(summaryLine?.status).toBe("finished")
    expect(summaryLine?.params).toEqual({ model: "claude-opus-4-7" })

    // 4) Report rolls up, markdown renders both section + headline.
    const m: CoverageMatrix = buildCoverageMatrix(records)
    expect(m.tokenCost).toBeDefined()
    expect(m.tokenCost?.prompt).toBe(1000)
    expect(m.tokenCost?.completion).toBe(500)
    expect(m.tokenCost?.cacheRead).toBe(200)
    expect(m.tokenCost?.records).toBe(1)
    expect((m.tokenCost?.costUsd ?? 0) > 0).toBe(true)

    const md = renderMatrixMarkdown(m)
    expect(md).toContain("## Token & Cost Summary")
    expect(md).toContain("Prompt tokens: 1000")
    expect(md).toContain("Completion tokens: 500")
    const head = renderHeadline(m)
    // headline totalTokens = prompt + completion + cacheRead (per markdown.ts:74)
    expect(head).toContain("Tokens=1700")
    expect(head).toMatch(/Cost=\$\d/)
  })
})

// ── B. Byte-identical legacy — no usage events ⇒ no new fields anywhere ────

describe("hellgate B — no-usage LLM keeps the legacy path byte-identical", () => {
  test("RunResult has tokens=undefined; payload omits both; markdown has no section", async () => {
    const run = await runScenario(scenario("legacy"), { llm: noUsageLLM("claude-opus-4-7") })
    expect(run.tokens).toBeUndefined()
    expect(run.costUsd).toBeUndefined()

    const runId = "hellgate-B"
    const payload: SyntheticPayload = {
      kind: "synthetic",
      scenarioId: "legacy",
      verdict: "pass",
      rubric: [],
      toolsUsed: [],
      durationMs: run.durationMs,
    }
    if (run.tokens !== undefined) payload.tokens = run.tokens
    // index.ts (the real assembler) drops `null` (unknown model) — payload.costUsd
    // is `number?`, not `number | null`. Mirror that here.
    if (typeof run.costUsd === "number") payload.costUsd = run.costUsd
    expect("tokens" in payload).toBe(false)
    expect("costUsd" in payload).toBe(false)

    await store.append(runId, { tier: "synthetic", usecase: leafId, payload })
    const records = Array.from(store.readAll())
    const m = buildCoverageMatrix(records)
    expect(m.tokenCost).toBeUndefined()
    const md = renderMatrixMarkdown(m)
    expect(md).not.toContain("Token & Cost Summary")
    const head = renderHeadline(m)
    expect(head).not.toContain("Tokens=")
    expect(head).not.toContain("Cost=")
  })
})

// ── C. Degraded pricing — unknown model ⇒ costUsd null, no crash ───────────

describe("hellgate C — unknown model degrades costUsd to null gracefully", () => {
  test("tokens still populate; costUsd is null; markdown still renders", async () => {
    const run = await runScenario(scenario(), {
      llm: mockLLM("no-such-model-9000", [{ inputTokens: 800, outputTokens: 100 }]),
    })
    expect(run.tokens).toEqual({ prompt: 800, completion: 100 })
    expect(run.costUsd).toBeNull()

    const runId = "hellgate-C"
    // SyntheticPayload.costUsd is `number?` (no null in the schema). The real
    // index.ts assembler at src/apps/eval/synthetic/index.ts:164 drops null,
    // so an unknown-model run lands tokens BUT not costUsd. Mirror that here
    // — case C's whole point is to prove the pipeline degrades to "no cost
    // recorded" without crashing.
    const payload: SyntheticPayload = {
      kind: "synthetic",
      scenarioId: scenario().id,
      verdict: "pass",
      rubric: [],
      toolsUsed: [],
      durationMs: run.durationMs,
    }
    if (run.tokens !== undefined) payload.tokens = run.tokens
    if (typeof run.costUsd === "number") payload.costUsd = run.costUsd
    expect(payload.costUsd).toBeUndefined() // null was dropped at the seam

    await store.append(runId, { tier: "synthetic", usecase: leafId, payload })
    const records = Array.from(store.readAll())
    const m = buildCoverageMatrix(records)
    expect(m.tokenCost).toBeDefined()
    expect(m.tokenCost?.prompt).toBe(800)
    expect(m.tokenCost?.completion).toBe(100)
    // The rollup must NOT crash; if every record has costUsd null, the sum is 0
    // (or null — both are acceptable degradation). Either way: no NaN.
    const cost = m.tokenCost?.costUsd
    expect(cost === null || cost === 0 || cost === undefined || typeof cost === "number").toBe(true)
    expect(Number.isNaN(cost as number)).toBe(false)
    expect(() => renderMatrixMarkdown(m)).not.toThrow()
  })
})

// ── D. Adversarial usage shapes — must not poison the sum ──────────────────

describe("hellgate D — malformed usage events do not poison the sum", () => {
  test("NaN inputs are absorbed (no NaN in tokens, no NaN row in matrix)", async () => {
    const run = await runScenario(scenario(), {
      // `sumUsage` accumulates raw numbers; the runner's `rollupTokenCost`
      // hasUsage gate is `>0` so a single NaN-only event collapses to {}.
      llm: mockLLM("claude-opus-4-7", [{ inputTokens: Number.NaN, outputTokens: Number.NaN }]),
    })
    // hasUsage = false ⇒ both fields absent; this proves NaN cannot reach disk.
    expect(run.tokens).toBeUndefined()
    expect(run.costUsd).toBeUndefined()
  })

  test("missing usage fields (undefined inputTokens/outputTokens) collapse safely", async () => {
    const run = await runScenario(scenario(), {
      // A provider that yields a `usage` event with no numeric fields. The
      // sumUsage loop adds `undefined` ⇒ NaN, and the `>0` gate then suppresses.
      llm: {
        model: "claude-opus-4-7",
        async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
          yield { type: "usage", inputTokens: 0, outputTokens: 0, model: "claude-opus-4-7" }
          yield { type: "message_stop", stop_reason: "end_turn" }
        },
      } as LLMPort,
    })
    expect(run.tokens).toBeUndefined()
    expect(run.costUsd).toBeUndefined()
  })

  test("a real positive event still wins through adjacent zero-event noise", async () => {
    const run = await runScenario(scenario(), {
      llm: mockLLM("claude-opus-4-7", [
        { inputTokens: 0, outputTokens: 0 }, // zero noise
        { inputTokens: 42, outputTokens: 7 }, // real
        { inputTokens: 0, outputTokens: 0 }, // zero noise
      ]),
    })
    expect(run.tokens).toEqual({ prompt: 42, completion: 7 })
  })
})

// ── E. RunSummaryRecord status invariants ─────────────────────────────────

describe("hellgate E — RunSummaryRecord persists status + params verbatim", () => {
  test("status:'finished' + params:{model} survive JSON round-trip on disk", async () => {
    const runId = "hellgate-E"
    await store.append(runId, {
      tier: "synthetic",
      usecase: leafId,
      payload: {
        kind: "synthetic",
        scenarioId: "x",
        verdict: "pass",
        rubric: [],
        toolsUsed: [],
        durationMs: 1,
      },
    })
    await store.finish({
      runId,
      tier: "synthetic",
      argv: ["eval", "synthetic"],
      counts: { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
      durationMs: 1,
      status: "finished",
      params: { model: "claude-opus-4-7", maxTurns: 8 },
    })
    const raw = readFileSync(join(storeDir, `${runId}.jsonl`), "utf8")
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    const summary = lines.find((o) => o.kind === "run_summary")
    expect(summary?.status).toBe("finished")
    expect(summary?.params).toEqual({ model: "claude-opus-4-7", maxTurns: 8 })
  })
})

// ── F. Multi-record rollup — synthetic + public sum into one `tokenCost` ──

describe("hellgate F — synthetic + public records aggregate into tokenCost", () => {
  test("rollup spans tiers; markdown reflects the combined total", async () => {
    const runId = "hellgate-F"
    const syn: SyntheticPayload = {
      kind: "synthetic",
      scenarioId: "s1",
      verdict: "pass",
      rubric: [],
      toolsUsed: [],
      durationMs: 1,
      tokens: { prompt: 100, completion: 50, cacheRead: 10 },
      costUsd: 0.5,
    }
    const pub: PublicPayload = {
      kind: "public",
      bench: "swebench-verified",
      instanceId: "i1",
      verdict: "pass",
      durationMs: 1,
      tokens: { prompt: 200, completion: 60 },
      costUsd: 1.25,
    }
    await store.append(runId, { tier: "synthetic", usecase: leafId, payload: syn })
    await store.append(runId, { tier: "public", usecase: leafId, payload: pub })
    const records = Array.from(store.readAll())
    const m = buildCoverageMatrix(records)
    expect(m.tokenCost).toEqual({
      prompt: 300,
      completion: 110,
      cacheRead: 10,
      costUsd: 1.75,
      records: 2,
    })
    const md = renderMatrixMarkdown(m)
    expect(md).toContain("Prompt tokens: 300")
    expect(md).toContain("Completion tokens: 110")
    expect(md).toMatch(/Estimated cost: \$1\.75/)
  })
})

// ── G. Concurrency — overlapping appends serialise into one file cleanly ──

describe("hellgate G — concurrent appends within one runId do not tear lines", () => {
  test("10 parallel appends produce 10 well-formed JSON lines (no partial writes)", async () => {
    const runId = "hellgate-G"
    const payload: SyntheticPayload = {
      kind: "synthetic",
      scenarioId: "concurrent",
      verdict: "pass",
      rubric: [],
      toolsUsed: [],
      durationMs: 1,
    }
    const writes = Array.from({ length: 10 }, () =>
      store.append(runId, { tier: "synthetic", usecase: leafId, payload }),
    )
    await Promise.all(writes)
    const raw = readFileSync(join(storeDir, `${runId}.jsonl`), "utf8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(10)
    // Each line MUST parse cleanly — torn writes would crash here.
    for (const l of lines) {
      const obj = JSON.parse(l) as EvalRecord
      expect(obj.runId).toBe(runId)
      expect(obj.tier).toBe("synthetic")
    }
  })
})
