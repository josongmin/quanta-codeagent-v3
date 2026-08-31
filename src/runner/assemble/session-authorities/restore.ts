/**
 * RFC-03 C2 / GOAL-01 — objective persistence DECODE adapter (session JSON →
 * authority domain snapshots) + the ONE v1 → v2 migration.
 *
 * `runner/assemble` is the Layer-2 composition seam: it MAY import BOTH the
 * `@/session` DTO (plain JSON data) and the `@/objective` domain types, so it is
 * the correct home for the pure data adapter that maps between them. The
 * `@/session` slice itself never imports `@/objective` (its `denyImports` forbid
 * it) — it only stores/loads the JSON DTO, preserving the RAW version.
 *
 * Migration (v1 → v2, applied ONCE here, never inside the authority):
 *   - `objectiveId` = deterministic legacy id over (threadId, goal, createdAt);
 *   - `createdBy: "system"`, `migrationSource: "legacy-v1"`;
 *   - a legacy explicit `"completed"` is DISCARDED (⇒ `active`; completion
 *     re-derives from receipts);
 *   - completion / progress receipts inherit the migrated `objectiveId`;
 *   - a goal over the domain ceiling is REFUSED (the thread is dropped with a
 *     warning) — the ceiling is enforced identically at every boundary.
 *
 * This module is a PURE data adapter: no store construction, no behavior. The
 * output order is the persisted thread order — a DETERMINISTIC restore order.
 *
 * exactOptionalPropertyTypes: optional fields are OMITTED when absent.
 */

import type {
  Blocker,
  BlockerObservation,
  CompletionReceipt,
  Objective,
  ObjectiveActor,
  ObjectiveBudget,
  ObjectiveDomainSnapshot,
  ObjectiveStatus,
  ObjectiveThreadSnapshot,
  SuccessCriterion,
  WaitingOn,
} from "@/objective"
import {
  isObjectiveActor,
  isObjectiveAttemptProvenance,
  isStrictVerifierExecutionPosture,
  LEGACY_UNKNOWN_VERIFIER_POSTURE,
  legacyObjectiveId,
  MAX_GOAL_CHARS,
  normalizeCheckDeclaration,
  normalizeProgressReceipt,
} from "@/objective"
import type {
  PersistedBlockerObservation,
  PersistedObjectiveBlocker,
  PersistedObjectiveBodyV2,
  PersistedObjectiveCompletion,
  PersistedObjectiveCriterion,
  PersistedObjectiveSnapshot,
  PersistedObjectiveSnapshotV2,
  PersistedObjectiveThread,
  PersistedObjectiveThreadV2,
  PersistedProgressReceipt,
} from "@/session"
import { OBJECTIVE_SNAPSHOT_VERSION } from "@/session"
import { logger } from "@/shared"

const OBJECTIVE_STATUSES: ReadonlySet<string> = new Set<ObjectiveStatus>([
  "active",
  "paused",
  "usage_limited",
  "budget_limited",
  "completed",
  "blocked",
])

const WAITING_ON: ReadonlySet<string> = new Set<WaitingOn>([
  "user",
  "tool",
  "network",
  "child_agent",
])

// ─────────────────────────────────────────────────────────────────────────────
// v1 → v2 migration (pure)
// ─────────────────────────────────────────────────────────────────────────────

const bindCompletion = (
  c: PersistedObjectiveCompletion | undefined,
  objectiveId: string,
): PersistedObjectiveCompletion | undefined =>
  c === undefined ? undefined : { ...c, objectiveId: c.objectiveId ?? objectiveId }

const bindReceipt = (
  r: PersistedProgressReceipt,
  objectiveId: string,
): PersistedProgressReceipt => ({
  ...r,
  objectiveId: r.objectiveId ?? objectiveId,
})

/** Migrate ONE v1 thread; `null` when it must be refused (goal over the ceiling). */
const migrateThreadV1 = (t: PersistedObjectiveThread): PersistedObjectiveThreadV2 | null => {
  if (t.goal.length > MAX_GOAL_CHARS) {
    logger.warn(
      `objective.migrate.refuse: thread=${t.threadId} goal=${t.goal.length} chars exceeds ${MAX_GOAL_CHARS}`,
    )
    return null
  }
  const objectiveId = legacyObjectiveId({
    threadId: t.threadId,
    goal: t.goal,
    createdAt: t.createdAt,
  })
  const body: PersistedObjectiveBodyV2 = {
    objectiveId,
    createdBy: "system",
    migrationSource: "legacy-v1",
    goal: t.goal,
    successCriteria: t.successCriteria.map((c) => {
      const completion = bindCompletion(c.completion, objectiveId)
      return { ...c, ...(completion !== undefined ? { completion } : {}) }
    }),
    status: t.status,
    // GOAL-01 — a legacy explicit `completed` is never carried forward.
    explicitStatus: t.explicitStatus === "paused" ? "paused" : "active",
    ...(t.usageLimitedUntil !== undefined ? { usageLimitedUntil: t.usageLimitedUntil } : {}),
    budget: t.budget,
    blockers: t.blockers,
    // Legacy observations used model-derived dependencyRef identity. They are
    // intentionally not migrated into host-registry authority.
    nextActions: t.nextActions,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.progressReceipts !== undefined
      ? { progressReceipts: t.progressReceipts.map((r) => bindReceipt(r, objectiveId)) }
      : {}),
  }
  return { threadId: t.threadId, revision: t.revision, objective: body }
}

/**
 * Normalize ANY loadable persisted snapshot to the v2 shape. v2 passes through
 * untouched (idempotent); v1 migrates once. Threads with an empty `threadId`
 * are dropped (never a live thread).
 */
export const normalizeObjectiveSnapshot = (
  snapshot: PersistedObjectiveSnapshot,
): PersistedObjectiveSnapshotV2 => {
  if (snapshot.version === OBJECTIVE_SNAPSHOT_VERSION) {
    return {
      version: OBJECTIVE_SNAPSHOT_VERSION,
      threads: snapshot.threads.filter((t) => t.threadId.length > 0),
    }
  }
  const threads: PersistedObjectiveThreadV2[] = []
  for (const t of snapshot.threads) {
    if (t.threadId.length === 0) continue
    const migrated = migrateThreadV1(t)
    if (migrated !== null) threads.push(migrated)
  }
  return { version: OBJECTIVE_SNAPSHOT_VERSION, threads }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 → domain decode (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Coerce a persisted status string into the closed `ObjectiveStatus` union.
 *  The derived status is RE-DERIVED by the store on restore (from explicit
 *  intent + criteria + blockers), so this is only the advisory projection value;
 *  an unknown string falls back to the explicit intent. */
const toStatus = (raw: string, explicit: ObjectiveStatus): ObjectiveStatus =>
  OBJECTIVE_STATUSES.has(raw) ? (raw as ObjectiveStatus) : explicit

const toWaitingOn = (raw: string): WaitingOn => (WAITING_ON.has(raw) ? (raw as WaitingOn) : "user")

/** RFC-03 C4 — decode a persisted completion receipt into the domain evidence
 *  union, binding it to the thread's generation when the record predates the
 *  field. The manual `actor` string is coerced to the closed `ObjectiveActor`
 *  (unknown ⇒ `system`). */
const toCompletion = (
  raw: PersistedObjectiveCompletion,
  objectiveId: string,
): CompletionReceipt => {
  const boundId = raw.objectiveId ?? objectiveId
  if (raw.source === "verifier") {
    return {
      source: "verifier",
      objectiveId: boundId,
      checkId: raw.checkId,
      objectiveRevision: raw.objectiveRevision,
      sourceDigest: raw.sourceDigest,
      executionPosture: raw.executionPosture ?? LEGACY_UNKNOWN_VERIFIER_POSTURE,
      verifierResult: { exitCode: raw.verifierResult.exitCode, passed: raw.verifierResult.passed },
      verifiedAt: raw.verifiedAt,
    }
  }
  const actor: ObjectiveActor = isObjectiveActor(raw.actor) ? raw.actor : "system"
  return {
    source: "manual",
    objectiveId: boundId,
    actor,
    objectiveRevision: raw.objectiveRevision,
    verifiedAt: raw.verifiedAt,
  }
}

/** RFC-03 C4 + M8 — decode a CHECKED criterion. The `met` flag is FAIL-CLOSED:
 *  a checked criterion is met ONLY when it carries a valid VERIFIER receipt that
 *  BINDS this check (`checkId === check.id`), this generation, AND passed. A
 *  `met:true` with an absent/mismatched/failed receipt (a hand-edited / forged
 *  session file) is downgraded to the un-completed checked state. */
const toCheckedCriterion = (
  c: PersistedObjectiveCriterion,
  checkId: string,
  decl: { argv: readonly string[]; timeoutMs: number; successExitCodes: readonly number[] },
  objectiveId: string,
): SuccessCriterion => {
  const receipt =
    c.completion !== undefined && c.completion.source === "verifier"
      ? toCompletion(c.completion, objectiveId)
      : undefined
  const identityBound =
    receipt !== undefined &&
    receipt.source === "verifier" &&
    receipt.checkId === checkId &&
    receipt.objectiveId === objectiveId &&
    receipt.verifierResult.passed === true
  const met =
    c.met === true &&
    identityBound &&
    receipt !== undefined &&
    receipt.source === "verifier" &&
    isStrictVerifierExecutionPosture(receipt.executionPosture)
  return {
    kind: "checked",
    id: c.id,
    text: c.text,
    met,
    check: {
      id: checkId,
      kind: "command",
      argv: [...decl.argv],
      cwdPolicy: "thread",
      timeoutMs: decl.timeoutMs,
      successExitCodes: [...decl.successExitCodes],
    },
    ...(identityBound && receipt !== undefined ? { completion: receipt } : {}),
  }
}

/** RFC-03 C4 — decode a MANUAL criterion (legacy migration + explicit manual).
 *  A manual receipt rides along when present and bound to this generation. */
const toManualCriterion = (
  c: PersistedObjectiveCriterion,
  objectiveId: string,
): SuccessCriterion => {
  const completion =
    c.completion !== undefined && c.completion.source === "manual"
      ? toCompletion(c.completion, objectiveId)
      : undefined
  return {
    kind: "manual",
    id: c.id,
    text: c.text,
    met: c.met,
    ...(completion !== undefined &&
    completion.source === "manual" &&
    completion.objectiveId === objectiveId
      ? { completion }
      : {}),
  }
}

/** RFC-03 C4 — decode a persisted criterion into the domain manual/checked union. */
const toCriterion = (c: PersistedObjectiveCriterion, objectiveId: string): SuccessCriterion => {
  const decl =
    c.kind === "checked" && c.check !== undefined ? normalizeCheckDeclaration(c.check) : null
  const checkId =
    c.check !== undefined && typeof c.check.id === "string" && c.check.id.length > 0
      ? c.check.id
      : null
  return decl !== null && checkId !== null
    ? toCheckedCriterion(c, checkId, decl, objectiveId)
    : toManualCriterion(c, objectiveId)
}

const toBlocker = (b: PersistedObjectiveBlocker): Blocker => ({
  id: b.id,
  ...(b.dependencyId !== undefined ? { dependencyId: b.dependencyId } : {}),
  reason: b.reason,
  waitingOn: toWaitingOn(b.waitingOn),
  since: b.since,
})

const toBlockerObservation = (item: PersistedBlockerObservation): BlockerObservation | null => {
  if (item.dependencyId === undefined || item.occurrences === undefined) return null
  const occurrences = item.occurrences.filter(
    (occurrence, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.attemptId === occurrence.attemptId ||
          candidate.occurrenceEvidenceId === occurrence.occurrenceEvidenceId,
      ) === index,
  )
  if (occurrences.length === 0) return null
  return {
    observationId: item.observationId,
    dependencyId: item.dependencyId,
    waitingOn: toWaitingOn(item.waitingOn),
    occurrences: occurrences.slice(0, 2).map((occurrence) => ({ ...occurrence })),
  }
}

/** Reconstruct the full public `Objective` from a persisted v2 body. Every field
 *  round-trips verbatim; ids are NEVER re-minted (they carry from the DTO). */
const toObjective = (threadId: string, body: PersistedObjectiveBodyV2): Objective => {
  const budget: ObjectiveBudget = {
    tokensUsed: body.budget.tokensUsed,
    turnsUsed: body.budget.turnsUsed,
    ...(body.budget.maxTokens !== undefined ? { maxTokens: body.budget.maxTokens } : {}),
    ...(body.budget.maxTurns !== undefined ? { maxTurns: body.budget.maxTurns } : {}),
  }
  return {
    objectiveId: body.objectiveId,
    threadId,
    goal: body.goal,
    createdBy: isObjectiveActor(body.createdBy) ? body.createdBy : "system",
    ...(body.migrationSource === "legacy-v1" ? { migrationSource: "legacy-v1" as const } : {}),
    successCriteria: body.successCriteria.map((c) => toCriterion(c, body.objectiveId)),
    status: toStatus(body.status, body.explicitStatus),
    budget,
    blockers: body.blockers.map(toBlocker),
    blockerObservations: (body.blockerObservations ?? [])
      .map(toBlockerObservation)
      .filter((item): item is BlockerObservation => item !== null),
    nextActions: [...body.nextActions],
    attempts: {
      autonomousTurnsStarted: body.attempts?.autonomousTurnsStarted ?? 0,
      ...(body.attempts?.started !== undefined &&
      isObjectiveAttemptProvenance(body.attempts.started.provenance)
        ? {
            started: {
              attemptId: body.attempts.started.attemptId,
              provenance: body.attempts.started.provenance,
              executionMode: body.attempts.started.executionMode,
              startedRevision: body.attempts.started.startedRevision,
              startedAt: body.attempts.started.startedAt,
            },
          }
        : {}),
    },
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  }
}

/** Decode ONE v2 thread into a per-thread domain snapshot (state + revision).
 *  A `null` body is a tombstone: revision only. */
const toDomainSnapshot = (t: PersistedObjectiveThreadV2): ObjectiveDomainSnapshot => {
  if (t.objective === null) return { threadId: t.threadId, revision: t.revision, state: null }
  const body = t.objective
  const state: ObjectiveThreadSnapshot = {
    objective: toObjective(t.threadId, body),
    explicitStatus: body.explicitStatus,
    ...(body.usageLimitedUntil !== undefined ? { usageLimitedUntil: body.usageLimitedUntil } : {}),
  }
  return {
    threadId: t.threadId,
    revision: t.revision,
    state,
    ...(body.progressReceipts !== undefined
      ? {
          progressReceipts: body.progressReceipts
            .map((r) =>
              normalizeProgressReceipt({ ...r, objectiveId: r.objectiveId ?? body.objectiveId }),
            )
            .filter((r) => r !== null),
        }
      : {}),
  }
}

/**
 * Decode a persisted objective snapshot (v1 OR v2) into the ordered per-thread
 * domain snapshots the authority consumes at construction. v1 is migrated once
 * (see {@link normalizeObjectiveSnapshot}). The output order is the persisted
 * order — a fixed, deterministic restore order.
 */
export const decodeObjectiveSnapshot = (
  snapshot: PersistedObjectiveSnapshot,
): readonly ObjectiveDomainSnapshot[] =>
  normalizeObjectiveSnapshot(snapshot).threads.map(toDomainSnapshot)
