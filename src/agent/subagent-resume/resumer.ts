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

import type { Message } from "@/llm"
import { errMessage } from "@/shared"
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
import { defaultIdempotencyClassifier, type IdempotencyClassifier } from "./idempotency"
import type { ResumeDecision, ResumePolicy } from "./policy"
import { buildReplaySpec, type ReplayContext, type ReplayPolicy } from "./replay"
import type { ToolHistoryStore } from "./tool-history"
import {
  defaultToolReplayPolicy,
  replayToolHistory,
  type ShadowCommitRestorer,
  type ToolReplayOutcome,
  type ToolReplayPolicy,
} from "./tool-replay"
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
  /** OPTIONAL (ADR-0166) — `seedMessages` returned by the conversation-replay
   *  composer for this handle. PRESENT when the caller wired `opts.replay`
   *  AND `buildReplaySpec` returned a non-empty seed. The orchestrator does
   *  NOT pass these into the SubagentSpec (port-stable — ADR-0145 surface
   *  unchanged); they are surfaced HERE so a downstream consumer (e.g. a
   *  runner that supports conversation-seed init) can pick them up. ABSENT
   *  on skip-replay. */
  readonly seedMessages?: ReadonlyArray<Message>
  /** OPTIONAL — full audit metadata block from `buildReplaySpec`. PRESENT
   *  whenever `opts.replay` was wired (even on skip-replay, so the audit
   *  trail records the skip reason). ABSENT when `opts.replay` was not
   *  wired (= Phase 2 byte-identical path). */
  readonly replayMetadata?: Readonly<Record<string, string>>
  /** OPTIONAL (ADR-0174 Phase 3) — tool-history replay outcomes. PRESENT when
   *  the caller wired `opts.toolReplay.store`; ONE outcome per persisted
   *  {@link ToolCallRecord} in append order. ABSENT when no tool-history
   *  wire was supplied (= Phase 2.5 byte-identical). An empty array is
   *  surfaced (NOT omitted) when the wire was present and the handle had
   *  zero recorded tool calls — distinguishes "wired but nothing to replay"
   *  from "wire was off". */
  readonly toolReplays?: ReadonlyArray<ToolReplayOutcome>
}

export interface ResumerOpts {
  /** Live ADR-0145 scheduler (in-memory OR hydrating wrapper from ADR-0158).
   *  Used as the SOLE re-fork seam for `"resume"` decisions. Only `fork()` is
   *  called — callers with a hydrating wrapper (whose `poll` returns a
   *  structurally wider `HydratedSubagentResult`) need not cast. */
  readonly scheduler: Pick<BackgroundSubagentScheduler, "fork">
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
  /** OPTIONAL (ADR-0166 Phase 2.5) — conversation-seed replay wiring. When
   *  ABSENT, the orchestrator is BYTE-IDENTICAL to ADR-0159 Phase 2 (fresh
   *  fork, no replay metadata in outcome). When PRESENT, every `"resume"`
   *  decision additionally invokes `buildReplaySpec(handle, context, policy)`,
   *  merges `replayMetadata` into the new spec's `metadata`, and surfaces
   *  `seedMessages` + `replayMetadata` on the outcome. NO-THROW — the replay
   *  composer is itself NO-THROW (every failure resolves to "skip-replay"). */
  readonly replay?: {
    /** Snapshot store + cap — passed verbatim to `buildReplaySpec`. */
    readonly context: ReplayContext
    /** Policy — passed verbatim. The 3 stock policies live in `./replay`. */
    readonly policy: ReplayPolicy
  }
  /** OPTIONAL (ADR-0174 Phase 3) — tool-history replay wiring. When ABSENT,
   *  the orchestrator is BYTE-IDENTICAL to Phase 2.5 (no `toolReplays` on
   *  the outcome). When PRESENT, `replayToolHistory` runs BEFORE the new
   *  fork starts processing (so the cached tool outputs + shadow restore
   *  are in place when the re-fork's first turn fires). `classifier` and
   *  `policy` default to {@link defaultIdempotencyClassifier} +
   *  {@link defaultToolReplayPolicy} when omitted. NO-THROW — any error
   *  during replay is captured as a `halt` outcome and the resume
   *  proceeds. */
  readonly toolReplay?: {
    /** Persistent tool-history store. Required when this wire is present. */
    readonly store: ToolHistoryStore
    /** Idempotency classifier. Default: {@link defaultIdempotencyClassifier}. */
    readonly classifier?: IdempotencyClassifier
    /** Replay policy. Default: {@link defaultToolReplayPolicy}. */
    readonly policy?: ToolReplayPolicy
    /** Optional shadow-commit restorer. Mutating-recoverable hits HALT when
     *  absent (cannot restore workspace state). */
    readonly shadowOdb?: ShadowCommitRestorer
  }
}

/** Build the `SubagentSpec` for the resumed fork. Preserves every spec field
 *  from the old handle AND merges `resumedFrom: oldId` into `metadata`. The
 *  old `metadata` (when present) wins on every key EXCEPT `resumedFrom` — we
 *  always overwrite that with the fresh chain link. When `replayMetadata` is
 *  supplied (ADR-0166), it is ALSO merged (replayPolicy/replayCount/etc.).
 *  Merge order: old.metadata < replayMetadata < {resumedFrom} — the chain
 *  link wins, then replay-audit fields, then caller's pre-existing keys. */
const buildResumedSpec = (
  old: PersistedHandle,
  replayMetadata?: Readonly<Record<string, string>>,
): SubagentSpec => {
  const mergedMetadata: Readonly<Record<string, string>> = {
    ...(old.spec.metadata ?? {}),
    ...(replayMetadata ?? {}),
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
const errMsg = (e: unknown): string => errMessage(e)

/** Apply the `"resume"` branch — optionally consult the replay composer, then
 *  fork in the scheduler + flip OLD to `"resumed"` in the store.
 *
 *  Replay-NO-THROW: `buildReplaySpec` is itself NO-THROW (collapses every
 *  failure to `"skip-replay"` + audit reason). On skip-replay we omit
 *  `seedMessages` from the outcome (empty arrays are NOT surfaced) but ALWAYS
 *  surface `replayMetadata` when `opts.replay` was wired so the audit trail
 *  records the skip reason. Fork-throw → outcome.errorMessage with NO newId.
 *  Save-throw → outcome.errorMessage WITH newId so caller can still correlate
 *  to the live scheduler. */
const applyResume = async (
  handle: PersistedHandle,
  decision: ResumeDecision,
  scheduler: Pick<BackgroundSubagentScheduler, "fork">,
  store: PersistentSchedulerStore,
  tNow: number,
  replay?: { readonly context: ReplayContext; readonly policy: ReplayPolicy },
  toolReplay?: ResumerOpts["toolReplay"],
): Promise<ResumeOutcome> => {
  // 1) OPTIONAL replay seed — NO-THROW composer.
  let seedMessages: ReadonlyArray<Message> = []
  let replayMetadata: Readonly<Record<string, string>> | undefined
  if (replay !== undefined) {
    const replayed = await buildReplaySpec(handle, replay.context, replay.policy)
    seedMessages = replayed.seedMessages
    replayMetadata = replayed.replayMetadata
  }

  // 1b) OPTIONAL tool-history replay — runs BEFORE fork so workspace state +
  //     cached outputs are ready when the re-fork's first turn fires.
  //     NO-THROW: orchestrator captures errors as `halt` outcomes per record;
  //     store-list-throw collapses to a synthetic single halt entry so the
  //     main resume STILL proceeds (Phase 2.5 fault-tolerance posture).
  let toolReplays: ReadonlyArray<ToolReplayOutcome> | undefined
  if (toolReplay !== undefined) {
    const classifier = toolReplay.classifier ?? defaultIdempotencyClassifier()
    const policy = toolReplay.policy ?? defaultToolReplayPolicy()
    const workspace = handle.workspace ?? handle.spec.workspace ?? ""
    try {
      const records = await toolReplay.store.list(handle.id)
      toolReplays = await replayToolHistory({
        records,
        classifier,
        policy,
        workspace,
        ...(toolReplay.shadowOdb !== undefined ? { shadowOdb: toolReplay.shadowOdb } : {}),
      })
    } catch (e) {
      // Store-list itself threw — surface as a single halt outcome so the
      // audit trail records WHY no per-call replays ran. Main resume still
      // proceeds (the new fork starts fresh; the cached outputs are simply
      // unavailable).
      toolReplays = [
        {
          toolUseId: "(store-list)",
          toolName: "(store-list)",
          decision: {
            action: "halt",
            reason: `tool-history store.list threw: ${errMsg(e)}`,
          },
        },
      ]
    }
  }

  // 2) Build the resumed spec — replayMetadata is merged into spec.metadata
  //    only when it is present (Phase 2 byte-identical when replay is absent).
  let newId: SubagentHandleId
  try {
    newId = scheduler.fork(buildResumedSpec(handle, replayMetadata))
  } catch (e) {
    return {
      id: handle.id,
      decision,
      errorMessage: `scheduler.fork: ${errMsg(e)}`,
      ...(seedMessages.length > 0 ? { seedMessages } : {}),
      ...(replayMetadata !== undefined ? { replayMetadata } : {}),
      ...(toolReplays !== undefined ? { toolReplays } : {}),
    }
  }
  try {
    await store.save(markResumed(handle, newId, tNow))
  } catch (e) {
    return {
      id: handle.id,
      decision,
      newId,
      errorMessage: `store.save: ${errMsg(e)}`,
      ...(seedMessages.length > 0 ? { seedMessages } : {}),
      ...(replayMetadata !== undefined ? { replayMetadata } : {}),
      ...(toolReplays !== undefined ? { toolReplays } : {}),
    }
  }
  return {
    id: handle.id,
    decision,
    newId,
    ...(seedMessages.length > 0 ? { seedMessages } : {}),
    ...(replayMetadata !== undefined ? { replayMetadata } : {}),
    ...(toolReplays !== undefined ? { toolReplays } : {}),
  }
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
  scheduler: Pick<BackgroundSubagentScheduler, "fork">,
  store: PersistentSchedulerStore,
  tNow: number,
  replay?: { readonly context: ReplayContext; readonly policy: ReplayPolicy },
  toolReplay?: ResumerOpts["toolReplay"],
): Promise<ResumeOutcome> => {
  switch (decision.action) {
    case "resume":
      return applyResume(handle, decision, scheduler, store, tNow, replay, toolReplay)
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
  const replay = opts.replay
  const toolReplay = opts.toolReplay

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
      const msg = errMessage(e)
      outcomes.push({
        id: handle.id,
        // Synthetic decision so the outcome shape stays uniform — caller can
        // branch on `errorMessage !== undefined` to detect policy throws.
        decision: { action: "skip", reason: `policy.decide threw: ${msg}` },
        errorMessage: `policy.decide: ${msg}`,
      })
      continue
    }
    outcomes.push(
      await applyDecision(handle, decision, scheduler, store, now(), replay, toolReplay),
    )
  }
  return outcomes
}
