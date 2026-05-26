/**
 * ADR-0323 — `src/memory/history-sanitization/` barrel.
 *
 * Sibling slice to `src/memory/stage1-store/` (same convention): exposes the
 * closed port, types, and the default `WorkingMemory`-backed factory. No
 * re-export from the parent `src/memory/index.ts` barrel — wiring this port
 * into a caller (e.g. the Anthropic adapter's 400-invalid_image branch) is a
 * follow-up ADR, default-OFF until then.
 */

export type { HistorySanitizationPort } from "./port"
export type { SanitizationReason, SanitizationResult } from "./types"
export { SANITIZATION_REASONS } from "./types"
export { createWorkingMemoryHistorySanitization } from "./working-memory-adapter"
