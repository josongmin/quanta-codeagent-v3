/**
 * RFC-01 A2 (aug-02 absorption) — durable checkpoint MAPPING capture.
 *
 * Binds an EXISTING ShadowOdb ref/SHA to a `turnId/messageId` boundary and
 * records it as a {@link RollbackCheckpointRecord} on the SavedSession snapshot
 * (RFC01-0). It resolves a rollback TARGET only from that persisted mapping —
 * it NEVER derives a target from a branch/path/PID/ordinal name (no heuristic
 * authority). This is the capture/resolve half; the intent→effect→terminal
 * ORDERING is the RFC01-3 coordinator's job, and the file-tree effect stays
 * with `ThreeWayRestorePort` + ShadowOdb (the single tree-mutation owner).
 *
 * What this module OWNS:
 *   - `captureCheckpoint` — take the current ShadowOdb head SHA (via the
 *     injected `registerHead`) and upsert a `{turnId,messageId,checkpointSha,
 *     expectedFileHashes}` record into the durable collection.
 *   - `resolveRollbackTarget` — resolve a target turn to its persisted
 *     checkpoint, or a TYPED refusal when there is no mapping (fail-closed → the
 *     coordinator performs NO restore).
 *
 * What this module MUST NOT do (guarded by the single-owner matrix):
 *   - create a second ODB / checkpoint backend / file writer,
 *   - guess a checkpoint from a branch/path/ordinal name,
 *   - mutate the working tree (that is `ThreeWayRestorePort`'s job).
 */

import {
  ROLLBACK_RECORD_VERSION,
  type RollbackCheckpointRecord,
  resolveCheckpointForTurn,
  upsertRollbackCheckpoint,
} from "@/session"

/** The single ShadowOdb capability this module needs: advance the shadow head
 *  and return its SHA. Injected (never constructed here) so the module stays
 *  I/O-light and unit-testable, and so the SHA is the SAME content-addressed ref
 *  the effect side will restore — no parallel identity. */
export interface CheckpointCapturePort {
  /** Record the current workspace state as a new shadow commit and return its
   *  SHA. Mirrors `ShadowOdb.registerHead`; injected so no branch/path is
   *  guessed. */
  registerHead(workspaceRoot: string): Promise<string>
}

/** Input for one checkpoint capture. `expectedFileHashes` is supplied by the
 *  caller (the boundary it observed) — this module does not invent hashes. */
export interface CaptureCheckpointInput {
  readonly workspace: string
  readonly turnId: string
  readonly messageId: string
  /** Path → content-hash the caller observed at this boundary. Empty object is
   *  a valid (non-lossy) record — "no tracked files at capture". */
  readonly expectedFileHashes: Readonly<Record<string, string>>
}

/** Result of a capture: the updated checkpoint collection (append/replace by
 *  boundary) plus the record that was written, so the caller can persist the
 *  collection through the RFC01-0 store in the SAME snapshot. */
export interface CaptureCheckpointResult {
  readonly checkpoints: readonly RollbackCheckpointRecord[]
  readonly record: RollbackCheckpointRecord
}

/**
 * Capture a durable checkpoint mapping. Calls the injected `registerHead` to get
 * the content-addressed SHA, then binds it to `(turnId, messageId)` and upserts
 * it into `existing` (same boundary ⇒ replace; new boundary ⇒ append). Returns
 * the updated collection for the caller to persist atomically. Throws only if
 * the injected port throws (the ShadowOdb error surfaces verbatim — fail-closed;
 * NO record is written on a failed head capture).
 */
export const captureCheckpoint = async (
  port: CheckpointCapturePort,
  existing: readonly RollbackCheckpointRecord[],
  input: CaptureCheckpointInput,
): Promise<CaptureCheckpointResult> => {
  const checkpointSha = await port.registerHead(input.workspace)
  const record: RollbackCheckpointRecord = {
    recordVersion: ROLLBACK_RECORD_VERSION,
    turnId: input.turnId,
    messageId: input.messageId,
    checkpointSha,
    // Copy so a later caller mutation cannot retroactively rewrite the durable
    // record (the record is the authoritative boundary hash set).
    expectedFileHashes: { ...input.expectedFileHashes },
  }
  return { checkpoints: upsertRollbackCheckpoint(existing, record), record }
}

/** Typed result of resolving a rollback target from the durable mapping. */
export type RollbackTargetResolution =
  | { readonly kind: "ok"; readonly checkpoint: RollbackCheckpointRecord }
  /** No persisted mapping for the target turn ⇒ fail-closed: the coordinator
   *  performs NO restore. This is the "missing mapping / moved SHA" refusal —
   *  the target is unknown, so nothing is mutated. */
  | { readonly kind: "missing"; readonly targetTurnId: string }

/**
 * Resolve a rollback target turn to its persisted checkpoint. Returns a typed
 * refusal when there is no mapping — the ONLY source of truth is the durable
 * record; a target turn with no recorded checkpoint is NEVER restored (no
 * ordinal/branch/path fallback). Pure.
 */
export const resolveRollbackTarget = (
  checkpoints: readonly RollbackCheckpointRecord[],
  targetTurnId: string,
): RollbackTargetResolution => {
  const checkpoint = resolveCheckpointForTurn(checkpoints, targetTurnId)
  if (checkpoint === undefined) return { kind: "missing", targetTurnId }
  return { kind: "ok", checkpoint }
}
