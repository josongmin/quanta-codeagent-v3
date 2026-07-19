/**
 * ADR-0329 — `src/agent/context-events-producer/` barrel.
 *
 * Closure-factory slice that fills the `AgentConfig.contextEventsForTurn`
 * slot introduced by ADR-0327. A single composition-root call wires
 * the producer; no other code is mutated.
 *
 * Sibling — NOT a re-export from `@/agent` — to keep the slice
 * default-OFF until ADR-0332 wires the composition root.
 *
 * Surface:
 *   - {@link createContextEventsProducer} — closure factory (WRITE side:
 *     detects context diffs and appends them to the typed-event store)
 *   - {@link makeTypedEventDebugEnricher} — the READ side: drains the
 *     typed-event store into the bench trajectory debug-sink (ADR-0336)
 *   - types: {@link ContextSnapshotInput}, {@link ContextEventsProducerConfig},
 *     {@link TypedEventDebugEnricher}
 */

export { createContextEventsProducer } from "./factory"
export {
  makeTypedEventDebugEnricher,
  TYPED_EVENTS_DEBUG_KEY,
  type TypedEventDebugEnricher,
} from "./debug-enricher"
export type { ContextEventsProducerConfig, ContextSnapshotInput } from "./types"
