/**
 * Result store schema — ONE shape consumed by all tiers and the `report/` view.
 *
 * Schema versioning: bump `SCHEMA_VERSION` on any breaking change to the
 * envelope. Readers must check the field and refuse on mismatch (the report
 * tool prints which file/version was rejected so the user can re-run that
 * tier). Adding optional fields is non-breaking.
 *
 * Storage format: JSONL, append-only. Each line is exactly one
 * `EvalRecord` (envelope) carrying one of the tier-specific payloads.
 */
import type {
  GroundingAmbiguityClass,
  GroundingBucket,
  GroundingDecision,
  GroundingCorpus,
  GroundingHumanAudit,
  GroundingMode,
  GroundingNormalizationProfile,
  GroundingOutputProtocol,
  GroundingPairRole,
  GroundingProbeProfile,
  GroundingSeverity,
  GroundingSourceProvenance,
  GroundingSuite,
} from "../grounding/schema"
import type { GroundingErrorKind } from "../grounding/diagnostics"
import type { CoverageLevel, EvalTier, UseCaseId, Verdict } from "../types"

export const SCHEMA_VERSION = 1 as const

/** Known payload discriminator values — kept in sync with the union below.
 *  `result-store.readAll` validates every line's `payload.kind` against this
 *  set before yielding, so an unknown kind is DROPPED rather than silently
 *  flowing through to `report/coverage-matrix.verdictFromRecord`. */
export const PAYLOAD_KINDS = [
  "audit",
  "synthetic",
  "grounding",
  "public",
  "trajectory",
  "compare",
] as const
export type PayloadKind = (typeof PAYLOAD_KINDS)[number]

const PAYLOAD_KIND_SET: ReadonlySet<string> = new Set(PAYLOAD_KINDS)

export const isKnownPayloadKind = (k: string): k is PayloadKind => PAYLOAD_KIND_SET.has(k)

/** Common envelope for every persisted result. */
export interface EvalRecord {
  /** Append-time epoch ms. */
  ts: number
  /** Schema version of THIS record (forward-compat). */
  schema: typeof SCHEMA_VERSION
  /** Stable id of the run that produced the record (a single CLI invocation). */
  runId: string
  /** Which tier produced the record. */
  tier: EvalTier
  /** Use case the record is *about*. Audit/synthetic key off this directly;
   *  trajectory uses the classifier output; public uses the mapping table. */
  usecase: UseCaseId
  /** Tier-specific payload (discriminated by `tier`). */
  payload:
    | AuditPayload
    | SyntheticPayload
    | GroundingPayload
    | PublicPayload
    | TrajectoryPayload
    | ComparePayload
}

// ── Tier-specific payloads ──────────────────────────────────────────────────

/** Tier 0 — static coverage decision per use case. */
export interface AuditPayload {
  kind: "audit"
  coverage: CoverageLevel
  /** Source paths that the grep mapper matched (code, tests, runbooks). */
  evidence: readonly string[]
  /** Free-form note (why PARTIAL, why NO, what's TBD). */
  note?: string
}

// ── Cross-tier additive shapes (ADR-0087, Cursor EvalTracking §7.3) ─────────

/** Keyed metric (Cursor `RunMetricItem`). Strictly richer than a single
 *  `score`: an arbitrary named axis + optional unit + optional step (turn
 *  index), so a run can carry many metrics over its lifetime. */
export interface Metric {
  key: string
  value: number
  unit?: string
  step?: number
}

/** Per-run token accounting (Cursor Run token fields). */
export interface TokenUsage {
  prompt: number
  completion: number
  cacheRead?: number
  cacheWrite?: number
}

/** Tier 1 — one synthetic scenario verdict. */
export interface SyntheticPayload {
  kind: "synthetic"
  /** Scenario id local to its use case (filename stem). */
  scenarioId: string
  verdict: Verdict
  /** Judge score ∈ [0,1] when produced; absent for `skipped`/`error`. */
  score?: number
  /** Per-rubric item verdict. */
  rubric: readonly { name: string; pass: boolean }[]
  /** Tool calls made by the agent during the run (names only). */
  toolsUsed: readonly string[]
  /** Forbidden tool/command observed; aborts the verdict to `fail`. */
  forbiddenHit?: string
  /** Path to the captured trajectory JSONL (relative to runs/ dir). */
  trajectory?: string
  /** Wall-clock ms. */
  durationMs: number
  /** ADR-0087 — keyed metrics over the run (augments, never replaces, `score`). */
  metrics?: readonly Metric[]
  /** ADR-0087 — token accounting for this run. */
  tokens?: TokenUsage
  /** ADR-0087 — estimated USD cost for this run. */
  costUsd?: number
}

/** Tier 2 — one structured context-grounding case verdict. */
export interface GroundingPayload {
  kind: "grounding"
  mode?: GroundingMode
  corpus?: GroundingCorpus
  probeProfile?: GroundingProbeProfile
  normalizationProfile?: GroundingNormalizationProfile
  structuredOutputProtocol?: GroundingOutputProtocol
  structuredOutputValid?: boolean
  suite: GroundingSuite
  caseId: string
  verdict: Verdict
  bucket: GroundingBucket
  severity: GroundingSeverity
  gold: GroundingDecision
  rawActual?: GroundingDecision
  normalizedActual?: GroundingDecision
  scoredActual?: GroundingDecision
  /** Back-compat alias for old reports/tests. Equals `scoredActual` on new runs. */
  actual?: GroundingDecision
  normalizationApplied?: boolean
  normalizationReasons?: readonly string[]
  sourceProvenance?: GroundingSourceProvenance
  humanAudit?: GroundingHumanAudit
  candidateThreadIds?: readonly string[]
  candidateReferentIds?: readonly string[]
  ambiguityClass?: GroundingAmbiguityClass
  blockingEligible?: boolean
  matches: {
    activeThread: boolean
    referent: boolean
    intent: boolean
    scope: boolean
    shouldClarify: boolean
    exactTuple: boolean
    wrongThread: boolean
    mustClarifyMiss: boolean
    staleContextTrapMiss: boolean
  }
  pairId?: string
  pairRole?: GroundingPairRole
  rawResponse: string
  parseError?: string
  errorKind?: GroundingErrorKind
  provider?: string
  model?: string
  surfaceId?: string
  transportId?: string
  authMode?: string
  durationMs: number
  metrics?: readonly Metric[]
  tokens?: TokenUsage
  costUsd?: number
}

/** Tier 3 — one public benchmark instance verdict. */
export interface PublicPayload {
  kind: "public"
  /** Adapter name, e.g. `swebench-verified`. */
  bench: string
  /** Bench instance id. */
  instanceId: string
  verdict: Verdict
  /** Patch produced (sha256 of diff for quick equality checks). */
  patchSha256?: string
  durationMs: number
  /** ADR-0087 — keyed metrics over the run (augments, never replaces, `score`). */
  metrics?: readonly Metric[]
  /** ADR-0087 — token accounting for this run. */
  tokens?: TokenUsage
  /** ADR-0087 — estimated USD cost for this run. */
  costUsd?: number
}

/** Tier 4 — one real session classified + replayed (replay optional). */
export interface TrajectoryPayload {
  kind: "trajectory"
  /** Source JSONL path. */
  source: string
  /** Session id (first session_start.runId or filename stem). */
  sessionId: string
  /** Classification confidence ∈ [0,1]. */
  confidence: number
  /** Number of turns observed. */
  turns: number
  /** Set only when a replay was performed against the current agent. */
  replay?: {
    matched: boolean
    /** Number of diverging events when replayed (lower is closer). */
    divergedEvents: number
  }
}

/** Tier 5 — one A/B head-to-head verdict between agents. */
export interface ComparePayload {
  kind: "compare"
  scenarioId: string
  /** Ordered participants, e.g. `["quanta","claude-code"]`. */
  agents: readonly string[]
  /** Index into `agents` of the winner, or `-1` for tie. */
  winner: number
  /** Pairwise judge rationale, short. */
  note?: string
}

/** Light run-level summary record written at the END of a CLI run so
 *  `report/` can render a run header without scanning all child records. */
export interface RunSummaryRecord {
  ts: number
  schema: typeof SCHEMA_VERSION
  runId: string
  tier: EvalTier
  /** Argv reconstructed for reproducibility. */
  argv: readonly string[]
  /** Counts by verdict. */
  counts: Record<Verdict, number>
  /** Total wall-clock ms of the run. */
  durationMs: number
  /** ADR-0087 — run lifecycle status (terminal subset of Cursor `EvalRunStatus`). */
  status?: "running" | "finished" | "failed" | "killed"
  /** ADR-0087 — reproduction parameter snapshot (Cursor `RunParamKV`). */
  params?: Readonly<Record<string, string | number | boolean>>
}
