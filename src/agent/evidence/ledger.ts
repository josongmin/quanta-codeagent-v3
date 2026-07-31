/**
 * In-memory {@link EvidenceLedger} — session-scoped accumulation of typed evidence.
 *
 * Deterministic ids (`ev-0001`, `ev-0002`, …) — no clock, no random — so a replay
 * with the same ingest sequence produces byte-identical card ids and the reducer's
 * output is stable (spot-checkable in tests without mocking a clock). Insertion order
 * is preserved; queries are O(n) scans (the ledger is bounded by the session's tool
 * calls, so n is small — no index needed).
 */

import {
  EVIDENCE_CONFIDENCES,
  EVIDENCE_SOURCES,
  type EvidenceCard,
  type EvidenceCardInput,
  type EvidenceLedger,
  type EvidenceLedgerSnapshot,
  type EvidenceSource,
} from "./types"

/** Zero-padded so lexical order matches insertion order (`ev-0009` < `ev-0010`). */
const mintId = (seq: number): string => `ev-${String(seq).padStart(4, "0")}`

export const createEvidenceLedger = (): EvidenceLedger => {
  const store: EvidenceCard[] = []
  const ids = new Set<string>()
  let seq = 0

  const add = (input: EvidenceCardInput): EvidenceCard => {
    // ── Contract enforcement (adversarial-audit R1): a pure state layer must reject
    // malformed cards LOUDLY, not accumulate silent corruption. Callers (ingest
    // adapters) are expected to produce valid cards; the wiring wraps add in a
    // best-effort try so one bad tool result never kills the turn.
    const claim = input.claim.trim()
    if (claim.length === 0) throw new Error("evidence: claim must be non-empty after trim")
    if (!EVIDENCE_SOURCES.has(input.source))
      throw new Error(`evidence: unknown source "${input.source}"`)
    if (!EVIDENCE_CONFIDENCES.has(input.confidence))
      throw new Error(`evidence: unknown confidence "${input.confidence}"`)
    seq += 1
    const id = input.id ?? mintId(seq)
    if (ids.has(id)) throw new Error(`evidence: duplicate card id "${id}"`)
    const supports = input.supports ?? []
    const contradicts = input.contradicts ?? []
    // Referential integrity: every supports/contradicts id must reference an EXISTING
    // card (no dangling), and a card may not reference ITSELF (logical nonsense).
    const checkRefs = (refs: readonly string[], kind: string): void => {
      for (const ref of refs) {
        if (ref === id) throw new Error(`evidence: card ${id} cannot ${kind} itself`)
        if (!ids.has(ref)) throw new Error(`evidence: dangling ${kind} ref "${ref}" from ${id}`)
      }
    }
    checkRefs(supports, "support")
    checkRefs(contradicts, "contradict")
    const card: EvidenceCard = {
      id,
      turn: input.turn,
      source: input.source,
      claim,
      confidence: input.confidence,
      supports,
      contradicts,
      // exactOptionalPropertyTypes: only attach optional keys when defined so a card
      // without a location/revealHandle is byte-identical to one built inline.
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.revealHandle !== undefined ? { revealHandle: input.revealHandle } : {}),
    }
    store.push(card)
    ids.add(id)
    return card
  }

  // Return a COPY — never the internal store — so a caller (even one casting away
  // `readonly`) cannot push/splice into the ledger's backing array (audit R3 leak).
  // The card OBJECTS are shared readonly value objects; deep-freeze is deliberately
  // deferred (audit R4: `readonly` guards the only real caller and this is an internal
  // layer, not a plugin surface — recursive freeze on every read would be net-negative).
  const cards = (): readonly EvidenceCard[] => store.slice()

  const bySource = (source: EvidenceSource): readonly EvidenceCard[] =>
    store.filter((c) => c.source === source)

  const contradictions = (): readonly EvidenceCard[] =>
    store.filter((c) => c.contradicts.length > 0)

  const snapshot = (): EvidenceLedgerSnapshot => {
    const bySourceCount: Partial<Record<EvidenceSource, number>> = {}
    for (const c of store) bySourceCount[c.source] = (bySourceCount[c.source] ?? 0) + 1
    // contradictionCount = UNIQUE tension pairs (not "cards with an outgoing link"),
    // so A↔B counts once and one card contradicting three others counts three — the
    // number the digest banner reports. Refs are integrity-checked at add, so `other`
    // always resolves to a real card.
    const pairs = new Set<string>()
    for (const c of store) {
      for (const other of c.contradicts) pairs.add([c.id, other].sort().join("|"))
    }
    return {
      total: store.length,
      bySource: bySourceCount,
      contradictionCount: pairs.size,
      cards: store.slice(), // copy — snapshot must not expose the mutable backing array
    }
  }

  return { add, cards, bySource, contradictions, snapshot }
}
