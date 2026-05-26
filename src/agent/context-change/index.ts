/**
 * Context-change slice barrel (ADR-0319 — renumbered from requested 0301 due
 *   to collision with existing `0301-playbook-trigger-flag-echo`).
 *
 * Codex absorption: `codex-rs/core/src/session/turn.rs:161`
 *   `record_context_updates_and_set_reference_context_item`. The pattern:
 *   detect turn-boundary state changes, emit typed events into a persistent
 *   history stream (W-A port — `TypedHistoryEventStorePort`), and splice
 *   diff-envelope user-role messages into the per-turn prompt assembly
 *   so the model sees "what changed" instead of only "what is now".
 *
 * Distinct from the ephemeral `<system-reminder>` tail in `src/agent/prompt.ts`:
 *   - reminder tail = CURRENT state echo (cwd, date, mode notice). Stateless.
 *   - this slice    = HISTORIC diff envelope. Eventful. Persistent (via W-A).
 *
 * Default-OFF: NO production code imports from this module. The detector +
 *   injector are pure; the typed-history port is consumer-injected. Wire-up
 *   lands in a follow-up PR once W-A's port ships (signatures align by
 *   design).
 *
 * Barrel surface (5 names):
 *   - {@link detectContextChanges}         — pure diff detector
 *   - {@link captureSnapshot}              — ephemeral state-capture helper
 *   - {@link buildPersistentInjectionMessages} — pure event → Message[] builder
 *   - types: {@link ContextEvent}, {@link TypedHistoryEventStorePort},
 *            {@link TurnStateSnapshot}, {@link DetectorMeta}
 */

export { type DetectorMeta, detectContextChanges } from "./detector"
export { buildPersistentInjectionMessages } from "./inject"
export { captureSnapshot, type TurnStateSnapshot } from "./snapshot"
export type { ContextEvent, TypedHistoryEventStorePort } from "./types"
