/**
 * RFC-03 C2 — the SINGLE production objective-authority builder + the persistence
 * ENCODE adapter.
 *
 * This is THE one place production code constructs the per-session objective
 * authority (mirrors RFC-04 D4's `ActivityStore` single-owner pattern). Every
 * surface — host objective wire, CLI core-state, agent observability wire —
 * routes construction through {@link buildObjectiveAuthority} instead of minting
 * its own `createObjectiveStore()` fallback (pinned by the objective
 * constructor-owner ratchet).
 *
 * `runner/assemble` is the Layer-2 composition seam, so it MAY import the
 * `@/objective` domain (construction) AND the `@/session` DTO (persistence). The
 * `@/session` slice itself never imports `@/objective`: it stores/loads only the
 * plain JSON {@link PersistedObjectiveSnapshot}, and the encode/decode ADAPTER
 * lives here.
 *
 * Fixed restore order: session identity → SAVED OBJECTIVE (`restoreFrom`) →
 * policy binding (`gateOn`/`confirmationAvailable`) → AUTHORITY CONSTRUCTION.
 * `restoreFrom` is decoded (`./restore`) into ordered per-thread domain
 * snapshots handed to the authority's `restoreDomains` construction seam, so a
 * fresh runtime rebuilds a byte-equivalent snapshot (ids / revision / provenance
 * preserved). Absent ⇒ a fresh empty authority (byte-identical legacy).
 *
 * exactOptionalPropertyTypes: optional fields are OMITTED when absent.
 */

import { asObjectiveAuthority, createObjectiveAuthority, type ObjectivePort } from "@/objective"
import {
  OBJECTIVE_SNAPSHOT_VERSION,
  type PersistedObjectiveSnapshot,
  type PersistedObjectiveThread,
} from "@/session"
import { decodeObjectiveSnapshot } from "./restore"

/** Inputs to {@link buildObjectiveAuthority}. All optional — the default is a
 *  fresh, gate-OFF, informational authority (byte-identical to the legacy
 *  `createObjectiveStore()`). */
export interface BuildObjectiveAuthorityInput {
  /** Injected clock seam (default `Date.now`). */
  readonly now?: () => number
  /** H17 budget/usage derivation — forwarded from `QUANTA_OBJECTIVE_BUDGET_ENFORCE`
   *  by the surface that owns that gate. */
  readonly enforceBudget?: boolean
  /** RFC-03 `QUANTA_PROPOSE_GOAL` posture (default OFF ⇒ byte-identical legacy). */
  readonly gateOn?: boolean
  /** Whether the surface can raise an approval dialog (fail-closed under the
   *  gate when false). */
  readonly confirmationAvailable?: boolean
  /** RFC-03 C2 — durable resume: a previously persisted objective snapshot to
   *  restore at construction (ids / revision / provenance preserved). Absent ⇒
   *  a fresh empty authority. */
  readonly restoreFrom?: PersistedObjectiveSnapshot | undefined
}

/**
 * Construct THE per-session objective authority (typed as `ObjectivePort` — the
 * surface every consumer binds; the richer `ObjectiveAuthority` protocol is
 * recovered via `asObjectiveAuthority`). When `restoreFrom` is supplied, its
 * threads are decoded and restored verbatim as part of construction (fixed
 * restore order). This is the one production objective constructor owner.
 */
export const buildObjectiveAuthority = (input: BuildObjectiveAuthorityInput = {}): ObjectivePort =>
  createObjectiveAuthority({
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.enforceBudget !== undefined ? { enforceBudget: input.enforceBudget } : {}),
    ...(input.gateOn !== undefined ? { gateOn: input.gateOn } : {}),
    ...(input.confirmationAvailable !== undefined
      ? { confirmationAvailable: input.confirmationAvailable }
      : {}),
    ...(input.restoreFrom !== undefined
      ? { restoreDomains: decodeObjectiveSnapshot(input.restoreFrom) }
      : {}),
  })

/**
 * ENCODE the live objective authority into the durable session DTO: every live
 * thread's full state + its per-thread `revision` (read via the authority's
 * `readDomain` protocol) + its persisted explicit-status intent (provenance).
 * The result is plain JSON — the session store persists it as-is. Threads with
 * no state (e.g. a bare port double that lists nothing) are dropped. The thread
 * order is the port's list order (deterministic).
 */
export const encodeObjectiveSnapshot = (port: ObjectivePort): PersistedObjectiveSnapshot => {
  const authority = asObjectiveAuthority(port)
  const threads: PersistedObjectiveThread[] = []
  for (const o of port.list()) {
    const dom = authority.readDomain(o.threadId)
    if (dom.state === null) continue
    const state = dom.state
    const obj = state.objective
    threads.push({
      threadId: obj.threadId,
      revision: dom.revision,
      goal: obj.goal,
      successCriteria: obj.successCriteria.map((c) => ({ id: c.id, text: c.text, met: c.met })),
      status: obj.status,
      explicitStatus: state.explicitStatus,
      ...(state.usageLimitedUntil !== undefined
        ? { usageLimitedUntil: state.usageLimitedUntil }
        : {}),
      budget: {
        tokensUsed: obj.budget.tokensUsed,
        turnsUsed: obj.budget.turnsUsed,
        ...(obj.budget.maxTokens !== undefined ? { maxTokens: obj.budget.maxTokens } : {}),
        ...(obj.budget.maxTurns !== undefined ? { maxTurns: obj.budget.maxTurns } : {}),
      },
      blockers: obj.blockers.map((b) => ({
        id: b.id,
        reason: b.reason,
        waitingOn: b.waitingOn,
        since: b.since,
      })),
      nextActions: [...obj.nextActions],
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
    })
  }
  return { version: OBJECTIVE_SNAPSHOT_VERSION, threads }
}
