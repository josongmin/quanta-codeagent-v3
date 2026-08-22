/**
 * RFC-01 A2 — durable ThreadRollback record helpers (aug-02 absorption).
 *
 * PURE data helpers + zod schemas for the optional `rollbackCheckpoints[]` /
 * `rollbackOperations[]` collections on {@link SavedSession}. These ride the
 * EXISTING atomic snapshot (`saveSessionById`/`loadSessionById`) — there is NO
 * new store, writer, hash helper, JSONL truncate, or ODB here. The `@/session`
 * slice owns the record SHAPE and its validation; the working-tree effect stays
 * with `ThreeWayRestorePort`; the intent→effect→terminal ORDERING is the
 * `@/agent` coordinator's job (`thread-rollback`).
 *
 * Idempotency + fail-closed contract:
 *   - `operationId` is the idempotency key. Recording the intent twice is a
 *     no-op; recording a terminal receipt for an already-terminal operation is
 *     a no-op (the first terminal wins). `latestOperation` collapses the
 *     append-only record list to the current state of one operation.
 *   - Migration is FORWARD-ONLY and LOSSLESS: absent collections read as `[]`;
 *     an unknown `recordVersion` or an unknown operation `state` makes the
 *     WHOLE snapshot refuse to load (see `store.ts` — never partially applied).
 *
 * No behaviour, no I/O, no clock — the coordinator injects `requestedAt` /
 * `terminalAt` from its own injected clock so these helpers stay deterministic.
 */

import { z } from "zod"
import {
  ROLLBACK_RECORD_VERSION,
  type RollbackCheckpointRecord,
  type RollbackOperationRecord,
  type RollbackOperationState,
} from "./types"

/* ------------------------------------------------------------------ */
/* zod schemas (consumed by the store loader — single SSOT)            */
/* ------------------------------------------------------------------ */

/** Closed lifecycle enum — a wire value outside this set fail-closes the load
 *  (zod `enum` rejects unknown strings). Mirrors {@link RollbackOperationState}
 *  exactly; adding a state here is a compile-forced update at every consumer. */
export const rollbackOperationStateSchema: z.ZodType<RollbackOperationState> = z.enum([
  "requested",
  "rolled_back",
  "rollback_failed",
])

/** A durable checkpoint mapping. `recordVersion` is pinned to the current
 *  literal so a forward-incompatible record refuses to load rather than being
 *  half-read. `expectedFileHashes` is a string→string map (empty allowed). */
export const rollbackCheckpointRecordSchema = z.object({
  recordVersion: z.literal(ROLLBACK_RECORD_VERSION),
  turnId: z.string().min(1),
  messageId: z.string().min(1),
  checkpointSha: z.string().min(1),
  expectedFileHashes: z.record(z.string(), z.string()),
})

/** A durable rollback-operation receipt. Optional fields use `.optional()` so
 *  a `requested` record (no terminal yet) validates; `errorCode` is only
 *  meaningful on `rollback_failed` but is not cross-field-enforced here (the
 *  coordinator owns that invariant). */
export const rollbackOperationRecordSchema = z.object({
  recordVersion: z.literal(ROLLBACK_RECORD_VERSION),
  operationId: z.string().min(1),
  targetTurnId: z.string().min(1),
  state: rollbackOperationStateSchema,
  requestedAt: z.number().finite(),
  terminalAt: z.number().finite().optional(),
  errorCode: z.string().min(1).optional(),
})

/* ------------------------------------------------------------------ */
/* pure record helpers                                                 */
/* ------------------------------------------------------------------ */

/** `true` iff `state` is a terminal receipt (no further transition). */
export const isTerminalRollbackState = (state: RollbackOperationState): boolean =>
  state === "rolled_back" || state === "rollback_failed"

/**
 * Collapse the append-only operation list to the CURRENT record for
 * `operationId`. A terminal receipt always wins over a pending `requested`
 * (so a duplicate submit after completion resolves to the terminal outcome);
 * among same-tier records the LAST-written wins (append order). Returns
 * `undefined` when the id is unknown.
 */
export const latestOperation = (
  operations: readonly RollbackOperationRecord[],
  operationId: string,
): RollbackOperationRecord | undefined => {
  let current: RollbackOperationRecord | undefined
  for (const op of operations) {
    if (op.operationId !== operationId) continue
    if (current === undefined) {
      current = op
      continue
    }
    // Terminal beats pending; otherwise the later append wins.
    const currentTerminal = isTerminalRollbackState(current.state)
    const opTerminal = isTerminalRollbackState(op.state)
    if (opTerminal || !currentTerminal) current = op
  }
  return current
}

/** All operation ids that are currently `requested` with NO terminal receipt —
 *  the operator-visible "recovery required" set after a restart. Order is
 *  first-seen (stable). Idempotent: a completed op never appears. */
export const pendingOperationIds = (
  operations: readonly RollbackOperationRecord[],
): readonly string[] => {
  const seen = new Set<string>()
  const pending: string[] = []
  for (const op of operations) {
    const id = op.operationId
    if (seen.has(id)) continue
    seen.add(id)
    const latest = latestOperation(operations, id)
    if (latest !== undefined && latest.state === "requested") pending.push(id)
  }
  return pending
}

/**
 * Append a `requested` INTENT record idempotently. If `operationId` already has
 * ANY record (pending or terminal), the list is returned UNCHANGED (same
 * reference) — recording an intent is exactly-once. Never mutates the input.
 */
export const appendRollbackIntent = (
  operations: readonly RollbackOperationRecord[],
  intent: { operationId: string; targetTurnId: string; requestedAt: number },
): readonly RollbackOperationRecord[] => {
  if (latestOperation(operations, intent.operationId) !== undefined) return operations
  return [
    ...operations,
    {
      recordVersion: ROLLBACK_RECORD_VERSION,
      operationId: intent.operationId,
      targetTurnId: intent.targetTurnId,
      state: "requested",
      requestedAt: intent.requestedAt,
    },
  ]
}

/**
 * Append a TERMINAL receipt (`rolled_back` / `rollback_failed`) for an existing
 * operation. Idempotent + fail-closed:
 *   - unknown `operationId` (no prior intent) ⇒ list UNCHANGED (a terminal
 *     receipt must never fabricate an operation that was never requested;
 *     success-before-effect is impossible by construction).
 *   - already-terminal `operationId` ⇒ list UNCHANGED (the first terminal wins;
 *     a duplicate submit reads back the same receipt).
 * Otherwise appends the terminal record (append-only history — the prior
 * `requested` record is preserved, not overwritten). Never mutates the input.
 */
export const appendRollbackTerminal = (
  operations: readonly RollbackOperationRecord[],
  terminal: {
    operationId: string
    state: Exclude<RollbackOperationState, "requested">
    terminalAt: number
    errorCode?: string
  },
): readonly RollbackOperationRecord[] => {
  const latest = latestOperation(operations, terminal.operationId)
  if (latest === undefined) return operations
  if (isTerminalRollbackState(latest.state)) return operations
  const record: RollbackOperationRecord = {
    recordVersion: ROLLBACK_RECORD_VERSION,
    operationId: terminal.operationId,
    targetTurnId: latest.targetTurnId,
    state: terminal.state,
    requestedAt: latest.requestedAt,
    terminalAt: terminal.terminalAt,
    ...(terminal.errorCode !== undefined ? { errorCode: terminal.errorCode } : {}),
  }
  return [...operations, record]
}

/**
 * Upsert a checkpoint mapping keyed by `(turnId, messageId)`. A later capture
 * for the SAME boundary replaces the earlier one (the newest tree hash/SHA is
 * authoritative for that boundary); a new boundary appends. Never mutates the
 * input. This is the ONLY writer of the mapping — the effect side reads it and
 * never derives a target from a branch/path/PID name.
 */
export const upsertRollbackCheckpoint = (
  checkpoints: readonly RollbackCheckpointRecord[],
  checkpoint: RollbackCheckpointRecord,
): readonly RollbackCheckpointRecord[] => {
  const next = checkpoints.filter(
    (c) => !(c.turnId === checkpoint.turnId && c.messageId === checkpoint.messageId),
  )
  next.push(checkpoint)
  return next
}

/** Resolve the checkpoint mapping for a rollback TARGET turn. Returns the
 *  newest checkpoint whose `turnId` matches, or `undefined` when there is no
 *  mapping (⇒ the coordinator fail-closes; NO restore is attempted). */
export const resolveCheckpointForTurn = (
  checkpoints: readonly RollbackCheckpointRecord[],
  targetTurnId: string,
): RollbackCheckpointRecord | undefined => {
  let hit: RollbackCheckpointRecord | undefined
  for (const c of checkpoints) if (c.turnId === targetTurnId) hit = c
  return hit
}
