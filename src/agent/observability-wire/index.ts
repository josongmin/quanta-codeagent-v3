/**
 * ADR-0406 — Composition-root observability wire barrel.
 *
 * The ONLY allowed import path for `@/agent/observability-wire`. Re-exports
 * the public seam (`wireObservability`) + the typed handle / opts contract.
 *
 * Default-OFF & self-contained: importing this barrel allocates nothing,
 * touches no process state, and pulls in zero peer slices beyond the four
 * wave-1/2 sealed slices the wire stitches together (objective / run-ledger /
 * approval-state-machine / shadow-verify) + the attribution slice.
 */

export type { ApprovalAttributionGap } from "@/agent/approval-state-machine"
export {
  OBSERVABILITY_WIRE_SLOTS,
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  type ObservabilityWireOpts,
  type ObservabilityWirePortError,
  type ObservabilityWireSlot,
} from "./types"
export { wireObservability } from "./wire"
