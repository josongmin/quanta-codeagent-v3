/**
 * `compose(stages)` — pure DAG composer for SearchPipeline (ADR-0265).
 *
 * Reduces a `Stage[]` to a `SearchPipeline` by recursively evaluating each
 * stage at search-time. Every join is duck-typed (see `types.ts`), so the
 * composer never imports a sibling slice file (slice fence — ADR-0159 / our
 * own constraint).
 *
 * Behaviour:
 *   - `compose([])` returns a pipeline that resolves to Err("empty-pipeline").
 *   - `compose([s])` evaluates `s` and returns its hits, capped at `query.k`.
 *   - `compose([s1, s2, ...])` is treated as a SEQUENCE: each stage takes the
 *     previous stage's hits as its inner population (for `rerank`) or runs as
 *     an independent source (for `lexical` / `semantic`). When the array has
 *     multiple INDEPENDENT sources, callers should wrap them in an explicit
 *     `{ kind: "rrf", inputs: [...] }` node — the linear-array case ships only
 *     the last stage's result for predictability.
 *
 * Pure: no clock, no I/O of its own. Every dependency comes through the Stage
 * union or the caller-injected ports.
 *
 * Cognitive-complexity note: the runner switch is intentionally flat — each
 * arm is a 3-5 line block, and the exhaustiveness is enforced by the explicit
 * `Err("unknown-stage")` default that also serves as the runtime mirror of
 * the compile-time `never` (HELL-PI-12).
 */

import { byteCompare, err, ok, type Result } from "@/shared"
import type { PipelineError, SearchHit, SearchPipeline, SearchQuery, Stage } from "./types"

/** Cormack-2009 published constant. See ADR-0265 §3. */
export const RRF_K = 60

const RUNTIME_OK_KINDS = new Set(["lexical", "semantic", "rerank", "rrf", "budget-gate"])

/**
 * Inline RRF fusion. We DO NOT import the sibling `score-fusion-rrf` module —
 * the slice constraint forbids it — but the formula and the published k=60
 * are byte-identical (no-heuristics-only-validated).
 */
const fuseByRrf = (lists: ReadonlyArray<readonly SearchHit[]>, k: number): readonly SearchHit[] => {
  const acc = new Map<string, { rep: SearchHit; score: number }>()
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const c = list[rank]
      if (c === undefined) continue
      const delta = 1 / (k + rank + 1)
      const prev = acc.get(c.id)
      if (prev !== undefined) {
        prev.score += delta
      } else {
        acc.set(c.id, { rep: c, score: delta })
      }
    }
  }
  const out: SearchHit[] = []
  for (const { rep, score } of acc.values()) {
    out.push({ ...rep, score, source: "fused" })
  }
  out.sort((a, b) => (b.score !== a.score ? b.score - a.score : byteCompare(a.id, b.id)))
  return out
}

const capK = (hits: readonly SearchHit[], k: number): readonly SearchHit[] => {
  if (k <= 0) return []
  if (k >= hits.length) return hits
  return hits.slice(0, k)
}

type StageResult = Result<readonly SearchHit[], PipelineError>

const runLexical = async (
  stage: Extract<Stage, { kind: "lexical" }>,
  query: SearchQuery,
): Promise<StageResult> => {
  try {
    const hits = await stage.impl.search(query)
    return ok(hits.map((h) => ({ ...h, source: h.source ?? "lexical" })))
  } catch (cause) {
    return err({ kind: "stage-failed", stage: "lexical", cause })
  }
}

const resolveEmbedding = async (
  stage: Extract<Stage, { kind: "semantic" }>,
  text: string,
): Promise<readonly number[]> => {
  const cached = stage.cache?.get(text)
  if (cached !== undefined) return cached
  let vec: readonly number[]
  if (stage.batcher !== undefined) {
    const out = await stage.batcher.embedBatched([text], stage.embedder)
    vec = out[0] ?? []
  } else {
    vec = await stage.embedder.embed(text)
  }
  if (stage.cache !== undefined) stage.cache.set(text, vec)
  return vec
}

const runSemantic = async (
  stage: Extract<Stage, { kind: "semantic" }>,
  query: SearchQuery,
): Promise<StageResult> => {
  try {
    const vec = await resolveEmbedding(stage, query.text)
    const hits = await stage.impl.query(vec, query.k)
    return ok(hits.map((h) => ({ ...h, source: h.source ?? "semantic" })))
  } catch (cause) {
    return err({ kind: "stage-failed", stage: "semantic", cause })
  }
}

const runRerank = async (
  stage: Extract<Stage, { kind: "rerank" }>,
  query: SearchQuery,
): Promise<StageResult> => {
  const inner = await runStage(stage.inner, query)
  if (!inner.ok) return inner
  try {
    const reranked = await stage.impl.rerank(query.text, inner.value)
    return ok(reranked.map((h) => ({ ...h, source: "reranked" as const })))
  } catch (cause) {
    return err({ kind: "stage-failed", stage: "rerank", cause })
  }
}

const runRrf = async (
  stage: Extract<Stage, { kind: "rrf" }>,
  query: SearchQuery,
): Promise<StageResult> => {
  if (stage.inputs.length === 0) {
    return err({ kind: "invalid-config", reason: "rrf requires at least one input" })
  }
  const lists: (readonly SearchHit[])[] = []
  for (const sub of stage.inputs) {
    const r = await runStage(sub, query)
    if (!r.ok) return r
    lists.push(r.value)
  }
  return ok(fuseByRrf(lists, stage.k ?? RRF_K))
}

const runBudgetGate = async (
  stage: Extract<Stage, { kind: "budget-gate" }>,
  query: SearchQuery,
): Promise<StageResult> => {
  const spent = stage.probe.usdSoFar()
  if (spent >= stage.maxUsd) {
    return err({ kind: "budget-exceeded", maxUsd: stage.maxUsd, usdSoFar: spent })
  }
  return runStage(stage.inner, query)
}

/** Resolve one stage to its hits. Recursive over `rrf` / `rerank` / `budget-gate`. */
const runStage = async (stage: Stage, query: SearchQuery): Promise<StageResult> => {
  // RUNTIME exhaustiveness mirror — catches a future arm shipped via
  // cast-through-unknown before the compile-time `never` would fire.
  if (!RUNTIME_OK_KINDS.has((stage as { kind: string }).kind)) {
    return err({ kind: "unknown-stage", tag: String((stage as { kind: string }).kind) })
  }
  switch (stage.kind) {
    case "lexical":
      return runLexical(stage, query)
    case "semantic":
      return runSemantic(stage, query)
    case "rerank":
      return runRerank(stage, query)
    case "rrf":
      return runRrf(stage, query)
    case "budget-gate":
      return runBudgetGate(stage, query)
  }
}

/**
 * Pure DAG composer.
 *
 * Accepts a sequence of `Stage` nodes and returns a `SearchPipeline`. For a
 * single-stage array we run that stage; for multi-stage arrays we run them in
 * declaration order, threading the LAST stage's result to the caller (the
 * caller composes parallel sources explicitly via a `{ kind: "rrf" }` node).
 * The empty-array case is the well-known boundary error.
 */
export const compose = (stages: readonly Stage[]): SearchPipeline => {
  return {
    async search(query: SearchQuery) {
      if (query.k === 0) return ok([] as const)
      if (stages.length === 0) return err({ kind: "empty-pipeline" })
      let last: readonly SearchHit[] = []
      for (const stage of stages) {
        const r = await runStage(stage, query)
        if (!r.ok) return r
        last = r.value
      }
      return ok(capK(last, query.k))
    },
  }
}
