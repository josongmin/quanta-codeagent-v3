/**
 * TD — verify-and-select selection executor (pure orchestrator).
 *
 * The OUTER control plane: generate N candidate patches, score each through the
 * {@link VerificationBundle}, and return the winner. Bounded repair (if any)
 * lives INSIDE candidate generation as an inner tactic — it never holds global
 * verdict authority here. This module is a pure orchestrator over INJECTED
 * ports (generate / applyClean / regression / resolvedKofN): no fs, no exec,
 * no agent — so
 * it is fully unit-testable with fakes, and the driver supplies the real ports.
 *
 * Diversity, not repetition: `seeds[i]` nudges candidate i toward the i-th
 * ranked localization owner, so the set spans different FIX SITES (the measured
 * cause-vs-symptom failure is N samples of the same wrong anchor — diversity +
 * owner-coverage selection lets a sibling that touches the root-cause file win).
 *
 * Scoring signals assembled here:
 *   HARD  — baseValidatedRed (closure; `null` in no-oracle modes),
 *           patchProduced (empty diff = false), applyClean (non-empty diff can
 *           be probed via port), regressionGreen (port, null=fail-open),
 *           patchedResolvedKofN (port, null=fail-open).
 *   SOFT  — minimality (RELATIVE across the candidate set: smallest diff = 1,
 *           parameter-free), ownerCoverage (fraction of the candidate's files
 *           that are closure-ranked owners; null when no owner set).
 *
 * Winner = `selectBest` (highest-scoring admissible) else `selectBestEffort`
 * over STRUCTURALLY SUBMITTABLE candidates only (highest raw score among
 * non-empty, applying patches). We never knowingly submit an empty or
 * non-applying patch.
 */

import { isAbsolute, relative, sep } from "node:path"
import type { StopReason } from "@/agent"
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
  /** The instance's repro-authority gate state (same for every candidate).
   *  `null` = selection mode does not require repro authority. */
  baseValidatedRed: boolean | null
  /** Terminal metadata preserved so upper drivers can classify no-winner
   *  outcomes from the best terminal candidate instead of flattening them to
   *  a generic empty-patch miss. */
  stopReason?: StopReason
  agentError?: string
  editCount?: number
}

export interface SelectionPorts {
  /** Generate candidate `index` with optional localization `seed`. */
  generate: (index: number, seed: string | undefined) => Promise<Candidate>
  /** OPTIONAL applyability hard signal; absent/null ⇒ non-empty patches fail open. */
  applyClean?: (c: Candidate) => Promise<boolean | null>
  /** OPTIONAL regression hard signal; absent ⇒ null (FAIL-OPEN). */
  regression?: (c: Candidate) => Promise<boolean | null>
  /** OPTIONAL patched resolved K-of-N hard signal; absent ⇒ null (FAIL-OPEN). */
  resolvedKofN?: (c: Candidate) => Promise<{ votes: number; k: number } | null>
}

export interface ScoredEntry {
  candidate: Candidate
  hard: HardGateSignals
  verdict: CandidateVerdict
}

export interface SelectionResult {
  /** Requested candidate count (`args.n`). */
  attempted: number
  /** Canonical owner files used for seed generation and owner-coverage scoring. */
  ownerFiles: readonly string[]
  /** True when an explicit progressive mode stopped before generating all N. */
  earlyAccepted: boolean
  /** Successful generate() calls BEFORE dedup. */
  successfulGenerations: number
  /** generate() calls that failed/aborted and were skipped. */
  generationFailures: number
  /** Winning candidate (admissible best, else best-effort among structurally
   *  submittable candidates). null when 0 generated OR every candidate is
   *  structurally unshippable (empty / non-applying). */
  winner: Candidate | null
  /** Highest-scoring terminal candidate when nothing was submittable. Lets the
   *  caller preserve stop-reason/error/edit metadata even when `winner=null`. */
  terminalCandidate: Candidate | null
  /** Per-candidate scoring (post-dedup), generation order. */
  scored: ScoredEntry[]
  /** How many candidates were admissible. */
  admissibleCount: number
  /** Distinct (deduped) candidate count. */
  generated: number
}

export type ResolvedKofNMode = "hard" | "soft"

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
  attempted: number
  /** Canonical owner files used by this selection pass. */
  ownerFiles: readonly string[]
  earlyAccepted: boolean
  successfulGenerations: number
  generationFailures: number
  generated: number
  admissibleCount: number
  winnerId: string | null
  candidates: readonly CandidateTelemetry[]
}

/** Project a {@link SelectionResult} into compact eval-only telemetry (drops the
 *  full candidate patches; keeps files + verdict). Pure. */
export const summarizeSelection = (result: SelectionResult): SelectionTelemetry => ({
  attempted: result.attempted,
  ownerFiles: result.ownerFiles,
  earlyAccepted: result.earlyAccepted,
  successfulGenerations: result.successfulGenerations,
  generationFailures: result.generationFailures,
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

const fwd = (s: string): string => s.split(sep).join("/").replace(/\\/g, "/")

const relInsideSandbox = (path: string, sandbox: string | undefined): string | null => {
  if (!isAbsolute(path)) return path
  if (sandbox === undefined) return null
  const rel = relative(sandbox, path)
  return rel === "" || rel.startsWith("..") ? null : fwd(rel)
}

const normalizePathParts = (path: string): string | null => {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") return null
    parts.push(part)
  }
  const out = parts.join("/")
  return out === "" || out === "dev/null" ? null : out
}

/** Canonical repo-relative path used by selection owners and candidate patches.
 *  Absolute paths are accepted only when they are inside the active sandbox. */
export const normalizeSelectionPath = (raw: string, sandbox: string | undefined): string | null => {
  let p = fwd(raw.trim().replace(/^["'`]+|["'`]+$/g, ""))
  if (p === "" || p === "/dev/null") return null
  const rel = relInsideSandbox(p, sandbox)
  if (rel === null) return null
  p = rel
  p = p.replace(/^\.\//, "").replace(/^(?:a|b)\//, "")
  return normalizePathParts(p)
}

export const normalizeSelectionPaths = (
  paths: readonly string[],
  sandbox: string | undefined,
): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    const p = normalizeSelectionPath(raw, sandbox)
    if (p === null || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** Repo-relative files a unified diff touches (its `+++ b/<f>` headers, plus
 *  `--- a/<f>` for pure deletions). Used for owner-coverage scoring. */
export const filesFromPatch = (patch: string): string[] => {
  const files = new Set<string>()
  for (const line of patch.split("\n")) {
    const m = /^(?:\+\+\+ b\/|--- a\/)(.+)$/.exec(line)
    if (m !== null) {
      const f = normalizeSelectionPath(m[1] as string, undefined)
      if (f !== null) files.add(f)
    }
  }
  return [...files]
}

export interface SelectionInputs {
  readonly ownerFiles: readonly string[]
  readonly owners: ReadonlySet<string>
  readonly seeds: readonly (string | undefined)[]
}

export const buildSelectionInputs = (args: {
  readonly n: number
  readonly ownerCandidates: readonly string[]
  readonly sandbox?: string
}): SelectionInputs => {
  const ownerFiles = normalizeSelectionPaths(args.ownerCandidates, args.sandbox)
  const seedFor = (i: number): string | undefined => {
    if (i === 0) return undefined
    const file = ownerFiles[i - 1]
    return file === undefined
      ? undefined
      : `Focus your investigation on \`${file}\`. Confirm the ROOT CAUSE lives there (not merely where the symptom surfaces) before editing.`
  }
  return {
    ownerFiles,
    owners: new Set(ownerFiles),
    seeds: Array.from({ length: args.n }, (_, i) => seedFor(i)),
  }
}

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

const fullyInsideOwners = (files: readonly string[], owners: ReadonlySet<string>): boolean =>
  owners.size === 0 || (files.length > 0 && files.every((f) => owners.has(f)))

const resolvedPositive = (resolved: { votes: number; k: number } | null): boolean =>
  resolved !== null && resolved.k > 0 && resolved.votes >= resolved.k

const earlyAcceptable = (
  entry: ScoredEntry,
  owners: ReadonlySet<string>,
  requireHardResolved: boolean,
): boolean => {
  if (!entry.verdict.admissible) return false
  // Early-stop authority is STRICTER than admissibility: fail-open `null` gates
  // keep a candidate admissible, but they are not strong enough to stop the
  // loop. The progressive shortcut requires an explicitly clean-applying patch.
  if (!entry.hard.patchProduced || entry.hard.applyClean !== true) return false
  // Early-accept is a cost shortcut, not a license to bypass the selector's
  // diversity/owner-coverage authority. If closure owners are known, a positive
  // candidate may stop the loop only when every touched file is inside that owner
  // set; broad symptom+stray patches must still face later owner-seeded siblings.
  if (!fullyInsideOwners(entry.candidate.files, owners)) return false
  const resolved = entry.hard.patchedResolvedKofN
  if (requireHardResolved) return resolvedPositive(resolved)
  return resolvedPositive(resolved) || entry.hard.regressionGreen === true
}

const voterQuorumOf = (
  mode: ResolvedKofNMode,
  resolved: { votes: number; k: number } | null,
): number | null =>
  mode === "soft" && resolved !== null && resolved.k > 0 ? resolved.votes / resolved.k : null

const terminalAuthorityRank = (candidate: Candidate): number => {
  if (
    candidate.stopReason === "max_turns" ||
    candidate.stopReason === "budget_exhausted" ||
    candidate.stopReason === "aborted"
  ) {
    return 2
  }
  if (candidate.stopReason === "error" || candidate.stopReason === "refusal") return 1
  return 0
}

const minimalityOf = (args: {
  readonly isEmpty: boolean
  readonly size: number
  readonly minB: number
  readonly maxB: number
}): number | null => {
  if (args.isEmpty) return null
  return args.maxB === args.minB ? 1 : 1 - (args.size - args.minB) / (args.maxB - args.minB)
}

const requireHardResolvedForEarlyAccept = (
  ports: SelectionPorts,
  mode: ResolvedKofNMode | undefined,
): boolean => ports.resolvedKofN !== undefined && (mode ?? "hard") === "hard"

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
  /** How to consume resolvedKofN. Default `hard` preserves legacy behavior.
   *  `soft` turns votes/k into positive ranking credit and never hard-rejects. */
  resolvedKofNMode?: ResolvedKofNMode
  /** Max candidates generated CONCURRENTLY. Default 1 = sequential (the shared-
   *  sandbox path — byte-identical to the pre-concurrency loop). >1 requires the
   *  `generate` port to ISOLATE each candidate (its own sandbox + deadline), or
   *  concurrent agent runs corrupt one shared git tree. Bounded by a Semaphore
   *  so total in-flight never exceeds this (the LLM-throttle ceiling guard). */
  concurrency?: number
  /** Progressive cost guard. Sequential-only: once a generated candidate is
   *  admissible, clean-applying, owner-scoped, and has the configured hard
   *  positive regression/resolved signal, submit it instead of burning the
   *  remaining candidate budget. Fail-open `null` gates and soft-only repro
   *  quorum remain ranking credit / keep-search signals, never global stop
   *  authority. Default false preserves N-best. */
  earlyAccept?: boolean
}): Promise<SelectionResult> => {
  // ── generate ──────────────────────────────────────────────────────────────
  // Results are collected in INDEX order regardless of completion timing, so
  // dedup ("first wins") and scoring stay deterministic.
  const limit = Math.max(1, Math.floor(args.concurrency ?? 1))
  let generationFailures = 0
  const tryGenerate = async (i: number): Promise<Candidate | null> => {
    try {
      return await args.ports.generate(i, args.seeds[i])
    } catch {
      generationFailures += 1
      return null
    }
  }
  const scoreOne = async (c: Candidate, minB: number, maxB: number): Promise<ScoredEntry> => {
    const isEmpty = c.patch.trim() === ""
    const size = Buffer.byteLength(c.patch, "utf8")
    const resolvedKofN = (await args.ports.resolvedKofN?.(c)) ?? null
    const resolvedMode = args.resolvedKofNMode ?? "hard"
    const hard: HardGateSignals = {
      baseValidatedRed: c.baseValidatedRed,
      patchProduced: !isEmpty,
      applyClean: isEmpty ? null : ((await args.ports.applyClean?.(c)) ?? null),
      regressionGreen: (await args.ports.regression?.(c)) ?? null,
      patchedResolvedKofN: resolvedMode === "hard" ? resolvedKofN : null,
    }
    const soft: SoftScoreSignals = {
      declaredExpectedMatch: null,
      rubricScore: null,
      voterQuorum: voterQuorumOf(resolvedMode, resolvedKofN),
      // smallest real diff ⇒ 1; all equal ⇒ 1; larger ⇒ lower; empty ⇒ null.
      minimality: minimalityOf({ isEmpty, size, minB, maxB }),
      // an empty no-patch earns NO owner-coverage credit (even if a caller hands
      // it stray `files`) — it is a non-fix, not a fix that "touches the owner".
      ownerCoverage: isEmpty ? null : ownerCoverageOf(c.files, args.owners),
    }
    return { candidate: c, hard, verdict: scoreCandidate(hard, soft) }
  }

  const maybeFinalizeEarlyAccept = async (
    rawCandidates: readonly Candidate[],
    candidate: Candidate,
  ): Promise<SelectionResult | null> => {
    if (args.earlyAccept !== true) return null
    const size = Buffer.byteLength(candidate.patch, "utf8")
    const entry = await scoreOne(candidate, size, size)
    return earlyAcceptable(
      entry,
      args.owners,
      requireHardResolvedForEarlyAccept(args.ports, args.resolvedKofNMode),
    )
      ? await finalize(rawCandidates, true)
      : null
  }

  const finalize = async (
    rawCandidates: readonly Candidate[],
    earlyAccepted: boolean,
  ): Promise<SelectionResult> => {
    // ── dedup by normalized diff (Trae's pruning lever) ──────────────────────
    const seen = new Set<string>()
    const cands = rawCandidates.filter((c) => {
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
      scored.push(await scoreOne(cands[i] as Candidate, minB, maxB))
    }

    const ranked = scored.map((s) => ({ id: s.candidate.id, verdict: s.verdict }))
    const fallbackRanked = scored
      .filter((s) => s.hard.patchProduced && s.hard.applyClean !== false)
      .map((s) => ({ id: s.candidate.id, verdict: s.verdict }))
    const winnerId = selectBest(ranked) ?? selectBestEffort(fallbackRanked)
    const winner = scored.find((s) => s.candidate.id === winnerId)?.candidate ?? null
    let terminalCandidate: Candidate | null = null
    if (winner === null) {
      const bestTerminalRank = scored.reduce(
        (best, entry) => Math.max(best, terminalAuthorityRank(entry.candidate)),
        0,
      )
      const terminalPool = scored
        .filter((entry) => terminalAuthorityRank(entry.candidate) === bestTerminalRank)
        .map((entry) => ({ id: entry.candidate.id, verdict: entry.verdict }))
      const terminalId = selectBestEffort(terminalPool)
      terminalCandidate = scored.find((s) => s.candidate.id === terminalId)?.candidate ?? null
    }
    return {
      attempted: args.n,
      ownerFiles: [...args.owners],
      earlyAccepted,
      successfulGenerations: rawCandidates.length,
      generationFailures,
      winner,
      terminalCandidate,
      scored,
      admissibleCount: scored.filter((s) => s.verdict.admissible).length,
      generated: cands.length,
    }
  }

  let raw: Candidate[]
  if (limit <= 1) {
    // Sequential: each candidate is a full agent run sharing the sandbox; the
    // driver resets the tree between them. BYTE-IDENTICAL to the original loop.
    raw = []
    for (let i = 0; i < args.n; i++) {
      const candidate = await tryGenerate(i)
      if (candidate === null) continue
      raw.push(candidate)
      const earlyAccepted = await maybeFinalizeEarlyAccept(raw, candidate)
      if (earlyAccepted !== null) return earlyAccepted
    }
  } else {
    // Bounded-parallel: at most `limit` generate() calls in flight at once.
    const sem = new Semaphore(limit)
    const maybeRaw = await Promise.all(
      Array.from({ length: args.n }, async (_, i) => {
        const release = await sem.acquire()
        try {
          return await tryGenerate(i)
        } finally {
          release()
        }
      }),
    )
    raw = maybeRaw.filter((candidate): candidate is Candidate => candidate !== null)
  }
  return await finalize(raw, false)
}
