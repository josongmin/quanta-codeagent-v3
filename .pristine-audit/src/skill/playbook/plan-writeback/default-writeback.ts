/**
 * Default `PlanWriteback` adapter (ADR-0259) — Map-backed in-memory queue.
 *
 * One instance binds to ONE active planId; callers managing N parallel plans
 * construct N instances. `recordedAt` uses an internal monotonic counter
 * (NOT `Date.now()`) so two record calls in the same wall-clock millisecond
 * remain order-stable AND tests do not need to inject a fake clock.
 *
 * The optional `knownPlanIds` allow-list seals HELL-PW-04: if the active
 * `planId` is not present in `knownPlanIds`, every `recordFinding` call
 * returns `Err("plan-not-found")` — NEVER throws. When `knownPlanIds` is
 * omitted the writeback trusts the supplied planId (legacy path; the
 * hellgate's "known plan" path explicitly passes the list).
 *
 * Slice posture: leaf adapter. Imports only `./types` and `./port`. No fs,
 * no clock, no logger. Default-OFF: nothing here is invoked unless a host
 * explicitly constructs an instance.
 */

import type { PlanWriteback } from "./port"
import type { Finding, PlanUpdate, Result, WritebackError } from "./types"

/**
 * Construction spec for {@link createDefaultWriteback}.
 *
 * - `planId`        — the plan id this writeback binds to. Whitespace-only
 *                     planId is treated as "no active plan" → every record
 *                     fails plan-not-found.
 * - `knownPlanIds`  — optional allow-list of plan ids that exist in the
 *                     host's plan registry. When supplied AND `planId` is
 *                     not in the list, every recordFinding returns
 *                     `Err("plan-not-found")` (HELL-PW-04). When omitted,
 *                     the writeback trusts the supplied planId.
 */
export interface DefaultWritebackSpec {
  readonly planId: string
  readonly knownPlanIds?: readonly string[]
}

export function createDefaultWriteback(spec: DefaultWritebackSpec): PlanWriteback {
  const { planId: activePlanId } = spec
  const store = new Map<string, PlanUpdate[]>()
  // Monotonic counter — instance-local; ensures HELL-PW-09 / HELL-PW-13 even
  // when two record calls share a wall-clock ms. Opaque to consumers.
  let nextOrdinal = 1

  const isBlank = (s: string): boolean => s.trim().length === 0

  // Pre-compute plan-not-found verdict once at construction; avoids a per-
  // record set lookup. If knownPlanIds was supplied AND active not in it →
  // plan-not-found. If active is blank → plan-not-found. Otherwise OK.
  const planNotFound: boolean =
    isBlank(activePlanId) ||
    (spec.knownPlanIds !== undefined && !spec.knownPlanIds.includes(activePlanId))

  const recordFinding = (skillId: string, finding: Finding): Result<PlanUpdate, WritebackError> => {
    if (planNotFound) {
      return { ok: false, error: { kind: "plan-not-found" } }
    }
    if (isBlank(skillId)) {
      return { ok: false, error: { kind: "skill-id-empty" } }
    }
    if (isBlank(finding.text)) {
      return { ok: false, error: { kind: "empty-text" } }
    }

    const update: PlanUpdate = Object.freeze({
      planId: activePlanId,
      skillId,
      // Defensive freeze — caller might hand us a non-frozen literal; we
      // defend against object-literal mutation downstream (HELL-PW-15).
      finding: Object.freeze({ ...finding }),
      recordedAt: nextOrdinal++,
    })

    const bucket = store.get(activePlanId)
    if (bucket === undefined) {
      store.set(activePlanId, [update])
    } else {
      bucket.push(update)
    }
    return { ok: true, value: update }
  }

  const getUpdates = (planId: string): readonly PlanUpdate[] => {
    if (planId !== activePlanId) {
      return Object.freeze([])
    }
    const bucket = store.get(planId)
    if (bucket === undefined || bucket.length === 0) {
      return Object.freeze([])
    }
    // Snapshot + freeze — consumer cannot mutate our internal array
    // (HELL-PW-11).
    return Object.freeze(bucket.slice())
  }

  const clearUpdates = (planId: string): void => {
    if (planId !== activePlanId) {
      return
    }
    store.delete(planId)
  }

  return { recordFinding, getUpdates, clearUpdates }
}
