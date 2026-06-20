/**
 * TD — verify-and-select selection executor (pure orchestrator).
 *
 * The OUTER control plane: generate N candidate patches, score each through the
 * {@link VerificationBundle}, and return the winner. Bounded repair (if any)
 * lives INSIDE candidate generation as an inner tactic — it never holds global
 * verdict authority here. This module is a pure orchestrator over INJECTED
 * ports (generate / regression / resolvedKofN): no fs, no exec, no agent — so
 * it is fully unit-testable with fakes, and the driver supplies the real ports.
 *
 * Diversity, not repetition: `seeds[i]` nudges candidate i toward the i-th
 * ranked localization owner, so the set spans different FIX SITES (the measured
 * cause-vs-symptom failure is N samples of the same wrong anchor — diversity +
 * owner-coverage selection lets a sibling that touches the root-cause file win).
 *
 * Scoring signals assembled here:
 *   HARD  — baseValidatedRed (closure), applyClean (non-empty diff),
 *           regressionGreen (port, null=fail-open), patchedResolvedKofN (port,
 *           null=fail-open).
 *   SOFT  — minimality (RELATIVE across the candidate set: smallest diff = 1,
 *           parameter-free), ownerCoverage (fraction of the candidate's files
 *           that are closure-ranked owners; null when no owner set).
 *
 * Winner = `selectBest` (highest-scoring admissible) else `selectBestEffort`
 * (highest raw score) — the hard gates inform but never leave us submitting
 * nothing when a candidate exists.
 */

import {
  type CandidateVerdict,
  type HardGateSignals,
  type SoftScoreSignals,
  scoreCandidate,
  selectBest,
  selectBestEffort,
} from "@/agent/verification-bundle"
import { Semaphore } from "@/workflow/semaphore"

export interface Candidate {
  /** Stable id (e.g. `cand-0`). */
  id: string
  /** The captured unified diff (empty string ⇒ no-patch). */
  patch: string
  /** Agent turns this candidate consumed (for cost bookkeeping). */
  turns: number
  /** Repo-relative files the diff touches (for owner-coverage). */
  files: readonly string[]
  /** The instance's baseValidatedRed (same for every candidate). */
  baseValidatedRed: boolean
}

export interface SelectionPorts {
  /** Generate candidate `index` with optional localization `seed`. */
  generate: (index: number, seed: string | undefined) => Promise<Candidate>
  /** OPTIONAL regression hard signal; absent ⇒ null (FAIL-OPEN). */
  regression?: (c: Candidate) => Promise<boolean | null>
  /** OPTIONAL patched resolved K-of-N hard signal; absent ⇒ null (FAIL-OPEN). */
  resolvedKofN?: (c: Candidate) => Promise<{ votes: number; k: number } | null>
}

export interface ScoredEntry {
  candidate: Candidate
  verdict: CandidateVerdict
}

export interface SelectionResult {
  /** Winning candidate (admissible best, else best-effort). null iff 0 generated. */
  winner: Candidate | null
  /** Per-candidate scoring (post-dedup), generation order. */
  scored: ScoredEntry[]
  /** How many candidates were admissible. */
  admissibleCount: number
  /** Distinct (deduped) candidate count. */
  generated: number
}

/** Compact, JSON-friendly per-candidate view (NO full patch — too big for the
 *  sidecar). The `reasons` carry the hard-gate rejections + soft signals from
 *  {@link scoreCandidate}, so the cause-vs-symptom story is readable directly:
 *  e.g. `{files:[blockmatrix.py], admissible:false, reasons:[hard:regressionGreen=false]}`
 *  next to `{files:[matexpr.py], admissible:true, reasons:[soft:ownerCoverage=1]}`. */
export interface CandidateTelemetry {
  id: string
  files: readonly string[]
  admissible: boolean
  score: number
  reasons: readonly string[]
}

/** Eval-only selection telemetry — what the executor decided and WHY, so a
 *  verify-select campaign self-diagnoses (which fix SITES the N candidates
 *  spanned, which were admissible, which won). NEVER fed to the agent loop. */
export interface SelectionTelemetry {
  generated: number
  admissibleCount: number
  winnerId: string | null
  candidates: readonly CandidateTelemetry[]
}

/** Project a {@link SelectionResult} into compact eval-only telemetry (drops the
 *  full candidate patches; keeps files + verdict). Pure. */
export const summarizeSelection = (result: SelectionResult): SelectionTelemetry => ({
  generated: result.generated,
  admissibleCount: result.admissibleCount,
  winnerId: result.winner?.id ?? null,
  candidates: result.scored.map((s) => ({
    id: s.candidate.id,
    files: s.candidate.files,
    admissible: s.verdict.admissible,
    score: s.verdict.score,
    reasons: s.verdict.reasons,
  })),
})

/** Normalize a diff to its `+++ b/` / `--- a/` FILE headers plus `+/-` CONTENT
 *  lines (dropping `@@` hunk-offset noise + context) so two patches dedup only
 *  when they make the SAME edit to the SAME file(s). Keeping the file headers is
 *  deliberate: the SAME content edit on DIFFERENT files is a DIFFERENT fix site
 *  (the diversity the executor exists to span) and must NOT collide. */
const normalizePatch = (patch: string): string =>
  patch
    .split("\n")
    .filter((l) => /^[+-]/.test(l))
    .map((l) => l.trimEnd())
    .join("\n")

/** Fraction of a candidate's files that are closure-ranked owners. `null` when
 *  the candidate touches no file OR no owner set is known (uninformative ⇒
 *  fail-open soft signal, contributes nothing rather than a misleading 0). */
export const ownerCoverageOf = (
  files: readonly string[],
  owners: ReadonlySet<string>,
): number | null => {
  if (files.length === 0 || owners.size === 0) return null
  const hit = files.filter((f) => owners.has(f)).length
  return hit / files.length
}

/**
 * Run the verify-and-select executor. Pure over the injected ports.
 *
 * `seeds[i]` is the localization focus for candidate i (`seeds[0]` is typically
 * `undefined` = an unbiased baseline). `owners` is the closure localization-
 * ranked file set used for owner-coverage.
 */
export const runSelection = async (args: {
  n: number
  seeds: readonly (string | undefined)[]
  owners: ReadonlySet<string>
  ports: SelectionPorts
  /** Max candidates generated CONCURRENTLY. Default 1 = sequential (the shared-
   *  sandbox path — byte-identical to the pre-concurrency loop). >1 requires the
   *  `generate` port to ISOLATE each candidate (its own sandbox + deadline), or
   *  concurrent agent runs corrupt one shared git tree. Bounded by a Semaphore
   *  so total in-flight never exceeds this (the LLM-throttle ceiling guard). */
  concurrency?: number
}): Promise<SelectionResult> => {
  // ── generate ──────────────────────────────────────────────────────────────
  // Results are collected in INDEX order regardless of completion timing, so
  // dedup ("first wins") and scoring stay deterministic.
  const limit = Math.max(1, Math.floor(args.concurrency ?? 1))
  let raw: Candidate[]
  if (limit <= 1) {
    // Sequential: each candidate is a full agent run sharing the sandbox; the
    // driver resets the tree between them. BYTE-IDENTICAL to the original loop.
    raw = []
    for (let i = 0; i < args.n; i++) raw.push(await args.ports.generate(i, args.seeds[i]))
  } else {
    // Bounded-parallel: at most `limit` generate() calls in flight at once.
    const sem = new Semaphore(limit)
    raw = await Promise.all(
      Array.from({ length: args.n }, async (_, i) => {
        const release = await sem.acquire()
        try {
          return await args.ports.generate(i, args.seeds[i])
        } finally {
          release()
        }
      }),
    )
  }

  // ── dedup by normalized diff (Trae's pruning lever) ──────────────────────
  const seen = new Set<string>()
  const cands = raw.filter((c) => {
    const key = normalizePatch(c.patch)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // ── relative minimality across the deduped set (parameter-free) ──────────
  // Computed over NON-EMPTY patches only: an empty diff is a non-fix, not a
  // "minimal" fix, so it gets NO minimality signal (null) — otherwise size 0
  // would score 1 and an empty no-patch could win best-effort over a real one.
  const realSizes = cands
    .filter((c) => c.patch.trim() !== "")
    .map((c) => Buffer.byteLength(c.patch, "utf8"))
  const minB = realSizes.length > 0 ? Math.min(...realSizes) : 0
  const maxB = realSizes.length > 0 ? Math.max(...realSizes) : 0

  const scored: ScoredEntry[] = []
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i] as Candidate
    const isEmpty = c.patch.trim() === ""
    const size = Buffer.byteLength(c.patch, "utf8")
    const hard: HardGateSignals = {
      baseValidatedRed: c.baseValidatedRed,
      applyClean: !isEmpty,
      regressionGreen: (await args.ports.regression?.(c)) ?? null,
      patchedResolvedKofN: (await args.ports.resolvedKofN?.(c)) ?? null,
    }
    const soft: SoftScoreSignals = {
      declaredExpectedMatch: null,
      rubricScore: null,
      voterQuorum: null,
      // smallest real diff ⇒ 1; all equal ⇒ 1; larger ⇒ lower; empty ⇒ null.
      minimality: isEmpty ? null : maxB === minB ? 1 : 1 - (size - minB) / (maxB - minB),
      // an empty no-patch earns NO owner-coverage credit (even if a caller hands
      // it stray `files`) — it is a non-fix, not a fix that "touches the owner".
      ownerCoverage: isEmpty ? null : ownerCoverageOf(c.files, args.owners),
    }
    scored.push({ candidate: c, verdict: scoreCandidate(hard, soft) })
  }

  const ranked = scored.map((s) => ({ id: s.candidate.id, verdict: s.verdict }))
  const winnerId = selectBest(ranked) ?? selectBestEffort(ranked)
  const winner = scored.find((s) => s.candidate.id === winnerId)?.candidate ?? null
  return {
    winner,
    scored,
    admissibleCount: scored.filter((s) => s.verdict.admissible).length,
    generated: cands.length,
  }
}
