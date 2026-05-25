/**
 * Headless deterministic `RadarStore` stub (ADR-0231).
 *
 * For tests of callers that need a `RadarStore` shape but do NOT
 * exercise the proposal queue. Every method is a deterministic no-op:
 *
 *  - `proposeCard` always returns the same "headless" card (same id, same
 *    body) but the card is never retained — `listActive` is always
 *    empty.
 *  - `listActive` returns the same frozen empty array singleton.
 *  - `setStatus` / `recordEngagement` always return `Err("not-found")`
 *    (there is nothing to update).
 *  - `prune` always returns `0`.
 *
 * Use this when a code path takes a `RadarStore` for shape conformance
 * but the radar is not the slice under test (e.g. assembling an agent
 * with the radar field present but no behaviour expected). The real
 * adapters live in `in-memory-store.ts` and `jsonl-file-store.ts`.
 */

import { err, type Result } from "@/shared"
import type { RadarOpError, RadarStore } from "./port"
import type { CardStatus, ProposeOpts, RadarCard } from "./types"

const HEADLESS_CARD: RadarCard = Object.freeze({
  id: "radar-headless",
  kind: "suggestion",
  title: "(headless)",
  description: "(headless stub — proposal not retained)",
  createdAtMs: 0,
  status: "active",
  engagementCount: 0,
})

const EMPTY: readonly RadarCard[] = Object.freeze([])

export class HeadlessRadarStore implements RadarStore {
  proposeCard(_opts: ProposeOpts): RadarCard {
    return HEADLESS_CARD
  }

  listActive(): readonly RadarCard[] {
    return EMPTY
  }

  setStatus(_id: string, _status: CardStatus): Result<RadarCard, RadarOpError> {
    return err<RadarOpError>("not-found")
  }

  recordEngagement(_id: string): Result<RadarCard, RadarOpError> {
    return err<RadarOpError>("not-found")
  }

  prune(_olderThanMs: number, _now: number): number {
    return 0
  }
}
