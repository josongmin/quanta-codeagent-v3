/**
 * `@/tool/ci-finding` — CI-investigation finding STORE (§7.3, jun-08 long-tail).
 *
 * Pure in-memory session-scoped registry of structured `CiFinding` records.
 * Today a CI-investigation skill leaves its conclusions as PROSE in the
 * transcript; Codex/Cursor instead capture a STRUCTURED record (job + category
 * + root-cause + evidence + suggested fix) the host can render, dedupe, or feed
 * to the next stage. This is the typed-record substrate.
 *
 * Plane-clean: imports only `@/shared`. Injected clock + id-factory ⇒ fully
 * deterministic in tests (no Date.now / Math.random). NO-THROW: the store never
 * throws; bad input is rejected upstream by the tool's zod schema.
 */

import { byteCompare } from "@/shared"

/** How confident the investigation is in this finding's root-cause. */
export type CiFindingConfidence = "low" | "medium" | "high"

/** Coarse failure category — closed union so renderers/dedupers can branch. */
export type CiFindingCategory =
  | "test-failure"
  | "build-error"
  | "lint"
  | "type-error"
  | "flaky"
  | "timeout"
  | "dependency"
  | "infra"
  | "config"
  | "other"

/** A single structured CI-investigation finding. */
export interface CiFinding {
  readonly id: string
  /** Monotonic insertion sequence (stable ordering independent of clock skew). */
  readonly seq: number
  /** Epoch-ms the finding was recorded (from the injected clock). */
  readonly recordedAt: number
  /** The failing CI job / check name (e.g. "test (ubuntu)", "lint"). */
  readonly job: string
  readonly category: CiFindingCategory
  /** One-line summary of what failed. */
  readonly summary: string
  /** The investigated root cause (prose, bounded by the tool schema). */
  readonly rootCause: string
  /** Optional evidence pointer(s): log excerpt, file:line, failing test name. */
  readonly evidence?: string
  /** Optional suggested fix. */
  readonly suggestedFix?: string
  readonly confidence: CiFindingConfidence
}

/** Fields the caller supplies when recording (id/seq/recordedAt are minted). */
export type CiFindingInput = Omit<CiFinding, "id" | "seq" | "recordedAt">

export interface CiFindingStore {
  /** Record a finding; returns the minted record. */
  record(input: CiFindingInput): CiFinding
  /** Snapshot of all findings in insertion order. Optionally filter by job. */
  list(filter?: {
    readonly job?: string
    readonly category?: CiFindingCategory
  }): readonly CiFinding[]
  /** Look up one finding by id (undefined if absent). */
  get(id: string): CiFinding | undefined
  /** Current count. */
  size(): number
}

export interface CiFindingStoreOpts {
  /** Injected clock (epoch-ms). Defaults to `Date.now` in production. */
  readonly now?: () => number
  /** Injected id factory. Defaults to a monotonic `cif-<seq>` in production
   *  (deterministic, no randomness needed — the store is single-session). */
  readonly idFactory?: (seq: number) => string
  /** Hard cap on retained findings — oldest-evicted ring so an unbounded
   *  investigation can't grow without limit. Default 500. */
  readonly maxFindings?: number
}

const DEFAULT_MAX = 500

/** Build a fresh in-memory CiFindingStore. Each call is independent. */
export const createCiFindingStore = (opts: CiFindingStoreOpts = {}): CiFindingStore => {
  const now = opts.now ?? (() => Date.now())
  const idFactory = opts.idFactory ?? ((seq: number) => `cif-${seq}`)
  const max = opts.maxFindings ?? DEFAULT_MAX
  const findings: CiFinding[] = []
  let seqCounter = 0

  return {
    record(input: CiFindingInput): CiFinding {
      const seq = seqCounter++
      const rec: CiFinding = {
        id: idFactory(seq),
        seq,
        recordedAt: now(),
        job: input.job,
        category: input.category,
        summary: input.summary,
        rootCause: input.rootCause,
        ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
        ...(input.suggestedFix !== undefined ? { suggestedFix: input.suggestedFix } : {}),
        confidence: input.confidence,
      }
      findings.push(rec)
      // Oldest-evicted ring — bound retention.
      while (findings.length > max) findings.shift()
      return rec
    },
    list(filter): readonly CiFinding[] {
      let out = findings.slice()
      if (filter?.job !== undefined) out = out.filter((f) => f.job === filter.job)
      if (filter?.category !== undefined) out = out.filter((f) => f.category === filter.category)
      return out
    },
    get(id: string): CiFinding | undefined {
      return findings.find((f) => f.id === id)
    },
    size(): number {
      return findings.length
    },
  }
}

/** Stable render of a finding for tool output. Exported so the tool + tests
 *  share ONE format. Fields ordered deterministically. */
export const renderFinding = (f: CiFinding): string => {
  const parts = [
    `[${f.id}] ${f.job} — ${f.category} (${f.confidence})`,
    `  summary: ${f.summary}`,
    `  root-cause: ${f.rootCause}`,
  ]
  if (f.evidence !== undefined) parts.push(`  evidence: ${f.evidence}`)
  if (f.suggestedFix !== undefined) parts.push(`  fix: ${f.suggestedFix}`)
  return parts.join("\n")
}

/** Render a list of findings (sorted by seq for determinism). */
export const renderFindings = (findings: readonly CiFinding[]): string => {
  if (findings.length === 0) return "(no CI findings recorded)"
  return [...findings]
    .sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : byteCompare(a.id, b.id)))
    .map(renderFinding)
    .join("\n\n")
}
