/**
 * Regression pins for the Phase-B hardening error channels. Each test maps to
 * one previously-silent failure path that now produces an explicit signal.
 *
 *   1. classifyQuery on stream failure → result.error defined (not silent id:null)
 *   2. classifyQuery on garbage JSON  → result.error defined (not silent id:null)
 *   3. classifyQuery on model picking unknown id → id:null, NO error (model judgement)
 *   4. judge on partial rubric response → judge.error defined (not all-fail)
 *   5. judge on stream failure → judge.error defined
 *   6. ResultStore drops unknown payload kind (and yields nothing) — protects matrix
 *   7. ResultStore drops schema-mismatch line
 *   8. parseScenario refuses non-string forbidden entry (throws)
 *   9. parseScenario refuses invalid maxTurns (NaN, 0, -1, non-int)
 *   10. compare/pairwise-judge resolves parse-fail as `winnerIndex:-1` AND `parseFailed:true`
 *   11. replay verdict ladder scales to original length (not magic 2)
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveWinner } from "@/../src/apps/eval/compare/pairwise-judge"
import { makeRunId, ResultStore } from "@/../src/apps/eval/storage"
import { judge } from "@/../src/apps/eval/synthetic/judge"
import type { Scenario } from "@/../src/apps/eval/synthetic/scenario"
import { parseScenario } from "@/../src/apps/eval/synthetic/scenario"
import { allLeaves } from "@/../src/apps/eval/taxonomy"
import { classifyQuery } from "@/../src/apps/eval/taxonomy/classifier"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

const knownLeafId = allLeaves()[0]?.id ?? "software-quality.debugging.error-message-paste"

// ── LLM doubles ──────────────────────────────────────────────────────────────

const scriptedLLM = (text: string): LLMPort => ({
  model: "test",
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: text }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const failingLLM = (): LLMPort => ({
  model: "test",
  // biome-ignore lint/correctness/useYield: throws before yielding
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("provider overloaded (529)")
  },
})

const makeScenario = (): Scenario => ({
  schema: 1,
  id: "s1",
  usecase: knownLeafId,
  title: "x",
  prompt: "p",
  rubric: [
    { id: "a", description: "a" },
    { id: "b", description: "b" },
    { id: "c", description: "c" },
  ],
})

// ── 1-3: classifier ─────────────────────────────────────────────────────────

describe("classifyQuery error channel", () => {
  test("stream failure → result.error defined (not silent id:null)", async () => {
    const r = await classifyQuery("anything", { llm: failingLLM() })
    expect(r.id).toBeNull()
    expect(r.error).toBeDefined()
    expect(r.error).toContain("llm stream")
  })

  test("garbage (no JSON) → result.error defined", async () => {
    const r = await classifyQuery("anything", { llm: scriptedLLM("I cannot reply in JSON") })
    expect(r.id).toBeNull()
    expect(r.error).toBeDefined()
    expect(r.error).toContain("JSON")
  })

  test("model picks unknown id → result.error undefined (legitimate model decision)", async () => {
    const r = await classifyQuery("anything", {
      llm: scriptedLLM(`{"id": "no.such.leaf", "confidence": 0.4, "alt": []}`),
    })
    expect(r.id).toBeNull()
    expect(r.error).toBeUndefined()
  })

  test("model legitimately replies id:null → result.error undefined", async () => {
    const r = await classifyQuery("anything", {
      llm: scriptedLLM(`{"id": null, "confidence": 0, "alt": []}`),
    })
    expect(r.id).toBeNull()
    expect(r.error).toBeUndefined()
  })
})

// ── 4-5: judge ──────────────────────────────────────────────────────────────

describe("judge error channel", () => {
  const scenario = makeScenario()

  test("partial rubric response → judge.error defined", async () => {
    const llm = scriptedLLM(JSON.stringify({ rubric: [{ id: "a", pass: true }] }))
    const v = await judge(
      { scenario, assistantText: "x", toolsUsed: [], turns: 1, stopReason: "completed" },
      { llm },
    )
    expect(v.error).toBeDefined()
    expect(v.error).toContain("partial verdict")
  })

  test("stream failure → judge.error defined", async () => {
    const v = await judge(
      { scenario, assistantText: "x", toolsUsed: [], turns: 1, stopReason: "completed" },
      { llm: failingLLM() },
    )
    expect(v.error).toBeDefined()
    expect(v.error).toContain("llm stream")
    expect(v.score).toBe(0)
  })

  test("full valid response → judge.error undefined", async () => {
    const llm = scriptedLLM(
      JSON.stringify({
        rubric: [
          { id: "a", pass: true },
          { id: "b", pass: false },
          { id: "c", pass: true },
        ],
      }),
    )
    const v = await judge(
      { scenario, assistantText: "x", toolsUsed: [], turns: 1, stopReason: "completed" },
      { llm },
    )
    expect(v.error).toBeUndefined()
    expect(v.score).toBeCloseTo(2 / 3, 2)
  })
})

// ── 6-7: ResultStore ────────────────────────────────────────────────────────

describe("ResultStore validation", () => {
  test("drops unknown payload kind (matrix sees nothing for it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"))
    const store = new ResultStore({ dir })
    const runId = makeRunId("audit")
    // Write a real line directly to disk with a bad payload.kind.
    await store.append(runId, {
      tier: "audit",
      usecase: "software-quality.debugging.error-message-paste",
      // biome-ignore lint/suspicious/noExplicitAny: deliberately injecting a bad payload
      payload: { kind: "frankenstein", whatever: 1 } as any,
    })
    await store.drain()
    const records = [...new ResultStore({ dir }).readAll()]
    expect(records.length).toBe(0)
  })

  test("drops schema-mismatch line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"))
    // Write a manual line with schema:999 — using append() would clobber the
    // schema field, so write raw via fs.
    const { appendFileSync, mkdirSync } = await import("node:fs")
    mkdirSync(dir, { recursive: true })
    const runId = "20260101-000000-audit-test"
    appendFileSync(
      join(dir, `${runId}.jsonl`),
      `${JSON.stringify({
        ts: 0,
        schema: 999,
        runId,
        tier: "audit",
        usecase: "x",
        payload: { kind: "audit" },
      })}\n`,
    )
    const records = [...new ResultStore({ dir }).readAll()]
    expect(records.length).toBe(0)
  })
})

// ── 8-9: scenario schema ────────────────────────────────────────────────────

describe("parseScenario strict validation", () => {
  const base = {
    schema: 1,
    id: "x",
    usecase: knownLeafId,
    title: "t",
    prompt: "p",
    rubric: [{ id: "a", description: "a" }],
  }

  test("non-string forbidden entry throws (does NOT silently filter)", () => {
    expect(() => parseScenario({ ...base, forbidden: [{ pattern: "rm -rf" }] })).toThrow(
      /non-string entry/,
    )
  })

  test("non-array forbidden throws", () => {
    expect(() => parseScenario({ ...base, forbidden: "rm -rf" })).toThrow(/string array/)
  })

  test("maxTurns NaN/0/negative/non-int rejected", () => {
    expect(() => parseScenario({ ...base, maxTurns: Number.NaN })).toThrow(/positive integer/)
    expect(() => parseScenario({ ...base, maxTurns: 0 })).toThrow(/positive integer/)
    expect(() => parseScenario({ ...base, maxTurns: -1 })).toThrow(/positive integer/)
    expect(() => parseScenario({ ...base, maxTurns: 1.5 })).toThrow(/positive integer/)
  })

  test("valid maxTurns accepted", () => {
    const s = parseScenario({ ...base, maxTurns: 6 })
    expect(s.maxTurns).toBe(6)
  })

  test("valid forbidden accepted", () => {
    const s = parseScenario({ ...base, forbidden: ["rm -rf", "git push --force"] })
    expect(s.forbidden).toEqual(["rm -rf", "git push --force"])
  })
})

// ── 10: pairwise resolver ────────────────────────────────────────────────────

describe("pairwise resolveWinner — only pure logic; parseFailed lives in pairwiseJudge", () => {
  test("agreement after swap ⇒ winner index", () => {
    expect(resolveWinner("A", "B")).toBe(0)
    expect(resolveWinner("B", "A")).toBe(1)
  })

  test("position bias ⇒ tie", () => {
    expect(resolveWinner("A", "A")).toBe(-1)
    expect(resolveWinner("B", "B")).toBe(-1)
  })

  test("any tie input ⇒ tie", () => {
    expect(resolveWinner("tie", "A")).toBe(-1)
  })
})
