/**
 * Context-change typed event surface for ADR-0321.
 *
 * Re-exports the foundation port from ADR-0320 (`@/memory/typed-event`)
 * under the names this slice was authored against. ADR-0321 was drafted
 * in parallel with ADR-0320 with a local mock; main-integration replaces
 * the mock with a re-export so the two slices share one ground truth.
 *
 * Name mapping (ADR-0321 local → ADR-0320 export):
 *   ContextEvent                 → TypedHistoryEvent
 *   TypedHistoryEventStorePort   → TypedHistoryEventStore
 *
 * The W-A `TypedHistoryEventStore` adds one method (`clear()`) over the
 * W-B mock; the extra method is a superset and ABI-compatible — none of
 * this slice's consumers call `clear()`.
 *
 * Codex absorption: `codex-rs/core/src/session/turn.rs:161`
 * (`record_context_updates_and_set_reference_context_item`).
 *
 * Default-OFF: NO production path imports from this module. The slice
 * stays additive — detector + injector are pure functions, the port is
 * contractually consumed via dependency-injection by future wire-up.
 */

import type { TypedHistoryEvent, TypedHistoryEventStore } from "@/memory/typed-event"

/** Alias for {@link TypedHistoryEvent}. Kept for ADR-0321 source compatibility. */
export type ContextEvent = TypedHistoryEvent

/** Alias for {@link TypedHistoryEventStore}. Kept for ADR-0321 source compatibility. */
export type TypedHistoryEventStorePort = TypedHistoryEventStore
