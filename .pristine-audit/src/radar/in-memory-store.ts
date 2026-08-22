/**
 * In-memory `RadarStore` (ADR-0231).
 *
 * Primary test target and the default adapter for callers that do not
 * need persistence. Backed by `Map<string, RadarCard>` with insertion
 * order preserved; eviction is LRU by `createdAtMs` once `cap` is
 * exceeded (oldest pruned first).
 *
 * Determinism: id generation is delegated to the injected `mintId`
 * callback. The default is a monotonically increasing counter so tests
 * stay stable without time mocks; production wires a `crypto.randomUUID`
 * via the assembler.
 */

import { err, ok, omitUndef, type Result } from "@/shared"
import type { RadarOpError, RadarStore } from "./port"
import type { BugFixProposalMetadata, CardStatus, ProposeOpts, RadarCard } from "./types"

export interface InMemoryRadarStoreOpts {
  /** Maximum number of cards retained across ALL statuses. Default: 256. */
  readonly cap?: number
  /** Id generator. Default: deterministic counter (`radar-card-<n>`). */
  readonly mintId?: () => string
}

const DEFAULT_CAP = 256

const defaultMintId = (): (() => string) => {
  let n = 0
  return () => {
    n += 1
    return `radar-card-${n}`
  }
}

const freezeBugFix = (metadata: BugFixProposalMetadata): BugFixProposalMetadata =>
  Object.freeze({
    errorSummary: metadata.errorSummary,
    file: metadata.file,
    line: metadata.line,
    hypothesisRanked: Object.freeze(
      metadata.hypothesisRanked.map((hypothesis) => Object.freeze({ ...hypothesis })),
    ),
    ...(metadata.verifyRail !== undefined ? { verifyRail: metadata.verifyRail } : {}),
  })

const freezeCard = (c: RadarCard): RadarCard =>
  Object.freeze({
    ...c,
    ...(c.bugFix !== undefined ? { bugFix: freezeBugFix(c.bugFix) } : {}),
  })

export class InMemoryRadarStore implements RadarStore {
  private readonly cap: number
  private readonly mintId: () => string
  private readonly cards: Map<string, RadarCard> = new Map()

  constructor(opts: InMemoryRadarStoreOpts = {}) {
    this.cap = opts.cap ?? DEFAULT_CAP
    this.mintId = opts.mintId ?? defaultMintId()
  }

  proposeCard(opts: ProposeOpts): RadarCard {
    const id = this.mintId()
    const base = {
      id,
      kind: opts.kind,
      title: opts.title,
      description: opts.description,
      sessionId: opts.sessionId,
      createdAtMs: opts.createdAtMs,
      status: "active" as const,
      engagementCount: 0,
      ...(opts.bugFix !== undefined ? { bugFix: opts.bugFix } : {}),
    }
    const card: RadarCard = freezeCard(omitUndef(base) as RadarCard)
    this.cards.set(id, card)
    this.evictIfOverCap()
    return card
  }

  listActive(): readonly RadarCard[] {
    const active: RadarCard[] = []
    for (const c of this.cards.values()) {
      if (c.status === "active") active.push(c)
    }
    active.sort((a, b) => a.createdAtMs - b.createdAtMs)
    return Object.freeze(active)
  }

  setStatus(id: string, status: CardStatus): Result<RadarCard, RadarOpError> {
    const cur = this.cards.get(id)
    if (!cur) return err<RadarOpError>("not-found")
    const next: RadarCard = freezeCard({ ...cur, status })
    this.cards.set(id, next)
    return ok(next)
  }

  recordEngagement(id: string): Result<RadarCard, RadarOpError> {
    const cur = this.cards.get(id)
    if (!cur) return err<RadarOpError>("not-found")
    if (cur.status !== "active") return err<RadarOpError>("not-active")
    const next: RadarCard = freezeCard({
      ...cur,
      engagementCount: cur.engagementCount + 1,
    })
    this.cards.set(id, next)
    return ok(next)
  }

  prune(olderThanMs: number, now: number): number {
    let pruned = 0
    const cutoff = now - olderThanMs
    for (const [id, c] of this.cards) {
      if (c.status === "active" && c.createdAtMs < cutoff) {
        this.cards.set(id, freezeCard({ ...c, status: "expired" }))
        pruned += 1
      }
    }
    return pruned
  }

  /**
   * Evict oldest cards (by `createdAtMs`) when over cap. Evicts across
   * ALL statuses — the cap is a memory ceiling, not an active-only
   * ceiling. Run after every `proposeCard`.
   */
  private evictIfOverCap(): void {
    if (this.cards.size <= this.cap) return
    const sorted = [...this.cards.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)
    const overflow = this.cards.size - this.cap
    for (let i = 0; i < overflow; i++) {
      const victim = sorted[i]
      if (victim) this.cards.delete(victim.id)
    }
  }
}
