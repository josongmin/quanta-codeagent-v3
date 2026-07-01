/**
 * jul-02 OFFLINE Best@K-vs-Pass@K ceiling analyzer (pure leaf + injected effects).
 *
 * The repair-BREADTH loop generates B candidate patches per round and ADOPTS only
 * the selector's winner; the observe sink ({@link ../../runner/batch/eval/repair/candidate-ledger-sink})
 * persists the WHOLE pool under `repair-candidates/<instanceId>/cand-r<round>-i<index>.patch`.
 * Best@K = the run's officially-resolved set (=`report.resolved_ids`, the winner that
 * was actually submitted). Pass@K = would ANY pooled candidate — across every round /
 * index — have officially resolved had it been submitted? The gap Pass@K − Best@K is
 * the selector's missed-winner ceiling: how much a perfect oracle-selector could add.
 *
 * This is an OFFLINE, OBSERVE-ONLY job: it re-grades the pooled candidates through the
 * SAME official harness backend (SERIAL, `max_workers: 1` — concurrent grading is a
 * known false-negative source) and NEVER touches the live batch report / submission
 * path. It is gated OFF by default (QUANTA_BENCH_BESTK_PASSK); the subcommand exits
 * with usage when the gate is unset, so the live pipeline stays byte-identical.
 *
 * PURE CORE + INJECTED EDGES: `scanCandidatePool` / `buildSlotPredictions` /
 * `aggregateBestKPassK` are pure; every fs read + `backend.grade` + `writePredictions`
 * is injected so the whole flow is a leaf unit (fast typecheck/test, no docker/harness,
 * no full build). fail-loud throughout — no silent skips, no fallbacks.
 */

import type { GradeBackend, GradeOptions, GradeOutcome } from "../remote/backend"

/** One pooled candidate located on disk: `<instanceId>` from the dir, `{round,index}`
 *  from the filename, and the absolute path to its `.patch`. */
export interface PooledCandidate {
  readonly round: number
  readonly index: number
  readonly patchPath: string
}

/** A grading "slot" = a (round, index) coordinate shared across instances. Each slot
 *  becomes ONE predictions.jsonl (≤1 row per instance) so the harness grades a full
 *  cross-instance batch per slot. NOTE: the slot is ONLY a batching convenience — it is
 *  NOT a semantic alignment (candidateIndex is generation-order within a round's
 *  fan-out, not comparable across instances), so aggregation is per-instance OR, never
 *  per-slot. */
export interface SlotKey {
  readonly round: number
  readonly index: number
}

/** Injected filesystem surface — keeps the module a pure leaf (tests inject an
 *  in-memory map; the real subcommand injects node:fs). */
export interface CandidatePoolFs {
  /** Immediate entries (names) of a directory. MUST throw if the dir is absent
   *  (fail-loud — a missing observe root is an operator error, not empty pool). */
  readonly listDir: (dir: string) => readonly string[]
  /** Read a file's UTF-8 text. MUST throw on absence (fail-loud). */
  readonly readText: (path: string) => string
}

/** The `cand-r<round>-i<index>.patch` filename format — an EXACT mirror of the
 *  producer's literal in candidate-ledger-sink.ts (`cand-r${round}-i${i}.patch`),
 *  NOT a heuristic. Anchored so a non-matching name is a fail-loud error. */
const CAND_FILENAME_RE = /^cand-r(\d+)-i(\d+)\.patch$/

/**
 * Parse `{round,index}` from a candidate patch BASENAME. The instanceId is NEVER
 * parsed from the filename (it comes from the parent dir — see `scanCandidatePool`);
 * this only extracts the two integers the producer encodes in the name.
 *
 * fail-loud: a basename that does not match the exact producer format throws (a silent
 * skip would let a pool with a malformed/renamed file quietly under-count).
 */
export const parseCandFilename = (basename: string): { round: number; index: number } => {
  const m = CAND_FILENAME_RE.exec(basename)
  if (m === null) {
    throw new Error(
      `bestk-passk: candidate filename "${basename}" does not match the producer format ` +
        `cand-r<round>-i<index>.patch — refusing to guess (fail-loud).`,
    )
  }
  // Regex \d+ guarantees a valid non-negative integer parse.
  return { round: Number(m[1]), index: Number(m[2]) }
}

const CANDIDATES_DIRNAME = "repair-candidates"

/**
 * Scan `<observeRoot>/repair-candidates/<instanceId>/cand-r*-i*.patch` into a map
 * instanceId → pooled candidates. instanceId is the DIRECTORY name (the producer writes
 * `join(root,"repair-candidates",instanceId)`), the filename yields only `{round,index}`.
 *
 * fail-loud: a candidate filename that doesn't match the producer format throws
 * (via `parseCandFilename`). The `candidates.jsonl` sidecar is ignored (not a `.patch`).
 * An instance dir with zero `.patch` files contributes an empty array (kept, so a
 * pooled-but-empty instance is visible rather than silently dropped).
 */
export const scanCandidatePool = (
  observeRoot: string,
  fs: CandidatePoolFs,
): Map<string, PooledCandidate[]> => {
  const poolRoot = joinPath(observeRoot, CANDIDATES_DIRNAME)
  const out = new Map<string, PooledCandidate[]>()
  for (const instanceId of fs.listDir(poolRoot)) {
    const instDir = joinPath(poolRoot, instanceId)
    const cands: PooledCandidate[] = []
    for (const name of fs.listDir(instDir)) {
      if (!name.endsWith(".patch")) continue
      const { round, index } = parseCandFilename(name)
      cands.push({ round, index, patchPath: joinPath(instDir, name) })
    }
    out.set(instanceId, cands)
  }
  return out
}

/** Minimal path join (no node:path dep in the pure core). Normalizes to `/`. */
const joinPath = (a: string, b: string): string => `${a.replace(/\/+$/, "")}/${b}`

/** One official SWE-bench prediction row (mirror of corpus/dataset Prediction). */
export interface Prediction {
  readonly instance_id: string
  readonly model_name_or_path: string
  readonly model_patch: string
}

/** Predictions grouped by grading slot — each slot is one harness batch. */
export interface SlotPredictions {
  readonly slot: SlotKey
  readonly predictions: readonly Prediction[]
}

/**
 * Group the pool into per-slot prediction batches. For each distinct (round,index)
 * slot across ALL instances, emit one `Prediction` per instance that has a candidate
 * in that slot, using the REAL instance_id (NEVER a synthetic `<id>::rNiM` — the
 * harness joins predictions↔dataset by the real id; a synthetic id breaks the join
 * and the 00b-spec §4B synthetic-id guidance is explicitly rejected here).
 *
 * The patch body is read (injected `fs.readText`) from each candidate's `.patch`.
 * Slots are emitted in ascending (round, index) order for determinism.
 */
export const buildSlotPredictions = (
  pool: ReadonlyMap<string, readonly PooledCandidate[]>,
  modelName: string,
  fs: CandidatePoolFs,
): SlotPredictions[] => {
  // slotKey -> instanceId -> Prediction (dedupe: at most one candidate per instance
  // per slot, which the producer guarantees — one index per round per instance).
  const bySlot = new Map<string, { slot: SlotKey; rows: Prediction[] }>()
  const sortedInstances = [...pool.keys()].sort()
  for (const instanceId of sortedInstances) {
    for (const cand of pool.get(instanceId) ?? []) {
      const key = `r${cand.round}i${cand.index}`
      let bucket = bySlot.get(key)
      if (bucket === undefined) {
        bucket = { slot: { round: cand.round, index: cand.index }, rows: [] }
        bySlot.set(key, bucket)
      }
      bucket.rows.push({
        instance_id: instanceId,
        model_name_or_path: modelName,
        model_patch: fs.readText(cand.patchPath),
      })
    }
  }
  return [...bySlot.values()]
    .sort((a, b) => a.slot.round - b.slot.round || a.slot.index - b.slot.index)
    .map((b) => ({ slot: b.slot, predictions: b.rows }))
}

/** Result of the offline analysis. */
export interface BestKPassKResult {
  /** #distinct instances that had ≥1 pooled candidate. */
  readonly k: number
  /** #instances where ANY pooled candidate officially resolved (the ceiling). */
  readonly passK: number
  /** #instances the run actually submitted-and-resolved (=report.resolved_ids ∩ pool). */
  readonly bestK: number
  /** passK − bestK: the selector's missed-winner headroom. */
  readonly gap: number
  /** Instances that a pooled candidate would have resolved but the run did NOT
   *  submit-resolve — the concrete missed winners (sorted). */
  readonly missedWinners: readonly string[]
}

/**
 * Fold per-slot grade outcomes into Best@K / Pass@K. Pass@K counts an instance if ANY
 * of its pooled candidates (across every slot) officially resolved — a per-instance OR,
 * NOT a per-slot tally (slots are batching only, not comparable across instances).
 *
 * Best@K = the run's submitted-resolved set restricted to the pooled instances
 * (`submittedResolvedIds` = report.resolved_ids). fail-loud: every submitted-resolved
 * instance that is present in the pool MUST also be resolved by its own pooled
 * candidate under re-grade — otherwise the offline job disagrees with the live
 * submission (a bug: the winner is in the pool, so re-grading it must resolve too).
 */
export const aggregateBestKPassK = (
  pool: ReadonlyMap<string, readonly PooledCandidate[]>,
  perSlotOutcomes: readonly GradeOutcome[],
  submittedResolvedIds: readonly string[],
): BestKPassKResult => {
  const poolInstances = new Set(pool.keys())
  // Union of every instance any pooled candidate resolved across all slots.
  const anySlotResolved = new Set<string>()
  for (const outcome of perSlotOutcomes) {
    for (const id of outcome.resolved) {
      if (poolInstances.has(id)) anySlotResolved.add(id)
    }
  }
  const submitted = new Set(submittedResolvedIds.filter((id) => poolInstances.has(id)))
  // fail-loud: a submitted winner that is in the pool must re-grade as resolved.
  for (const id of submitted) {
    if (!anySlotResolved.has(id)) {
      throw new Error(
        `bestk-passk: instance "${id}" is in the run's resolved set AND has pooled ` +
          `candidates, but NO pooled candidate re-graded as resolved — the offline ` +
          `job disagrees with the live submission (bug, not a ceiling).`,
      )
    }
  }
  const missedWinners = [...anySlotResolved].filter((id) => !submitted.has(id)).sort()
  return {
    k: poolInstances.size,
    passK: anySlotResolved.size,
    bestK: submitted.size,
    gap: anySlotResolved.size - submitted.size,
    missedWinners,
  }
}

/** Injected side-effect surface for the orchestrator (predictions writer + backend). */
export interface BestKPassKDeps {
  readonly fs: CandidatePoolFs
  /** Write a predictions.jsonl for a slot; returns the path handed to the backend. */
  readonly writePredictions: (rows: readonly Prediction[], slot: SlotKey) => Promise<string>
  /** The official grading backend (SERIAL — never invoked concurrently). */
  readonly backend: GradeBackend
}

export interface RunBestKPassKArgs {
  readonly observeRoot: string
  readonly datasetPath: string
  readonly modelName: string
  readonly family?: GradeOptions["family"]
  /** report.resolved_ids — the run's actually-submitted resolved set. */
  readonly submittedResolvedIds: readonly string[]
}

/**
 * Orchestrate the offline Best@K/Pass@K grade: scan pool → per-slot predictions →
 * SERIAL grade each slot (max_workers:1, NEVER Promise.all — concurrent grading is a
 * false-negative source) → aggregate. Returns the ceiling result.
 */
export const runBestKPassKGrade = async (
  args: RunBestKPassKArgs,
  deps: BestKPassKDeps,
): Promise<BestKPassKResult> => {
  const pool = scanCandidatePool(args.observeRoot, deps.fs)
  const slots = buildSlotPredictions(pool, args.modelName, deps.fs)
  const perSlotOutcomes: GradeOutcome[] = []
  // SERIAL for-of — one slot at a time. max_workers:1 keeps the harness itself serial.
  for (const { slot, predictions } of slots) {
    if (predictions.length === 0) continue
    const predFile = await deps.writePredictions(predictions, slot)
    const outcome = await deps.backend.grade(predFile, {
      datasetPath: args.datasetPath,
      runId: `bestk-r${slot.round}i${slot.index}`,
      maxWorkers: 1,
      ...(args.family !== undefined ? { family: args.family } : {}),
    })
    perSlotOutcomes.push(outcome)
  }
  return aggregateBestKPassK(pool, perSlotOutcomes, args.submittedResolvedIds)
}

/** Render the result as a copy-pasteable block for the subcommand. */
export const renderBestKPassK = (r: BestKPassKResult): string => {
  const lines = [
    "=== Best@K vs Pass@K (offline candidate-pool ceiling) ===",
    `pooled instances (K):    ${r.k}`,
    `Best@K (submitted):      ${r.bestK}`,
    `Pass@K (any candidate):  ${r.passK}`,
    `gap (selector ceiling):  ${r.gap}`,
  ]
  if (r.missedWinners.length > 0) {
    lines.push("missed winners (pooled candidate resolved, run did not submit it):")
    for (const id of r.missedWinners) lines.push(`  + ${id}`)
  }
  return lines.join("\n")
}
