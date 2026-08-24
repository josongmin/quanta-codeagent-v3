/**
 * ADR-0281 — `src/memory/auto-trigger/` barrel.
 *
 * Resolves the memory-auto environment gate (`QUANTA_MEMORY_AUTO`, default
 * ON per ADR-0413) consumed by the live session-end consolidator. The
 * consolidator owns execution; this slice deliberately contains no alternate
 * trigger port or implementation. The promotion policy this slice used to
 * carry went with the cross-session injector (ADR-0556).
 */

export { assembleMemoryAuto, type MemoryAutoSlot } from "./wire"
