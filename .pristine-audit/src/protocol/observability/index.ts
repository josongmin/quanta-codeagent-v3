/**
 * ADR-0408 — Observability protocol slice barrel.
 *
 * Sole import path for the observability WS protocol types + codec helpers.
 * Slice fence: this module re-exports from `./messages`, which itself imports
 * TYPES ONLY from `@/agent/run-ledger`, `@/agent/objective`, and
 * `@/agent/approval-state-machine` — no runtime cross-slice.
 */

export type {
  ApprovalChange,
  ObservabilityDeltaMessage,
  ObservabilityMessage,
  ObservabilityMessageKind,
  ObservabilitySnapshotMessage,
  ObservabilityWireEnvelope,
  RunChange,
} from "./messages"
export {
  decodeObservabilityFrame,
  encodeObservabilityFrame,
  isObservabilityMessage,
  isObservabilityMessageKind,
  OBSERVABILITY_MESSAGE_KINDS,
  OBSERVABILITY_PROTOCOL_VERSION,
} from "./messages"
