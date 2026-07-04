/**
 * In-memory {@link EvidenceLedger} — session-scoped accumulation of typed evidence.
 *
 * Deterministic ids (`ev-0001`, `ev-0002`, …) — no clock, no random — so a replay
 * with the same ingest sequence produces byte-identical card ids and the reducer's
 * output is stable (spot-checkable in tests without mocking a clock). Insertion order
 * is preserved; queries are O(n) scans (the ledger is bounded by the session's tool
 * calls, so n is small — no index needed).
 */

import type {
  EvidenceCard,
  EvidenceCardInput,
  EvidenceLedger,
  EvidenceLedgerSnapshot,
  EvidenceSource,
} from "./types"

/** Zero-padded so lexical order matches insertion order (`ev-0009` < `ev-0010`). */
const mintId = (seq: number): string => `ev-${String(seq).padStart(4, "0")}`

export const createEvidenceLedger = (): EvidenceLedger => {
  const store: EvidenceCard[] = []
  let seq = 0

  const add = (input: EvidenceCardInput): EvidenceCard => {
    seq += 1
    const card: EvidenceCard = {
      id: input.id ?? mintId(seq),
      turn: input.turn,
      source: input.source,
      claim: input.claim,
      confidence: input.confidence,
      supports: input.supports ?? [],
      contradicts: input.contradicts ?? [],
      // exactOptionalPropertyTypes: only attach optional keys when defined so a card
      // without a location/revealHandle is byte-identical to one built inline.
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.revealHandle !== undefined ? { revealHandle: input.revealHandle } : {}),
    }
    store.push(card)
    return card
  }

  const cards = (): readonly EvidenceCard[] => store

  const bySource = (source: EvidenceSource): readonly EvidenceCard[] =>
    store.filter((c) => c.source === source)

  const contradictions = (): readonly EvidenceCard[] =>
    store.filter((c) => c.contradicts.length > 0)

  const snapshot = (): EvidenceLedgerSnapshot => {
    const bySourceCount: Partial<Record<EvidenceSource, number>> = {}
    for (const c of store) bySourceCount[c.source] = (bySourceCount[c.source] ?? 0) + 1
    return {
      total: store.length,
      bySource: bySourceCount,
      contradictionCount: store.reduce((n, c) => n + (c.contradicts.length > 0 ? 1 : 0), 0),
      cards: store,
    }
  }

  return { add, cards, bySource, contradictions, snapshot }
}
