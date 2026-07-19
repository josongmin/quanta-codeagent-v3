/**
 * ADR-0281 — `src/memory/auto-trigger/` barrel.
 *
 * Resolves the memory-auto environment gate and the promotion policy consumed
 * by the live session-end consolidator. The consolidator owns execution; this
 * slice deliberately contains no alternate trigger port or implementation.
 */

export {
  DEFAULT_TRIGGER_POLICY,
  type TriggerPolicy,
} from "./types"
export { assembleMemoryAuto, type MemoryAutoSlot } from "./wire"
