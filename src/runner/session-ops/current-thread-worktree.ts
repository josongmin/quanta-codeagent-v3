/**
 * RFC-06 §RFC06-2 — current-thread in-place worktree transition (aug-02
 * absorption). The persisted intent→effect→publish TRANSACTION + crash
 * reconciliation + next-turn-boundary cwd pin.
 *
 * This is the application service that ORDERS a user command "isolate this
 * thread in a worktree" as a durable transaction on top of existing owners:
 *   - the persisted `SessionMeta.workspaceOwnership` authority (`@/session`),
 *   - the KEPT create owner `createPersistentWorktree` (`@/runtime`),
 *   - the hardened non-force `removeWorktree` (`@/runtime`) for cleanup.
 *
 * It creates NO new binding/lease/TTL store, NO reaper, NO PID/path-name
 * ownership. The lifecycle is the RFC06-0 closed state machine.
 *
 * Transaction shape (the crash points the RED matrix pins):
 *   1. persist `creating` INTENT (ownershipId + path + branch + baseSha) BEFORE
 *      any git effect. A crash HERE leaves a `creating` record with no worktree.
 *   2. run `createPersistentWorktree` (the git effect).
 *   3. on success: transition `creating → ready`, set the session cwd to the
 *      worktree, and persist BOTH as one snapshot write (the publish boundary).
 *      A crash between (2) and (3) leaves a `creating` record WITH a registered
 *      worktree — reconciled by inspecting the registry, never assumed ready.
 *   4. on git failure: transition `creating → failed` and clean the SAFE target
 *      (the exact just-created path) via the hardened remover.
 *
 * The current thread does NOT swap its cwd mid-turn. The publish result carries
 * `nextCwd`; the caller PINS it at the next turn boundary (the REPL/turn-loop
 * integration is a follower — see the RFC06-2 activity/UI deferral).
 */

import { realpath } from "node:fs/promises"
import { type ActivityStore, worktreeOpenActivity, worktreeSettleActivity } from "@/activity"
import {
  createPersistentWorktree,
  findByExactPath,
  inspectWorktrees,
  removeWorktree,
  WorktreeForkError,
  type WorktreeInspection,
} from "@/runtime"
import {
  loadSessionById,
  makeWorkspaceCreateIntent,
  type SavedSession,
  type SessionMeta,
  saveSessionById,
  transitionWorkspaceState,
  type WorkspaceOwnership,
} from "@/session"

/** Injectable clock — epoch-ms — so the transaction is deterministic in tests. */
export type Clock = () => number

/**
 * RFC02-5 / RFC06-2 — optional observability sink for the transition.
 *
 * When a caller (the CLI/SDK front door) supplies an {@link ActivityStore} the
 * transition emits a single operation-correlated node onto the spine: `running`
 * at the intent-persist boundary (BEFORE the git effect) then a single terminal
 * (`done` on ready / `failed` on git error) AFTER the effect settles. The
 * operationId is the caller's `ownershipId` — the SAME correlation the persisted
 * ownership authority carries — so the activity row stitches to the durable
 * record without a second store.
 *
 * OPTIONAL by design: a caller that omits it (every existing caller + the
 * library/test path) emits NO activity, so the transaction is byte-identical to
 * its pre-RFC02-5 behavior (the store is never touched). `turnId`/`runId` are
 * optional correlation the front door threads when it holds them.
 */
export interface TransitionActivity {
  readonly store: ActivityStore
  readonly turnId?: string
  readonly runId?: string
}

/** RFC02-5 — emit the correlated `running` OPEN (self-gated: a `undefined`
 *  sink is a no-op so the transaction stays byte-identical). Extracted so the
 *  transition transaction's cognitive complexity stays under the ceiling. */
const emitActivityOpen = (
  activity: TransitionActivity | undefined,
  req: TransitionRequest,
  branch: string,
  startedAt: number,
): void => {
  if (activity === undefined) return
  activity.store.emit(
    worktreeOpenActivity({
      operationId: req.ownershipId,
      threadId: req.ownerThreadId,
      label: `worktree: ${branch}`,
      startedAt,
      ...(activity.turnId !== undefined ? { turnId: activity.turnId } : {}),
      ...(activity.runId !== undefined ? { runId: activity.runId } : {}),
    }),
  )
}

/** RFC02-5 — emit the single terminal transition (self-gated no-op when the
 *  sink is absent). Called only AFTER the effect settles (never before). */
const emitActivitySettle = (
  activity: TransitionActivity | undefined,
  operationId: string,
  kind: "ready" | "failed",
  at: number,
): void => {
  if (activity === undefined) return
  activity.store.emit(worktreeSettleActivity(operationId, kind, at))
}

/** Match a target path against the porcelain registry accounting for symlinked
 *  roots (macOS `/tmp` → `/private/tmp`). Tries verbatim first, then realpath
 *  on both sides — identity under filesystem canonicalization, NOT path
 *  inference (no substring/prefix/name guessing). */
const findRegisteredExact = async (
  worktrees: readonly WorktreeInspection[],
  targetPath: string,
): Promise<WorktreeInspection | undefined> => {
  const exact = findByExactPath(worktrees, targetPath)
  if (exact !== undefined) return exact
  const targetReal = await realpath(targetPath).catch(() => undefined)
  const wants = new Set<string>([targetPath])
  if (targetReal !== undefined) wants.add(targetReal)
  for (const w of worktrees) {
    if (wants.has(w.path)) return w
    const wReal = await realpath(w.path).catch(() => undefined)
    if (wReal !== undefined && wants.has(wReal)) return w
  }
  return undefined
}

/** Facts the caller supplies to start a transition. `ownershipId` and
 *  `operationId` are minted by the caller (explicit identity — never derived
 *  from a PID/path). */
export interface TransitionRequest {
  /** The session/thread being transitioned. */
  readonly sessionId: string
  /** The owning thread id (usually === sessionId for a top-level thread). */
  readonly ownerThreadId: string
  /** Repo root the worktree forks from. */
  readonly repoRoot: string
  /** Stable repo identity (origin url or repoRoot). */
  readonly repoId: string
  /** Explicit ownership id (caller-minted). */
  readonly ownershipId: string
  /** Fork base sha (base-drift detection). Convention "HEAD" when unknown. */
  readonly baseSha: string
  /** Optional branch override; defaults to `createPersistentWorktree`'s
   *  `fork-<safeId>`. */
  readonly branch?: string
}

/** Typed outcome of a transition transaction. */
export type TransitionResult =
  /** Worktree created + published; `nextCwd` is pinned at the NEXT turn
   *  boundary (never mid-turn). `ownership` is the persisted `ready` record. */
  | { readonly kind: "ready"; readonly nextCwd: string; readonly ownership: WorkspaceOwnership }
  /** The git effect failed; the intent was recorded then transitioned to
   *  `failed`, and the safe target was cleaned. */
  | { readonly kind: "failed"; readonly errorCode: string; readonly detail?: string }
  /** The request could not start (session missing, already owns a worktree). */
  | { readonly kind: "rejected"; readonly reason: string }

const ERR_GIT = "worktree_create_failed"

/** Persist a session's meta with a folded `workspaceOwnership`, preserving the
 *  rest of the snapshot (messages/turns/reason/rollback records) — one atomic
 *  write through the existing store. */
const persistOwnership = async (
  saved: SavedSession,
  ownership: WorkspaceOwnership,
  cwd?: string,
): Promise<void> => {
  const nextMeta: SessionMeta = {
    ...saved.meta,
    workspaceOwnership: ownership,
    ...(cwd !== undefined ? { cwd } : {}),
  }
  await saveSessionById(nextMeta, {
    reason: saved.reason,
    turns: saved.turns,
    messages: saved.messages,
    ...(saved.rollbackCheckpoints !== undefined
      ? { rollbackCheckpoints: saved.rollbackCheckpoints }
      : {}),
    ...(saved.rollbackOperations !== undefined
      ? { rollbackOperations: saved.rollbackOperations }
      : {}),
  })
}

/**
 * Begin + complete a current-thread worktree transition as a durable
 * transaction. Persists the `creating` intent BEFORE the git effect, then
 * publishes `ready` (with the new cwd) on success or `failed` (with cleanup)
 * on git failure. Returns a typed result; NEVER throws.
 *
 * Rejects when the session is missing or ALREADY owns a live (non-terminal)
 * worktree — one owner per thread, no duplicate ownership/branch.
 */
export const transitionThreadToWorktree = async (
  req: TransitionRequest,
  clock: Clock,
  activity?: TransitionActivity,
): Promise<TransitionResult> => {
  const saved = await loadSessionById(req.sessionId)
  if (saved === undefined)
    return { kind: "rejected", reason: `session not found: ${req.sessionId}` }

  // One owner per thread: a non-terminal existing ownership blocks a second
  // create (no duplicate ownership/branch). A terminal record (removed/failed/
  // quarantined) may be superseded by a fresh transition.
  const existing = saved.meta.workspaceOwnership
  if (
    existing !== undefined &&
    existing.state !== "removed" &&
    existing.state !== "failed" &&
    existing.state !== "quarantined"
  ) {
    return { kind: "rejected", reason: `thread already owns a worktree (${existing.state})` }
  }

  // The worktree path is deterministic from the ownershipId (the create owner
  // slugifies it). We persist the intent with the SAME path the create owner
  // will produce so the record is the exact mutation target from step 1.
  const now = clock()
  // (1) Persist the `creating` INTENT before any git effect. We do not yet know
  // the final path/branch the create owner mints, so we record a provisional
  // intent, then re-persist the exact path/branch after the effect. The
  // provisional path is the convention path; the authority is refreshed at
  // publish. baseSha is recorded up-front (drift detection).
  const provisionalPath = `${req.repoRoot}/.quanta/worktrees/${req.ownershipId}`
  const intent = makeWorkspaceCreateIntent({
    ownershipId: req.ownershipId,
    ownerThreadId: req.ownerThreadId,
    repoRoot: req.repoRoot,
    repoId: req.repoId,
    path: provisionalPath,
    branch: req.branch ?? `fork-${req.ownershipId}`,
    baseSha: req.baseSha,
    now,
  })
  await persistOwnership(saved, intent)

  // RFC02-5 — the operation is now ORDERED (intent durable). Emit the correlated
  // `running` node BEFORE the git effect so the state is observable the instant
  // it starts — never success-before-effect (the terminal comes only after the
  // effect settles below). Gate-OFF (no `activity`) ⇒ nothing is emitted.
  emitActivityOpen(activity, req, intent.branch, now)

  // (2) The git effect — the KEPT create owner.
  let created: { worktreePath: string; branch: string }
  try {
    created = await createPersistentWorktree(
      req.ownershipId,
      req.repoRoot,
      req.branch !== undefined ? { branch: req.branch } : undefined,
    )
  } catch (e) {
    // (4) git failed ⇒ transition creating → failed and clean the SAFE target
    // (the exact provisional path — the create owner may have left a partial).
    const failAt = clock()
    const failedT = transitionWorkspaceState(intent, "failed", failAt, ERR_GIT)
    if (failedT.ok) await persistOwnership(saved, failedT.record)
    await removeWorktree(provisionalPath, req.repoRoot, { branch: intent.branch }).catch(
      () => undefined,
    )
    // RFC02-5 — the effect FAILED; emit the single terminal `failed` transition
    // (after the effect settled, never before).
    emitActivitySettle(activity, req.ownershipId, "failed", failAt)
    const detail = e instanceof WorktreeForkError ? (e.detail ?? e.message) : String(e)
    return { kind: "failed", errorCode: ERR_GIT, detail }
  }

  // (3) Publish: refresh the record with the EXACT created path/branch, then
  // transition creating → ready and set the session cwd — one atomic write.
  const exact: WorkspaceOwnership = {
    ...intent,
    path: created.worktreePath,
    branch: created.branch,
  }
  const readyAt = clock()
  const readyT = transitionWorkspaceState(exact, "ready", readyAt)
  if (!readyT.ok) {
    // Should never happen (creating→ready is valid), but fail closed.
    return { kind: "failed", errorCode: "invalid_transition", detail: readyT.reason }
  }
  // Re-load in case a concurrent write touched the snapshot; publish onto the
  // freshest snapshot (still the same session).
  const fresh = (await loadSessionById(req.sessionId)) ?? saved
  await persistOwnership(fresh, readyT.record, created.worktreePath)
  // RFC02-5 — the effect landed AND the record published; emit the single
  // terminal `done` transition (after the publish boundary — never before).
  emitActivitySettle(activity, req.ownershipId, "ready", readyAt)
  return { kind: "ready", nextCwd: created.worktreePath, ownership: readyT.record }
}

/** Typed reconciliation verdict for a session found in `creating` at restart. */
export type ReconcileVerdict =
  /** The worktree IS registered ⇒ promote `creating → ready` (effect landed,
   *  publish was lost). */
  | { readonly kind: "promote_ready"; readonly ownership: WorkspaceOwnership }
  /** No worktree registered ⇒ the effect never landed; `creating → failed`. */
  | { readonly kind: "mark_failed"; readonly ownership: WorkspaceOwnership }
  /** Registry could not be read ⇒ `creating → quarantined` (ambiguous;
   *  operator action). NEVER assumed ready. */
  | { readonly kind: "quarantine"; readonly ownership: WorkspaceOwnership }
  /** Nothing to reconcile (no ownership, or not in `creating`). */
  | { readonly kind: "noop" }

/**
 * Reconcile a session that was found in the `creating` state at restart — the
 * crash window between intent (1) and publish (3). Inspects the live registry:
 *   - registered exact path ⇒ `promote_ready` (the effect landed, publish lost).
 *   - not registered      ⇒ `mark_failed` (the effect never landed).
 *   - registry unreadable ⇒ `quarantine` (ambiguous; operator action).
 * NEVER assumes success from an inferred path/branch. Returns the transitioned
 * record but does NOT persist — the caller persists (so reconciliation is
 * testable without a store and the caller controls the write boundary).
 */
export const reconcileCreatingWorktree = async (
  meta: SessionMeta,
  clock: Clock,
): Promise<ReconcileVerdict> => {
  const ownership = meta.workspaceOwnership
  if (ownership === undefined || ownership.state !== "creating") return { kind: "noop" }

  const inspected = await inspectWorktrees(ownership.repoRoot)
  if (!inspected.ok) {
    const q = transitionWorkspaceState(
      ownership,
      "quarantined",
      clock(),
      "reconcile_inspect_failed",
    )
    return { kind: "quarantine", ownership: q.ok ? q.record : ownership }
  }
  const registered = await findRegisteredExact(inspected.worktrees, ownership.path)
  if (registered !== undefined && registered.branch === ownership.branch) {
    const r = transitionWorkspaceState(ownership, "ready", clock())
    return { kind: "promote_ready", ownership: r.ok ? r.record : ownership }
  }
  const f = transitionWorkspaceState(ownership, "failed", clock(), "reconcile_no_worktree")
  return { kind: "mark_failed", ownership: f.ok ? f.record : ownership }
}
