/**
 * jun-6 account rate-limit snapshot slice (default-OFF).
 *
 * Pure parser + per-route store + server-anchored empty-bucket policy + a
 * no-leak notify event. Imports nothing from the LLM error boundary or
 * `@/agent`; reuses B3's reset-band discipline via a parity-locked duplicate.
 * Wiring (header hook + gated pre-request delay) lives at the composition root —
 * see the slice header comments and the RFC §5 / §9.
 */

// §9.3 — account dual-window ratelimit (Codex used_percent/window_minutes
// per-account accumulation). Distinct from the single-window remaining/reset
// family below; lives in the same slice (shares the B3-parity reset band).
export type { DualWindowSnapshot, RateLimitWindow } from "./dual-window"
export { parseDualWindowSnapshot } from "./dual-window"
export type { RateLimitNotice } from "./notice"
export { snapshotToNotice } from "./notice"
export type { HeaderLookup, RateLimitSnapshot } from "./parse"
export {
  MAX_RESET_HORIZON_MS,
  parseCountRemainingPercent,
  parseRateLimitResetMs,
  parseRateLimitSnapshot,
} from "./parse"
export { MAX_PROACTIVE_DELAY_MS, proactiveDelayMs } from "./policy"
export type { RateLimitSnapshotStore } from "./store"
export { createRateLimitSnapshotStore } from "./store"
