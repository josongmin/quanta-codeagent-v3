/**
 * ADR-0409 — recovery-reason slice barrel.
 *
 * Leaf slice — ZERO runtime deps. Re-exports the closed enum + provenance
 * shape so consumers (`@/agent/compaction.ts`, the `post_compact` hook
 * subscriber, observability emitters) import from one stable path.
 */
export {
  isRecoveryReason,
  RECOVERY_REASONS,
  type RecoveryProvenance,
  type RecoveryReason,
} from "./types"
