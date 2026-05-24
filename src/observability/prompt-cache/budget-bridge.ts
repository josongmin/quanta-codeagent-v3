/**
 * Budget bridge (ADR-0179).
 *
 * Wires a `PromptCacheObserver` to a `BudgetLedger` (ADR-0138) so every call
 * to `observer.record(...)` ALSO flows into `ledger.record(...)` with the
 * matching `UsageEvent` shape. The two primitives stay independent at the
 * module-graph layer (the observer does NOT import the ledger at runtime in
 * `default.ts`; it only references it via a `BudgetLedger` interface TYPE
 * here at the bridge layer) — the surface composition root picks the wiring
 * by calling `wirePromptCacheToBudget(observer, ledger)`.
 *
 * Return value is a DEREGISTER function: invoke it to break the wire. After
 * deregister, subsequent `observer.record(...)` calls flow ONLY to the
 * observer; the ledger no longer receives them.
 *
 * Plane-clean: imports the `BudgetLedger` interface as a TYPE-only import
 * (no runtime coupling) + the observer port from sibling. NO `@/agent/loop`.
 */

import type { BudgetLedger, UsageEvent } from "@/agent/budget-ledger"
import type { CacheHitEvent, PromptCacheObserver } from "./types"

/** Translate a `CacheHitEvent` into the `UsageEvent` shape the budget
 *  ledger consumes. exactOptionalPropertyTypes — optional fields are
 *  OMITTED on the wire when absent (turnId is the only one we conditionally
 *  populate; we use turnIndex as the source). */
const toUsageEvent = (e: CacheHitEvent): UsageEvent => {
  // turnIndex is REQUIRED in CacheHitEvent (a number) but turnId in
  // UsageEvent is OPTIONAL string. We convert via `String(...)` when the
  // index is a sane integer; otherwise we omit (the ledger does not depend
  // on turnId for any computation).
  const base = {
    model: e.model,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    sessionId: e.sessionId,
    at: e.atMs,
  }
  const optional: { cacheReadTokens?: number; cacheWriteTokens?: number; turnId?: string } = {}
  if (e.cacheReadTokens > 0) optional.cacheReadTokens = e.cacheReadTokens
  if (e.cacheCreationTokens > 0) optional.cacheWriteTokens = e.cacheCreationTokens
  if (Number.isFinite(e.turnIndex) && e.turnIndex >= 0) {
    optional.turnId = `turn-${Math.floor(e.turnIndex)}`
  }
  return { ...base, ...optional }
}

/**
 * Wire a `PromptCacheObserver` to a `BudgetLedger`. Wraps `observer.record`
 * so every call ALSO invokes `ledger.record` with the matching `UsageEvent`.
 *
 * Returns a deregister function. After deregister:
 *   - `observer.record(...)` continues to update the observer's own
 *     aggregates (independent channel).
 *   - The ledger no longer receives events from THIS bridge (a different
 *     producer wiring the ledger directly is unaffected).
 *
 * Idempotent on deregister: calling the returned function twice is a no-op
 * the second time.
 *
 * Validation-error parity: a `negative-tokens` throw from `observer.record`
 * propagates BEFORE the ledger sees the event (the bridge calls the
 * observer first, and the throw aborts before the ledger call). This keeps
 * the two primitives consistent under bad input — neither sees the event
 * when validation fails.
 */
export const wirePromptCacheToBudget = (
  observer: PromptCacheObserver,
  ledger: BudgetLedger,
): (() => void) => {
  const original = observer.record.bind(observer)
  let active = true
  const wrapped = (event: CacheHitEvent): void => {
    // Observer first — its validation gates the ledger call too. If
    // observer.record throws, ledger.record is NOT invoked (atomicity:
    // either both primitives see a valid event, or neither does).
    original(event)
    if (!active) return
    ledger.record(toUsageEvent(event))
  }
  // Replace the method in-place; deregister restores the original.
  observer.record = wrapped
  return (): void => {
    if (!active) return
    active = false
    observer.record = original
  }
}
