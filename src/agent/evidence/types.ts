/**
 * Evidence layer (jul-5, SOTA++ P1) — typed observation → evidence substrate.
 *
 * The gap this fills (decision-map §C1): a tool result today is raw-appended to
 * working memory (`turn-closeout.ts` → `wm.append({role:"user", content:resultBlocks})`)
 * with NO semantic reduction — the model re-reads raw text every turn. This module
 * introduces the missing layer: a tool result is INGESTED into typed
 * {@link EvidenceCard}s that accumulate in an {@link EvidenceLedger} across turns,
 * so the agent (and observers) can see supporting / contradicting / missing evidence
 * as first-class state instead of buried prose.
 *
 * PHILOSOPHY GUARD (deliberate, per the SOTA review): this layer EXTRACTS and
 * ORGANIZES evidence; it does NOT decide hypotheses. A card carries a `claim` and
 * `supports`/`contradicts` links, but "which hypothesis wins" stays the model's job.
 * Cards keep only a bounded `claim` + a `revealHandle` to the raw content (lazy), so
 * the ledger never becomes a prompt bomb — the reducer renders a compact digest, and
 * raw is fetched on demand.
 *
 * DEFAULT-OFF: nothing consumes this until an entry point opts in behind a knob, so
 * the raw-append path stays byte-identical when the knob is unset.
 *
 * Slice boundary: pure data + logic. No `@/llm`, no `@/tool`, no IO — the ingest
 * adapters (source-specific parsers) live alongside but take already-extracted text.
 */

/** Where an evidence card came from. Each source has (or will have) an ingest adapter
 *  that turns raw tool output of that kind into cards. Derived from the runtime list
 *  below so the type and the validation Set never drift (single source of truth). */
const EVIDENCE_SOURCE_LIST = [
  "test_output",
  "lsp_diagnostic",
  "build_log",
  "grep",
  "code_graph",
  "git_diff",
  "runtime_trace",
] as const
export type EvidenceSource = (typeof EVIDENCE_SOURCE_LIST)[number]
/** Runtime membership check for `EvidenceSource` — guards the ingest edge where an
 *  external parser could cast an out-of-union string. */
export const EVIDENCE_SOURCES: ReadonlySet<EvidenceSource> = new Set(EVIDENCE_SOURCE_LIST)

/** How trustworthy the card's claim is. `raw` = surfaced verbatim, unparsed;
 *  `parsed` = structured by an adapter (file:line extracted); `verified` = confirmed
 *  by a subsequent observation (e.g. a reproduction rerun). */
const EVIDENCE_CONFIDENCE_LIST = ["raw", "parsed", "verified"] as const
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCE_LIST)[number]
export const EVIDENCE_CONFIDENCES: ReadonlySet<EvidenceConfidence> = new Set(
  EVIDENCE_CONFIDENCE_LIST,
)

/** Optional code location a card points at. All fields optional — a build-log card
 *  may have only a file, a grep card a file+line, a code-graph card a symbol. */
export interface EvidenceLocation {
  readonly file?: string
  readonly lineStart?: number
  readonly lineEnd?: number
  readonly symbol?: string
}

/** A single typed piece of evidence. `id` is assigned by the ledger on add (stable,
 *  deterministic — no clock/random) so `supports`/`contradicts` can reference siblings. */
export interface EvidenceCard {
  readonly id: string
  readonly turn: number
  readonly source: EvidenceSource
  /** One-line claim (bounded). The WHAT, not the raw dump. */
  readonly claim: string
  readonly location?: EvidenceLocation
  /** Ids of cards this card supports (corroborates). */
  readonly supports: readonly string[]
  /** Ids of cards this card contradicts (tension the model must resolve). */
  readonly contradicts: readonly string[]
  readonly confidence: EvidenceConfidence
  /** Opaque handle to the raw content, fetched lazily (keeps the ledger small). */
  readonly revealHandle?: string
}

/** A card as submitted to the ledger — `id` is optional (ledger assigns if absent). */
export type EvidenceCardInput = Omit<EvidenceCard, "id" | "supports" | "contradicts"> & {
  readonly id?: string
  readonly supports?: readonly string[]
  readonly contradicts?: readonly string[]
}

/** Compact, render-friendly view of the ledger for the reducer / observers. */
export interface EvidenceLedgerSnapshot {
  readonly total: number
  readonly bySource: Readonly<Partial<Record<EvidenceSource, number>>>
  readonly contradictionCount: number
  readonly cards: readonly EvidenceCard[]
}

/** Accumulating evidence store — one per session, mutated across turns. */
export interface EvidenceLedger {
  /** Add a card; assigns a stable id if none given; returns the stored card. */
  add(card: EvidenceCardInput): EvidenceCard
  /** All cards in insertion order. */
  cards(): readonly EvidenceCard[]
  /** Cards from a given source. */
  bySource(source: EvidenceSource): readonly EvidenceCard[]
  /** Cards that contradict at least one other card (tension surface). */
  contradictions(): readonly EvidenceCard[]
  /** Compact snapshot for rendering / attribution. */
  snapshot(): EvidenceLedgerSnapshot
}
