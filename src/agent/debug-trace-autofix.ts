/**
 * Bug-fix proposal queue (ADR-0186) — DEBUG-TRACE AUTOMATED BUG-FIX LOOP
 * follow-up to ADR-0181 (debug/blame skills trio).
 *
 * PURE in-memory capture-and-list primitive. The `debug-trace` skill (and any
 * sibling diagnostic workflow) calls `capture()` with a structured
 * `{file:line, hypothesis, proposed-fix}` envelope; the caller (slash router,
 * planner UI, or test rig) drains them via `list()` for HUMAN review before
 * any source change.
 *
 * ## CRITICAL INVARIANT
 *
 * **This queue does NOT modify source code.** It is a capture-and-list primitive
 * only. Auto-apply is a separate slice (deferred to Phase 2) and requires a
 * safety design that this primitive deliberately does NOT take on:
 *   - verify-guard wire (must run failing scenario before / after the patch),
 *   - shadow rewind anchor (must be able to rollback on test regression),
 *   - retry budget cap (must bound attempts per session to prevent thrash).
 *
 * Until that slice ships, the contract is conservative: capture proposals,
 * surface them to a human, let the human apply or reject. This matches the
 * industry posture documented in
 * `docs/analysis/경쟁사리뷰/code-agent-loop/cursor.md`: Cursor surfaces
 * Bugbot findings + LSP code actions for manual click, not autonomous apply.
 *
 * ## Default-OFF
 *
 * Nobody wires this today. The `debug-trace` skill writes to it when the
 * caller injects a queue port; absent that, the skill renders proposals to the
 * model output as it does today (no behavior change). This file is a typed
 * sink waiting for opt-in.
 *
 * ## Plane-clean imports
 *
 * Imports ONLY `node:crypto` for the default id generator. No `@/observability`,
 * `@/tool`, `@/llm`, `@/agent/loop`. This is a leaf primitive — the consumer
 * (skill body / slash router) bridges it to its surfaces.
 */

import { randomBytes } from "node:crypto"

/** A single ranked hypothesis paired with a fix. Caller supplies these in
 *  rank order (most-likely first); the queue PRESERVES order — no reranking. */
export interface BugFixHypothesis {
  /** One line, plain English. e.g. "off-by-one: end exclusive in slice but
   *  used as inclusive in the assertion". */
  readonly cause: string
  /** One line, what to change. e.g. "change `arr.slice(0, n)` to `arr.slice(0, n + 1)`". */
  readonly fix: string
  /** Confidence label. Caller's self-assessment; the queue does not validate. */
  readonly confidence: "high" | "medium" | "low"
}

/** One captured hypothesis envelope from a debug-trace skill run. */
export interface BugFixProposal {
  /** Stable id, format `bf-<hex>`. Used by `resolve()`. */
  readonly id: string
  /** Epoch-ms timestamp from the injected clock at the time `capture()` was called. */
  readonly capturedAt: number
  /** One line. e.g. "TypeError: Cannot read property 'x' of undefined". */
  readonly errorSummary: string
  /** Repo-relative path. The queue does NOT validate the path exists. */
  readonly file: string
  /** 1-indexed line number. The queue does NOT validate the line exists. */
  readonly line: number
  /** RANKED (most likely first). Caller-supplied order is preserved. */
  readonly hypothesisRanked: ReadonlyArray<BugFixHypothesis>
  /** Optional: the verification command the human (or Phase 2 auto-apply) should
   *  run to confirm the fix. e.g. "bun test tests/unit/foo.test.ts". OMITTED
   *  when unknown — never set to `undefined` (exactOptionalPropertyTypes). */
  readonly verifyRail?: string
}

/** Typed error class for input validation. Programmer-bug only — public
 *  surface methods never throw on operational misuse (unknown id → false). */
export class BugFixProposalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BugFixProposalError"
  }
}

/** Capture-and-list primitive. Pure in-memory. */
export interface BugFixProposalQueue {
  /** Capture a proposal. Returns its newly-minted id. Throws
   *  {@link BugFixProposalError} on missing/invalid required fields. */
  capture(p: Omit<BugFixProposal, "id" | "capturedAt">): string
  /** Snapshot pending proposals, NEWEST first. Returned array is a fresh
   *  frozen copy — callers may iterate but not mutate. */
  list(): ReadonlyArray<BugFixProposal>
  /** Remove a proposal. Returns `true` if it was present and removed,
   *  `false` if the id was unknown (idempotent — second call with same id
   *  also returns false). NEVER throws. */
  resolve(id: string): boolean
  /** Drop every entry. */
  clear(): void
}

export interface BugFixProposalQueueOpts {
  /** Cap on the number of pending proposals. When `capture` would exceed it,
   *  LRU eviction fires (oldest dropped). Default: 50. Clamped to a minimum
   *  of 1 (a queue with cap 0 would be useless). */
  readonly maxEntries?: number
  /** Injected clock. Default: `Date.now`. Tests pin it for deterministic
   *  `capturedAt` and byte-identical `list()` output. */
  readonly now?: () => number
  /** Injected id generator. Default: `bf-<8-hex>` from `crypto.randomBytes(4)`.
   *  Tests inject a deterministic counter to assert ordering / parity. */
  readonly idGen?: () => string
}

const DEFAULT_MAX_ENTRIES = 50

const defaultIdGen = (): string => `bf-${randomBytes(4).toString("hex")}`

/** Validate required fields. Throws {@link BugFixProposalError} on miss. */
const validateInput = (p: Omit<BugFixProposal, "id" | "capturedAt">): void => {
  if (typeof p.errorSummary !== "string" || p.errorSummary.length === 0) {
    throw new BugFixProposalError("capture: errorSummary must be a non-empty string")
  }
  if (typeof p.file !== "string" || p.file.length === 0) {
    throw new BugFixProposalError("capture: file must be a non-empty string")
  }
  if (typeof p.line !== "number" || !Number.isInteger(p.line) || p.line < 1) {
    throw new BugFixProposalError("capture: line must be a positive integer (1-indexed)")
  }
  if (!Array.isArray(p.hypothesisRanked)) {
    throw new BugFixProposalError("capture: hypothesisRanked must be an array")
  }
}

/**
 * Default queue impl. In-memory Map preserves insertion order; we use that
 * for LRU. New entries land at the "newest" end; eviction drops the oldest.
 *
 * The queue does NOT distinguish "resolved" from "evicted" — a resolved
 * entry is simply removed. There is no parallel "history" view (would be a
 * Phase 2 follow-up if review-after-apply audit is wanted).
 */
export const defaultBugFixProposalQueue = (opts?: BugFixProposalQueueOpts): BugFixProposalQueue => {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const now = opts?.now ?? Date.now
  const idGen = opts?.idGen ?? defaultIdGen

  // Map iteration is insertion-ordered. Oldest sits at the head; newest at
  // the tail. `list()` reverses to emit newest-first.
  const store = new Map<string, BugFixProposal>()

  const evictIfOver = (): void => {
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value
      if (oldestKey === undefined) break
      store.delete(oldestKey)
    }
  }

  return {
    capture(p) {
      validateInput(p)
      const id = idGen()
      // Freeze the hypothesisRanked array so caller mutations after capture
      // don't corrupt the stored proposal.
      const proposal: BugFixProposal = {
        id,
        capturedAt: now(),
        errorSummary: p.errorSummary,
        file: p.file,
        line: p.line,
        hypothesisRanked: Object.freeze(
          p.hypothesisRanked.slice(),
        ) as ReadonlyArray<BugFixHypothesis>,
        // exactOptionalPropertyTypes: only spread `verifyRail` when present.
        ...(p.verifyRail !== undefined ? { verifyRail: p.verifyRail } : {}),
      }
      store.set(id, Object.freeze(proposal))
      evictIfOver()
      return id
    },

    list() {
      // Map iterates oldest → newest; we want newest first.
      const out: BugFixProposal[] = []
      for (const proposal of store.values()) out.unshift(proposal)
      return Object.freeze(out) as ReadonlyArray<BugFixProposal>
    },

    resolve(id) {
      return store.delete(id)
    },

    clear() {
      store.clear()
    },
  }
}
