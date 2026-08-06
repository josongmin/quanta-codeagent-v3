/**
 * RFC-def Surface B / RFC01-3 — `/rewind --restore-files` coordinator wire.
 *
 * Adapts the durable ThreadRollback coordinator (`@/agent/thread-rollback`) into
 * the CLI-slice `RestoreFilesCoordinatorPort` (`../rewind-cmd`) so a confirmed
 * `/rewind <id> --restore-files` routes the FILE restore through the saga
 * (`persist requested → ThreeWayRestorePort restore → durable receipt`) instead
 * of the transcript-owner safe-degrade.
 *
 * This wire constructs NO restore path: it composes the EXISTING pieces —
 *   - `createSavedSessionRollbackStore()` — durable records over the SavedSession
 *     atomic snapshot (RFC01-0),
 *   - `buildRollbackEffectPort({registry, restore})` — the SHA→tag→
 *     `ThreeWayRestorePort.restoreFiles` bridge (the SINGLE tree-mutation owner),
 *   - `executeRollback(deps, req)` — the intent→effect→terminal ORDERING.
 *
 * Fail-closed mapping (the crux): every non-`rolled_back` coordinator outcome
 * collapses to `{kind:"refused"}` with an operator-visible reason, so the CLI
 * command exits 1 WITHOUT truncating the transcript (no partial):
 *   - `rollback_failed` (missing checkpoint mapping / moved-SHA anchor-missing /
 *     ShadowOdb conflict) ⇒ refused (NO tree mutation happened),
 *   - `recovery_required` (a prior crashed intent) ⇒ refused (operator must
 *     explicitly recover; never blind-retry),
 *   - `session_missing` ⇒ refused.
 *
 * When NO ShadowOdb-backed effect is available (the per-tool registry was not
 * wired), the effect port is a fail-closed stub: it never mutates the tree and
 * reports `restore-not-wired`. In practice the coordinator refuses EARLIER at
 * `missing-checkpoint` (no durable per-message checkpoint mapping is captured in
 * production yet), so `--restore-files` fail-closes with a clear reason and the
 * working tree + transcript are untouched — exactly the safe posture the
 * destructive gate requires.
 *
 * Default-OFF: the composition root builds this ONLY when `QUANTA_REWIND_GIT=1`
 * (the existing extra-destructive gate for `--restore-files`). Absent ⇒ no
 * coordinator slot on `RewindSlashState`, and `--restore-files` keeps its prior
 * `rewindSession` safe-degrade byte-identical.
 */

import type { GranularRegistry, ThreeWayRestorePort } from "@/agent/per-tool-checkpoint"
import {
  createSavedSessionRollbackStore,
  executeRollback,
  type RollbackEffectPort,
} from "@/agent/thread-rollback"
import type {
  RestoreFilesCoordinatorPort,
  RestoreFilesOutcome,
} from "../rewind-cmd"
import { buildRollbackEffectPort } from "./per-tool-checkpoint-wire"

/** The optional ShadowOdb-backed restore triple (present iff the per-tool
 *  checkpoint wire was built). Absent ⇒ the fail-closed stub effect is used. */
export interface RewindRestoreCoordinatorDeps {
  readonly perTool?:
    | { readonly registry: GranularRegistry; readonly restore: ThreeWayRestorePort }
    | undefined
  /** Injected clock (epoch ms). Defaults to `Date.now`. */
  readonly now?: () => number
}

/** A fail-closed effect port for when no ShadowOdb registry is wired: it NEVER
 *  mutates the tree and reports a typed refusal so the coordinator records
 *  `rollback_failed` (used only when a checkpoint mapping DID resolve but no
 *  restore backend exists — a defensive belt; the common path refuses earlier
 *  at `missing-checkpoint`). */
const failClosedEffectPort: RollbackEffectPort = {
  async restoreToCheckpoint() {
    return { ok: false, code: "restore-not-wired" }
  },
}

/** Map a coordinator outcome to the CLI-slice closed outcome. Only a durable
 *  `rolled_back` receipt is a success; everything else fails closed with an
 *  operator-visible reason (NOTHING was mutated on a refusal). */
const toRestoreOutcome = (
  outcome: Awaited<ReturnType<typeof executeRollback>>,
): RestoreFilesOutcome => {
  if (outcome.kind === "rolled_back") return { kind: "restored" }
  if (outcome.kind === "rollback_failed") {
    return { kind: "refused", reason: `restore failed (${outcome.errorCode})` }
  }
  if (outcome.kind === "recovery_required") {
    return {
      kind: "refused",
      reason: `a prior restore for '${outcome.operationId}' is pending recovery — refusing to blind-retry`,
    }
  }
  return { kind: "refused", reason: `session not found: ${outcome.sessionId}` }
}

/**
 * Build the `RestoreFilesCoordinatorPort` the `/rewind --restore-files` command
 * consumes. Reuses the EXISTING coordinator + effect bridge — no new store,
 * writer, hash, or restore path.
 */
export const buildRewindRestoreCoordinator = (
  deps: RewindRestoreCoordinatorDeps,
): RestoreFilesCoordinatorPort => {
  const store = createSavedSessionRollbackStore()
  const effect =
    deps.perTool !== undefined
      ? buildRollbackEffectPort({ registry: deps.perTool.registry, restore: deps.perTool.restore })
      : failClosedEffectPort
  const now = deps.now ?? Date.now
  return {
    async restoreToMessage(req) {
      const outcome = await executeRollback(
        { store, effect, now },
        {
          sessionId: req.sessionId,
          operationId: req.operationId,
          // The durable checkpoint mapping is keyed by turn/message boundary; the
          // `/rewind` target is a message id. `resolveRollbackTarget` matches the
          // recorded `turnId`, so a target with no recorded checkpoint (the
          // production reality today) fail-closes to `missing-checkpoint` — the
          // safe refusal. No branch/path/ordinal guessing.
          targetTurnId: req.targetId,
        },
      )
      return toRestoreOutcome(outcome)
    },
  }
}
