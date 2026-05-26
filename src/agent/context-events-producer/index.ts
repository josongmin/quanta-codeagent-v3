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
 * Surface (3 names):
 *   - {@link createContextEventsProducer} — closure factory
 *   - types: {@link ContextSnapshotInput}, {@link ContextEventsProducerConfig}
 */

export { createContextEventsProducer } from "./factory"
export type { ContextEventsProducerConfig, ContextSnapshotInput } from "./types"
