/**
 * Public types for the `@/radar` slice (ADR-0231).
 *
 * The radar models a small background **proposal queue**: heuristics emit
 * `ProposeOpts`, the caller pushes them through a `RadarStore` (port.ts),
 * and the operator (today: a test harness; later: a UI) reviews and
 * accepts / dismisses each `RadarCard`.
 *
 * The 4-arm `CardStatus` union and 3-arm `CardKind` union are exhaustively
 * checked at the store boundary so adding an arm (or removing one) is a
 * compile-time error for every consumer — the union shape is the slice's
 * stable contract.
 *
 * Pure types — no `@/llm`, no `@/agent`, no `@/storage` reach. Slice is a
 * leaf below every operating slice.
 */

import { QuantaError } from "@/shared"

/**
 * What kind of proposal this card represents.
 *
 *  - `"suggestion"` — a recommended next action the operator may take
 *    (e.g. "run the failing test in isolation").
 *  - `"warning"`    — a heads-up about a likely problem (e.g. "this
 *    branch diverges from origin/main by 23 commits").
 *  - `"next-step"`  — the heuristic believes a specific follow-up turn
 *    would be valuable (e.g. "consider running `bun test tests/unit`
 *    after the patch lands").
 */
export type CardKind = "suggestion" | "warning" | "next-step" | "bug-fix"

/** A ranked, review-only bug-fix hypothesis captured from a diagnostic flow. */
export interface BugFixHypothesis {
  readonly cause: string
  readonly fix: string
  readonly confidence: "high" | "medium" | "low"
}

/** Structured metadata retained on a `kind:"bug-fix"` lifecycle card. */
export interface BugFixProposalMetadata {
  readonly errorSummary: string
  readonly file: string
  readonly line: number
  readonly hypothesisRanked: ReadonlyArray<BugFixHypothesis>
  readonly verifyRail?: string
}

/**
 * Lifecycle of a card in the queue.
 *
 *  - `"active"`    — the card is in the queue and visible to the
 *    operator. The default state minted by `proposeCard`.
 *  - `"adopted"`   — the operator confirmed the proposal (UI's
 *    "adoptSession" gesture). This is the strongest engagement signal
 *    a card can carry and is kept distinct from `"dismissed"` /
 *    `"expired"` for downstream scoring.
 *  - `"dismissed"` — the operator rejected the proposal.
 *  - `"expired"`   — the card aged out via `prune(olderThanMs, now)`.
 *
 * Once a card leaves `"active"` it no longer appears in `listActive()`
 * and cannot accept further `recordEngagement` (Err `"not-active"`).
 */
export type CardStatus = "active" | "adopted" | "dismissed" | "expired"

/**
 * A card in the radar queue. All fields are readonly; instances returned
 * by `RadarStore.listActive()` are also `Object.freeze`-d so mutation
 * attempts throw under strict mode.
 *
 * `sessionId` is optional: a proposal does not need to be tied to a
 * specific session (a generic "consider doing X" card has no session).
 * When present, the UI's `adoptSession` gesture navigates to it.
 */
export interface RadarCard {
  readonly id: string
  readonly kind: CardKind
  readonly title: string
  readonly description: string
  readonly sessionId?: string
  readonly createdAtMs: number
  readonly status: CardStatus
  readonly engagementCount: number
  /** Present only for a typed `kind:"bug-fix"` card. Adapters clone and
   * deeply freeze this payload before retaining it. */
  readonly bugFix?: BugFixProposalMetadata
}

/**
 * The surface a heuristic emits and the store consumes. The store mints
 * the `id` and forces `status = "active"` and `engagementCount = 0`;
 * supplying either here is silently ignored (the input shape simply
 * doesn't admit them).
 */
export interface ProposeOpts {
  readonly kind: CardKind
  readonly title: string
  readonly description: string
  readonly sessionId?: string
  readonly createdAtMs: number
  /** Required by the producer of a `kind:"bug-fix"` card. Kept optional at
   * this leaf port for backwards-compatible generic heuristic producers. */
  readonly bugFix?: BugFixProposalMetadata
}

/**
 * Slice-local error class. Extends `QuantaError` so the existing
 * `.code`-based handler chain (`@/shared` taxonomy) keeps working —
 * downstream branches on the string `code`, not on `instanceof`.
 *
 * The radar's port-level methods (`setStatus`, `recordEngagement`) do
 * NOT throw this — they return a `Result<T, "not-found" | "not-active">`
 * so the unhappy path is a value, not an exception. `RadarError` is
 * reserved for adapter-level surprises (jsonl I/O bubbling up to the
 * caller, hydration aborts, etc.).
 */
export class RadarError extends QuantaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("radar", message, options)
  }
}
