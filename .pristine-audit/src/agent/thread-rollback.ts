/**
 * RFC-01 A2 (aug-02 absorption) — ThreadRollback effect saga (coordinator).
 *
 * The ONE application service that ORDERS a durable rollback:
 *
 *     persist `requested` intent  →  file-tree restore effect  →  persist
 *     terminal receipt (`rolled_back` | `rollback_failed`)
 *
 * It owns ONLY the ordering. The durable records live on `SavedSession`
 * (RFC01-0), the file-tree mutation is `ThreeWayRestorePort` + ShadowOdb (the
 * single tree-mutation owner, injected here as `RollbackEffectPort`), and the
 * checkpoint mapping is resolved from the persisted record (RFC01-2). This
 * module creates NO store, writer, hash, or ODB, and mutates NO working tree
 * itself.
 *
 * Fail-closed + no-blind-retry invariants (the crux of the saga):
 *   - A `requested` intent is persisted BEFORE the effect runs, so a crash
 *     after intent leaves an operator-visible pending operation — NEVER a
 *     success. On restart the coordinator surfaces `recovery_required` and does
 *     NOT auto-succeed or blind-retry the effect.
 *   - The terminal receipt is persisted AFTER the effect, so a success receipt
 *     can never precede the effect.
 *   - A duplicate `operationId` that already reached a terminal receipt returns
 *     that receipt verbatim (idempotent; no second effect).
 *   - A missing/unresolvable checkpoint mapping fail-closes to
 *     `rollback_failed` WITHOUT touching the tree.
 *
 * CLI and SDK entries call `executeRollback` (or `resumePendingRollback`) — they
 * do NOT re-implement file restore.
 */

import {
  appendRollbackIntent,
  appendRollbackTerminal,
  latestOperation,
  loadSessionById,
  type RollbackCheckpointRecord,
  type RollbackOperationRecord,
  updateSessionAtomic,
} from "@/session"
import { resolveRollbackTarget } from "./thread-rollback-checkpoint"

/** The durable record slice the coordinator reads/writes. Loaded from and saved
 *  to the SavedSession snapshot by the injected {@link RollbackRecordStore} —
 *  the coordinator never opens a file itself. */
export interface RollbackRecords {
  readonly checkpoints: readonly RollbackCheckpointRecord[]
  readonly operations: readonly RollbackOperationRecord[]
}

/** Injected durable-record port over the EXISTING SavedSession atomic snapshot.
 *  `load` reads the current records; `saveOperations` persists an updated
 *  operation collection through the same atomic save (a full-snapshot write —
 *  the checkpoints are unchanged by a rollback and are preserved by the
 *  adapter). No new store: the adapter is a thin `loadSessionById`/
 *  `saveSessionById` wrapper. */
export interface RollbackRecordStore {
  load(sessionId: string): Promise<RollbackRecords | undefined>
  saveOperations(sessionId: string, operations: readonly RollbackOperationRecord[]): Promise<void>
}

/** Typed result of the file-tree restore effect. NO-THROW by contract: a
 *  conflict/failure collapses to `{ok:false, code}` so the coordinator can
 *  persist a terminal `rollback_failed` receipt. */
export interface RestoreEffectResult {
  readonly ok: boolean
  /** Typed failure code when `ok:false` (e.g. a ShadowOdb error code or
   *  "conflict"). Persisted verbatim into the terminal receipt's `errorCode`. */
  readonly code?: string
}

/** The single tree-mutation effect the coordinator drives. Adapts
 *  `ThreeWayRestorePort` (resolving the checkpoint → restore) at the CLI/REPL
 *  composition root. Injected so the coordinator stays effect-agnostic and
 *  unit-testable. */
export interface RollbackEffectPort {
  restoreToCheckpoint(checkpoint: RollbackCheckpointRecord): Promise<RestoreEffectResult>
}

/** Optional transcript-projection hook. After a SUCCESSFUL effect the existing
 *  rewind owner truncates the transcript to the checkpoint's message — the
 *  coordinator calls this AFTER the terminal `rolled_back` receipt is durable so
 *  the transcript never leads the file/receipt state. Absent ⇒ no-op. */
export type TranscriptProjectionHook = (checkpoint: RollbackCheckpointRecord) => Promise<void>

/** Dependencies for one rollback execution. */
export interface ThreadRollbackDeps {
  readonly store: RollbackRecordStore
  readonly effect: RollbackEffectPort
  /** Injected clock (epoch ms) — deterministic in tests. */
  readonly now: () => number
  readonly onTranscriptProjection?: TranscriptProjectionHook
}

/** A rollback request. `operationId` is the idempotency key; `targetTurnId` is
 *  the turn to roll back to (resolved against the durable checkpoint mapping). */
export interface RollbackRequest {
  readonly sessionId: string
  readonly operationId: string
  readonly targetTurnId: string
}

/** Closed outcome of `executeRollback` / `resumePendingRollback`. */
export type ThreadRollbackOutcome =
  /** The effect succeeded and a durable `rolled_back` receipt was written. */
  | { readonly kind: "rolled_back"; readonly operation: RollbackOperationRecord }
  /** The effect failed (missing mapping, conflict, restore error); a durable
   *  `rollback_failed` receipt was written. */
  | {
      readonly kind: "rollback_failed"
      readonly operation: RollbackOperationRecord
      readonly errorCode: string
    }
  /** A pending `requested` intent from a prior (possibly crashed) run was
   *  found. The coordinator does NOT auto-succeed or blind-retry — the operator
   *  must decide. Surfaced verbatim so a UI can offer explicit recovery. */
  | { readonly kind: "recovery_required"; readonly operationId: string }
  /** The session (or its record slice) was not found. */
  | { readonly kind: "session_missing"; readonly sessionId: string }

/** Read back the terminal operation record for `operationId` and project it to
 *  the closed outcome (helper for the idempotent-return + post-persist read). */
const terminalOutcome = (
  operations: readonly RollbackOperationRecord[],
  operationId: string,
): ThreadRollbackOutcome => {
  const op = latestOperation(operations, operationId)
  if (op === undefined) {
    // Unreachable in practice (the caller just wrote a terminal record). Surface
    // a typed failure rather than a phantom success.
    return { kind: "recovery_required", operationId }
  }
  if (op.state === "rolled_back") return { kind: "rolled_back", operation: op }
  if (op.state === "rollback_failed") {
    return { kind: "rollback_failed", operation: op, errorCode: op.errorCode ?? "unknown" }
  }
  // Still `requested` — a pending intent surfaced for operator recovery.
  return { kind: "recovery_required", operationId }
}

/**
 * Execute (or idempotently resolve) a durable rollback.
 *
 * Ordering: intent-persist → effect → terminal-persist. A crash between any two
 * steps leaves an operator-visible pending intent (never a phantom success);
 * `resumePendingRollback` is the explicit recovery path.
 */
export const executeRollback = async (
  deps: ThreadRollbackDeps,
  req: RollbackRequest,
): Promise<ThreadRollbackOutcome> => {
  const records = await deps.store.load(req.sessionId)
  if (records === undefined) return { kind: "session_missing", sessionId: req.sessionId }

  // Idempotency / recovery: a prior record for this operationId short-circuits.
  const prior = latestOperation(records.operations, req.operationId)
  if (prior !== undefined) {
    if (prior.state === "requested") {
      // A pending intent (e.g. a crash before terminal) — DO NOT blind-retry or
      // auto-succeed. Surface it for operator-driven recovery.
      return { kind: "recovery_required", operationId: req.operationId }
    }
    // Already terminal — return the existing receipt (no second effect).
    return terminalOutcome(records.operations, req.operationId)
  }

  // Resolve the target from the DURABLE mapping only (fail-closed on missing).
  const target = resolveRollbackTarget(records.checkpoints, req.targetTurnId)
  if (target.kind === "missing") {
    return await persistTerminalFailure(deps, req, records.operations, "missing-checkpoint")
  }

  // 1) Persist the `requested` intent BEFORE the effect (durable, operator-
  //    visible). A crash here leaves a pending op — never a success.
  const withIntent = appendRollbackIntent(records.operations, {
    operationId: req.operationId,
    targetTurnId: req.targetTurnId,
    requestedAt: deps.now(),
  })
  await deps.store.saveOperations(req.sessionId, withIntent)

  // 2) Run the file-tree effect (the single tree-mutation owner).
  let effect: RestoreEffectResult
  try {
    effect = await deps.effect.restoreToCheckpoint(target.checkpoint)
  } catch (e) {
    effect = { ok: false, code: e instanceof Error ? e.message : "restore-threw" }
  }

  // 3) Persist the TERMINAL receipt AFTER the effect (success can never precede
  //    the effect).
  if (!effect.ok) {
    return await persistTerminalFailure(deps, req, withIntent, effect.code ?? "restore-failed")
  }
  const withTerminal = appendRollbackTerminal(withIntent, {
    operationId: req.operationId,
    state: "rolled_back",
    terminalAt: deps.now(),
  })
  await deps.store.saveOperations(req.sessionId, withTerminal)

  // 4) Update the transcript projection AFTER the durable terminal receipt (the
  //    transcript never leads the file/receipt state).
  if (deps.onTranscriptProjection !== undefined) {
    await deps.onTranscriptProjection(target.checkpoint)
  }
  return terminalOutcome(withTerminal, req.operationId)
}

/** Persist a `rollback_failed` terminal receipt and return the failure outcome.
 *  Requires a prior `requested` intent for the op; when none exists (the
 *  missing-checkpoint case, which fails BEFORE any intent) it appends the intent
 *  then the terminal so the append-only history is coherent. */
const persistTerminalFailure = async (
  deps: ThreadRollbackDeps,
  req: RollbackRequest,
  operations: readonly RollbackOperationRecord[],
  errorCode: string,
): Promise<ThreadRollbackOutcome> => {
  let ops = operations
  if (latestOperation(ops, req.operationId) === undefined) {
    ops = appendRollbackIntent(ops, {
      operationId: req.operationId,
      targetTurnId: req.targetTurnId,
      requestedAt: deps.now(),
    })
  }
  const withTerminal = appendRollbackTerminal(ops, {
    operationId: req.operationId,
    state: "rollback_failed",
    terminalAt: deps.now(),
    errorCode,
  })
  await deps.store.saveOperations(req.sessionId, withTerminal)
  return terminalOutcome(withTerminal, req.operationId)
}

/**
 * Explicit operator-driven recovery for a pending `requested` intent found on
 * restart. This is NOT a blind retry: the operator invokes it to re-run the
 * effect for a KNOWN-pending operation. It re-resolves the checkpoint, runs the
 * effect, and writes the terminal receipt. If the operationId is already
 * terminal it returns the existing receipt (idempotent); if it is unknown it is
 * treated as a fresh request.
 */
export const resumePendingRollback = async (
  deps: ThreadRollbackDeps,
  req: RollbackRequest,
): Promise<ThreadRollbackOutcome> => {
  const records = await deps.store.load(req.sessionId)
  if (records === undefined) return { kind: "session_missing", sessionId: req.sessionId }
  const prior = latestOperation(records.operations, req.operationId)
  if (prior !== undefined && prior.state !== "requested") {
    return terminalOutcome(records.operations, req.operationId)
  }

  const target = resolveRollbackTarget(records.checkpoints, req.targetTurnId)
  if (target.kind === "missing") {
    return await persistTerminalFailure(deps, req, records.operations, "missing-checkpoint")
  }
  // Ensure the intent exists (it does for a pending resume; append for a fresh id).
  const withIntent = appendRollbackIntent(records.operations, {
    operationId: req.operationId,
    targetTurnId: req.targetTurnId,
    requestedAt: deps.now(),
  })
  if (withIntent !== records.operations) {
    await deps.store.saveOperations(req.sessionId, withIntent)
  }

  let effect: RestoreEffectResult
  try {
    effect = await deps.effect.restoreToCheckpoint(target.checkpoint)
  } catch (e) {
    effect = { ok: false, code: e instanceof Error ? e.message : "restore-threw" }
  }
  if (!effect.ok) {
    return await persistTerminalFailure(deps, req, withIntent, effect.code ?? "restore-failed")
  }
  const withTerminal = appendRollbackTerminal(withIntent, {
    operationId: req.operationId,
    state: "rolled_back",
    terminalAt: deps.now(),
  })
  await deps.store.saveOperations(req.sessionId, withTerminal)
  if (deps.onTranscriptProjection !== undefined) {
    await deps.onTranscriptProjection(target.checkpoint)
  }
  return terminalOutcome(withTerminal, req.operationId)
}

/* ------------------------------------------------------------------ */
/* SavedSession-backed record store adapter                            */
/* ------------------------------------------------------------------ */

/**
 * Build a {@link RollbackRecordStore} over the EXISTING SavedSession atomic
 * snapshot (`loadSessionById` / `saveSessionById`) — the single durable-record
 * owner. `saveOperations` does a full read-modify-write so the transcript,
 * meta, and checkpoint records are preserved (a rollback only mutates the
 * operation collection). No new store/writer/hash.
 */
export const createSavedSessionRollbackStore = (): RollbackRecordStore => ({
  async load(sessionId) {
    const saved = await loadSessionById(sessionId)
    if (saved === undefined) return undefined
    return {
      checkpoints: saved.rollbackCheckpoints ?? [],
      operations: saved.rollbackOperations ?? [],
    }
  },
  async saveOperations(sessionId, operations) {
    // ATOMIC read-modify-write under the per-session save lock (R4): re-read the
    // freshest snapshot INSIDE the lock and advance ONLY `rollbackOperations`,
    // carrying every other field (meta.title, messages, checkpoints) forward via
    // the full-snapshot spread. This is why a concurrent detached auto-titler
    // rename cannot clobber the fold (and vice-versa) — whoever runs second sees
    // the first's committed write.
    const ok = await updateSessionAtomic(sessionId, (saved) => ({
      ...saved,
      rollbackOperations: [...operations],
    }))
    if (!ok) {
      throw new Error(`thread-rollback: session not found on save: ${sessionId}`)
    }
  },
})
