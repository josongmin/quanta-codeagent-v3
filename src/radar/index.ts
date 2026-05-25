/**
 * `@/radar` slice barrel — ADR-0231 (radar cards proposal queue MVP).
 *
 * Surface:
 *   - `RadarStore` port (5 methods) + 2 adapters + 1 headless stub
 *   - 1 sample heuristic
 *
 * Default-OFF: no other slice imports `@/radar` in V1. The store is
 * constructed only by opt-in call sites (V1: tests). UI integration
 * (`apps/cli`, `apps/web`) is deferred to a follow-up.
 */

export { HeadlessRadarStore } from "./headless-stub"
export type { IdleLongTaskInputs } from "./heuristics/idle-long-task"
export { proposeOnIdleForLongTask } from "./heuristics/idle-long-task"
export { InMemoryRadarStore, type InMemoryRadarStoreOpts } from "./in-memory-store"
export { JsonlFileRadarStore, type JsonlFileRadarStoreOpts } from "./jsonl-file-store"
export type { RadarOpError, RadarStore } from "./port"
export type { CardKind, CardStatus, ProposeOpts, RadarCard } from "./types"
export { RadarError } from "./types"
