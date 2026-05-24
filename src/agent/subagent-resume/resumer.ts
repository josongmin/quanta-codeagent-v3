/**
 * Work-resume orchestrator (ADR-0159 Phase 2).
 *
 * Walks every `"interrupted"` handle in a {@link PersistentSchedulerStore},
 * consults the injected {@link ResumePolicy}, and applies the decision:
 *
 *   - `"resume"`      → `scheduler.fork(spec')` where `spec'.metadata` carries
 *                       `resumedFrom: <oldId>` so the new handle is auditable
 *                       back to its origin; the OLD handle is then flipped to
 *                       `"resumed"` (6th arm — ADR-0158 types.ts already
 *                       defines it) with `outputSummary = "resumed as <newId>"`.
 *   - `"skip"`        → no-op (decision recorded in the outcome).
 *   - `"mark-failed"` → `store.save({...handle, status: "failed", endedAt,
 *                       errorMessage})` so the next process sees the handle
 *                       as terminal and does not re-evaluate it.
 *   - `"ask-user"`    → no-op; `outcome.promptHint` carries the policy's
 *                       prompt fragment so the surface (CLI / Web) can render
 *                       a confirmation. The orchestrator NEVER auto-resumes
 *                       an `"ask-user"` arm — that intent stays with the user.
 *
 * Plane-clean: imports ONLY `../subagent-background` (port type +
 * SubagentSpec), `../subagent-persistence-store` (port type + PersistedHandle
 * + PersistedSubagentStatus), and `./policy`. NO `@/agent/loop`,
 * `@/agent/dispatch`, `@/llm`, `@/permission`, `@/tool`.
 *
 * NO-THROW per handle: any error during `policy.decide` / `scheduler.fork` /
 * `store.save` is CAUGHT, surfaced via `outcome.errorMessage`, and iteration
 * continues. The orchestrator's promise resolves with one outcome per
 * interrupted handle in store order. The ONLY way this function rejects is
 * if `store.list(workspace)` itself throws (= the disk-level read failure;
 * the caller's responsibility to surface).
 *
 * Default-OFF (helper-only, deferred-wire — voice-match ADR-0158 §5):
 * nothing in this slice is wired to the loop / dispatch / apps bootstrap.
 * A future surface (CLI command, system-skill) calls
 * `resumeInterruptedHandles({...})` explicitly with a constructed scheduler
 * + store + policy.
 */

import type {
  BackgroundSubagentScheduler,
  SubagentHandleId,
  SubagentSpec,
} from "../subagent-background"
import type {
  PersistedHandle,
  PersistedSubagentStatus,
  PersistentSchedulerStore,
} from "../subagent-persistence-store"
import type { ResumeDecision, ResumePolicy } from "./policy"

/** Per-handle outcome of one resume sweep. One entry per `"interrupted"`
 *  handle in store order. */
export interface ResumeOutcome {
  /** Original interrupted handle id. */
  readonly id: SubagentHandleId
  /** What the policy decided — surfaced verbatim so callers can audit. */
  readonly decision: ResumeDecision
  /** Set when `decision.action === "resume"` AND the fork succeeded. The new
   *  handle id carries `spec.metadata.resumedFrom = id`. */
  readonly newId?: SubagentHandleId
  /** Set when applying the decision threw — orchestrator swallowed the
   *  throw and recorded the message; iteration continued. */
  readonly errorMessage?: string
}

export interface ResumerOpts {
  /** Live ADR-0145 scheduler (in-memory OR hydrating wrapper from ADR-0158).
   *  Used as the SOLE re-fork seam for `"resume"` decisions. */
  readonly scheduler: BackgroundSubagentScheduler
  /** Persistence port (ADR-0158). `list(workspace)` enumerates candidates;
   *  `save(handle)` flips the old handle to `"resumed"` / `"failed"`. */
  readonly store: PersistentSchedulerStore
  /** Caller-injected policy. The 3 stock impls live in `./policy`:
   *  `defaultResumePolicy()` (conservative), `alwaysResumePolicy`,
   *  `askUserResumePolicy`. */
  readonly policy: ResumePolicy
  /** Workspace fingerprint — scopes which interrupted handles we consider.
   *  Must match the same value used at fork time so `store.list(workspace)`
   *  returns this workspace's entries only. */
  readonly workspace: string
  /** Injected clock. Default `Date.now`. */
  readonly now?: () => number
}

/** Build the `SubagentSpec` for the resumed fork. Preserves every spec field
 *  from the old handle AND merges `resumedFrom: oldId` into `metadata`. The
 *  old `metadata` (when present) wins on every key EXCEPT `resumedFrom` — we
 *  always overwrite that with the fresh chain link. */
const buildResumedSpec = (old: PersistedHandle): SubagentSpec => {
  const mergedMetadata: Readonly<Record<string, string>> = {
    ...(old.spec.metadata ?? {}),
    resumedFrom: old.id,
  }
  return {
    task: old.spec.task,
    ...(old.spec.modelOverride !== undefined ? { modelOverride: old.spec.modelOverride } : {}),
    ...(old.spec.maxTurns !== undefined ? { maxTurns: old.spec.maxTurns } : {}),
    ...(old.spec.workspace !== undefined ? { workspace: old.spec.workspace } : {}),
    metadata: mergedMetadata,
  }
}

/** Project the old handle into the `"resumed"` arm of {@link
 *  PersistedSubagentStatus}. `outputSummary` records the new id so a list
 *  reader can chain to the live handle without prose-parsing. */
const markResumed = (
  old: PersistedHandle,
  newId: SubagentHandleId,
  tNow: number,
): PersistedHandle => {
  const status: PersistedSubagentStatus = "resumed"
  return {
    id: old.id,
    spec: old.spec,
    status,
    startedAt: old.startedAt,
    turns: old.turns,
    outputSummary: `resumed as ${newId}`,
    endedAt: tNow,
    ...(old.outputDetail !== undefined ? { outputDetail: old.outputDetail } : {}),
    ...(old.errorMessage !== undefined ? { errorMessage: old.errorMessage } : {}),
    ...(old.hostPid !== undefined ? { hostPid: old.hostPid } : {}),
    ...(old.workspace !== undefined ? { workspace: old.workspace } : {}),
  }
}

/** Project the old handle into the `"failed"` arm with policy-supplied
 *  reason. Used by the `"mark-failed"` policy branch — the next list() sees
 *  this handle as terminal and the policy will not re-evaluate it. */
const markFailed = (old: PersistedHandle, reason: string, tNow: number): PersistedHandle => ({
  id: old.id,
  spec: old.spec,
  status: "failed",
  startedAt: old.startedAt,
  turns: old.turns,
  outputSummary: old.outputSummary.length > 0 ? old.outputSummary : "(failed)",
  endedAt: tNow,
  errorMessage: reason,
  ...(old.outputDetail !== undefined ? { outputDetail: old.outputDetail } : {}),
  ...(old.hostPid !== undefined ? { hostPid: old.hostPid } : {}),
  ...(old.workspace !== undefined ? { workspace: old.workspace } : {}),
})

/** Extract a stable error message from a caught `unknown` throwable. */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Apply the `"resume"` branch — fork in the scheduler + flip OLD to
 *  `"resumed"` in the store. Fork-throw → outcome.errorMessage with NO
 *  newId. Save-throw → outcome.errorMessage WITH newId so caller can still
 *  correlate to the live scheduler. */
const applyResume = async (
  handle: PersistedHandle,
  decision: ResumeDecision,
  scheduler: BackgroundSubagentScheduler,
  store: PersistentSchedulerStore,
  tNow: number,
): Promise<ResumeOutcome> => {
  let newId: SubagentHandleId
  try {
    newId = scheduler.fork(buildResumedSpec(handle))
  } catch (e) {
    return { id: handle.id, decision, errorMessage: `scheduler.fork: ${errMsg(e)}` }
  }
  try {
    await store.save(markResumed(handle, newId, tNow))
  } catch (e) {
    return { id: handle.id, decision, newId, errorMessage: `store.save: ${errMsg(e)}` }
  }
  return { id: handle.id, decision, newId }
}

/** Apply the `"mark-failed"` branch — write a terminal `"failed"` snapshot
 *  carrying the policy's reason so the next list() does not re-evaluate. */
const applyMarkFailed = async (
  handle: PersistedHandle,
  decision: ResumeDecision & { action: "mark-failed" },
  store: PersistentSchedulerStore,
  tNow: number,
): Promise<ResumeOutcome> => {
  try {
    await store.save(markFailed(handle, decision.reason, tNow))
    return { id: handle.id, decision }
  } catch (e) {
    return { id: handle.id, decision, errorMessage: `store.save: ${errMsg(e)}` }
  }
}

/** Apply a single `ResumeDecision` against one interrupted handle. Returns
 *  the outcome to record. NEVER throws — every failure path is caught by
 *  the per-action helpers and packaged into `outcome.errorMessage`. */
const applyDecision = (
  handle: PersistedHandle,
  decision: ResumeDecision,
  scheduler: BackgroundSubagentScheduler,
  store: PersistentSchedulerStore,
  tNow: number,
): Promise<ResumeOutcome> => {
  switch (decision.action) {
    case "resume":
      return applyResume(handle, decision, scheduler, store, tNow)
    case "mark-failed":
      return applyMarkFailed(handle, decision, store, tNow)
    case "skip":
      return Promise.resolve({ id: handle.id, decision })
    case "ask-user":
      // promptHint lives on `decision` — caller's surface (CLI/Web) renders
      // it. Orchestrator deliberately takes no action.
      return Promise.resolve({ id: handle.id, decision })
  }
}

export const resumeInterruptedHandles = async (
  opts: ResumerOpts,
): Promise<ReadonlyArray<ResumeOutcome>> => {
  const { scheduler, store, policy, workspace } = opts
  const now = opts.now ?? Date.now

  // `store.list` failure bubbles — it indicates the persistence layer itself
  // is unreachable; the caller decides whether to retry / surface to user.
  // Per-handle failures DO NOT bubble (see applyDecision).
  const allHandles = await store.list(workspace)
  const interrupted = allHandles.filter((h: PersistedHandle): boolean => h.status === "interrupted")

  const outcomes: ResumeOutcome[] = []
  for (const handle of interrupted) {
    let decision: ResumeDecision
    try {
      decision = policy.decide(handle)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      outcomes.push({
        id: handle.id,
        // Synthetic decision so the outcome shape stays uniform — caller can
        // branch on `errorMessage !== undefined` to detect policy throws.
        decision: { action: "skip", reason: `policy.decide threw: ${msg}` },
        errorMessage: `policy.decide: ${msg}`,
      })
      continue
    }
    outcomes.push(await applyDecision(handle, decision, scheduler, store, now()))
  }
  return outcomes
}
