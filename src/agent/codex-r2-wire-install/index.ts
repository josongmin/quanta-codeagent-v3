/**
 * ADR-0332 — `src/agent/codex-r2-wire-install/` barrel.
 *
 * Single entry-point composition helper that fills the 6 ADR-0327-family
 * wire slots on an `AgentConfig`. Default-OFF: callers that do not
 * import this barrel get the byte-identical pre-ADR-0327 behaviour.
 *
 * NOT re-exported from `@/agent` — callers reach the slice via the
 * explicit `@/agent/codex-r2-wire-install` path. Stays a leaf so
 * composition roots that don't wire any Codex-r2 channels pay zero
 * import-time cost.
 */

export { installCodexR2Wires } from "./install"
export type { CodexR2WireDeps } from "./types"
export type { ImageSanitizationRetrySlotShape } from "./types-config"
