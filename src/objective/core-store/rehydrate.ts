/**
 * ADR-0394 objective store — snapshot -> `Cell` rehydration.
 *
 * The inverse of `cell.ts`'s projections, and deliberately TOTAL: every builder
 * here validates the raw shape and drops what it cannot rebuild, so a truncated
 * or foreign snapshot restores a partial-but-valid store rather than throwing
 * into a caller that expects the store's no-throw contract.
 *
 * GOAL-01 migration rules (applied to ANY record that predates the field):
 *   - a missing `objectiveId` becomes the deterministic legacy id and the cell
 *     is tagged `migrationSource: "legacy-v1"` with `createdBy: "system"`;
 *   - a legacy explicit `"completed"` intent is DISCARDED (⇒ `active`) — the
 *     public status re-derives from criteria evidence, never from the flag;
 *   - a completion receipt missing its `objectiveId` inherits the cell's.
 */

import { randomUUID } from "node:crypto"
import { logger } from "@/shared"
import { isObjectiveAttemptProvenance, type StartedObjectiveAttempt } from "../attempt"
import {
  type CheckSpec,
  type CompletionReceipt,
  type CriterionKind,
  isManualReceipt,
  isVerifierReceipt,
  normalizeCheckDeclaration,
} from "../criteria/model"
import { isObjectiveIdLike, legacyObjectiveId } from "../identity"
import type { ExplicitStatus, ObjectiveThreadSnapshot } from "../model"
import { isObjectiveActor, type ObjectiveActor } from "../provenance"
import type { Blocker, BlockerObservation, ObjectiveBudget, WaitingOn } from "../types"
import {
  type Cell,
  type CritCell,
  finiteNonNegInt,
  isNonEmptyString,
  MAX_BLOCKER_OBSERVATIONS,
  MAX_BLOCKERS_PER_OBJECTIVE,
  MAX_CRITERIA_PER_OBJECTIVE,
  type SnapshotObjective,
} from "./cell"

const finiteOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** GOAL-04 — rebuild the attempt accounting; a malformed started record is dropped. */
const rebuildAttempts = (
  raw: unknown,
): { autonomousTurnsStarted: number; startedAttempt?: StartedObjectiveAttempt } => {
  const rec = (raw ?? {}) as { autonomousTurnsStarted?: unknown; started?: unknown }
  const started = rec.started as Partial<StartedObjectiveAttempt> | undefined
  const validStarted =
    started !== undefined &&
    started !== null &&
    isNonEmptyString(started.attemptId) &&
    isObjectiveAttemptProvenance(started.provenance) &&
    (started.executionMode === "foreground" || started.executionMode === "background")
  return {
    autonomousTurnsStarted: finiteNonNegInt(rec.autonomousTurnsStarted) ?? 0,
    ...(validStarted
      ? {
          startedAttempt: {
            attemptId: started.attemptId as string,
            provenance: started.provenance as StartedObjectiveAttempt["provenance"],
            executionMode: started.executionMode as "foreground" | "background",
            startedRevision: finiteNonNegInt(started.startedRevision) ?? 0,
            startedAt: finiteOrZero(started.startedAt),
          },
        }
      : {}),
  }
}

/** GOAL-01 — resolve the generation identity + provenance of a raw record. */
const identityOf = (
  threadId: string,
  rec: {
    objectiveId?: unknown
    createdBy?: unknown
    migrationSource?: unknown
    goal?: unknown
    createdAt?: unknown
  },
): Pick<Cell, "objectiveId" | "createdBy" | "migrationSource"> => {
  if (isObjectiveIdLike(rec.objectiveId)) {
    return {
      objectiveId: rec.objectiveId,
      createdBy: isObjectiveActor(rec.createdBy) ? rec.createdBy : "system",
      ...(rec.migrationSource === "legacy-v1" ? { migrationSource: "legacy-v1" as const } : {}),
    }
  }
  return {
    objectiveId: legacyObjectiveId({
      threadId,
      goal: typeof rec.goal === "string" ? rec.goal : "",
      createdAt: finiteOrZero(rec.createdAt),
    }),
    createdBy: "system",
    migrationSource: "legacy-v1",
  }
}

/** Reconstruct a mutable cell from a captured per-thread snapshot. Exact:
 *  criterion ids/met, blocker ids/since, next actions, explicit intent, usage
 *  window, budget and timestamps all round-trip verbatim (used by the
 *  authority's `restore`, so an undo never re-mints ids or drops `met`). */
export const cellFromThreadSnapshot = (
  threadId: string,
  state: ObjectiveThreadSnapshot,
): Cell | null => {
  const o = state.objective
  if (o === null || typeof o !== "object") return null
  const identity = identityOf(threadId, o)
  const explicit: ExplicitStatus = state.explicitStatus === "paused" ? "paused" : "active"
  const maxTokens = finiteNonNegInt(o.budget?.maxTokens)
  const maxTurns = finiteNonNegInt(o.budget?.maxTurns)
  return {
    threadId,
    ...identity,
    goal: typeof o.goal === "string" ? o.goal : "",
    // RFC-03 C4 — rebuild criteria kind/check/completion verbatim (ids + check
    // ids preserved) so an EXACT undo/restore never drops provenance.
    criteria: rebuildCriteria(o.successCriteria, identity.objectiveId),
    blockers: (Array.isArray(o.blockers) ? o.blockers : []).map((b) => ({
      id: isNonEmptyString(b.id) ? b.id : randomUUID(),
      reason: typeof b.reason === "string" ? b.reason : "",
      waitingOn: b.waitingOn,
      since: finiteOrZero(b.since),
    })),
    blockerObservations: rebuildBlockerObservations(o.blockerObservations),
    nextActions: Array.isArray(o.nextActions)
      ? o.nextActions.filter((a): a is string => typeof a === "string")
      : [],
    explicitStatus: explicit,
    ...(state.usageLimitedUntil !== undefined &&
    Number.isFinite(state.usageLimitedUntil) &&
    state.usageLimitedUntil > 0
      ? { usageLimitedUntil: state.usageLimitedUntil }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: finiteNonNegInt(o.budget?.tokensUsed) ?? 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: finiteNonNegInt(o.budget?.turnsUsed) ?? 0,
    ...rebuildAttempts((o as { attempts?: unknown }).attempts),
    createdAt: finiteOrZero(o.createdAt),
    updatedAt: finiteOrZero(o.updatedAt),
  }
}

/** RFC-03 C4 — rebuild the IMMUTABLE {@link CheckSpec} from a persisted/snapshot
 *  record, PRESERVING its `id` verbatim (a verifier receipt references it, so it
 *  must never be re-minted). Returns `null` when the record is not a runnable
 *  command check (⇒ the criterion downgrades to manual). Stored frozen. */
const rebuildCheck = (raw: unknown): CheckSpec | null => {
  if (raw === null || typeof raw !== "object") return null
  const r = raw as { id?: unknown }
  if (!isNonEmptyString(r.id)) return null
  const decl = normalizeCheckDeclaration(raw)
  if (decl === null) return null
  return Object.freeze({
    id: r.id,
    kind: "command" as const,
    argv: Object.freeze([...decl.argv]),
    cwdPolicy: "thread" as const,
    timeoutMs: decl.timeoutMs,
    successExitCodes: Object.freeze([...decl.successExitCodes]),
  })
}

/** GOAL-01 — a receipt written before `objectiveId` existed inherits the cell's
 *  generation (the migration binds legacy evidence to the migrated generation). */
const withObjectiveId = (raw: unknown, objectiveId: string): unknown =>
  raw !== null &&
  typeof raw === "object" &&
  !isObjectiveIdLike((raw as { objectiveId?: unknown }).objectiveId)
    ? { ...(raw as Record<string, unknown>), objectiveId }
    : raw

/** RFC-03 C4 — rebuild a completion receipt from a persisted/snapshot record,
 *  matching the arm: a MANUAL criterion accepts only a manual receipt, a CHECKED
 *  criterion only a verifier receipt. A malformed/mismatched receipt is DROPPED
 *  (⇒ undefined) rather than fabricated. Stored frozen. */
const rebuildCompletion = (
  raw: unknown,
  kind: CriterionKind,
  objectiveId: string,
): CompletionReceipt | undefined => {
  const bound = withObjectiveId(raw, objectiveId)
  if (kind === "checked") return isVerifierReceipt(bound) ? Object.freeze({ ...bound }) : undefined
  return isManualReceipt(bound) ? Object.freeze({ ...bound }) : undefined
}

/** RFC-03 C4 — rebuild ONE criterion cell from a persisted/snapshot record. A
 *  record with `kind:"checked"` and a valid check ⇒ checked (id preserved); any
 *  other record (legacy `{id,text,met}`, `kind:"manual"`, or a checked record
 *  whose check is unrecoverable) ⇒ manual. Completion evidence rides along when
 *  it matches the arm AND binds the live generation. */
const rebuildCritCell = (raw: unknown, objectiveId: string): CritCell | null => {
  if (raw === null || typeof raw !== "object") return null
  const r = raw as {
    id?: unknown
    text?: unknown
    met?: unknown
    kind?: unknown
    check?: unknown
    completion?: unknown
  }
  const id = isNonEmptyString(r.id) ? r.id : randomUUID()
  const text = typeof r.text === "string" ? r.text : ""
  const met = r.met === true
  const check = r.kind === "checked" ? rebuildCheck(r.check) : null
  if (check !== null) {
    // RFC-03 C4 + M8 — a CHECKED criterion is met ONLY with a valid verifier
    // receipt that BINDS this check (checkId === check.id), this generation, AND
    // passed — the exact invariant `applyVerifierCompletion` enforces on the live
    // path. A forged `met:true` with an absent/mismatched/failed receipt
    // (hand-edited snapshot) is downgraded to the un-completed checked state.
    const comp = rebuildCompletion(r.completion, "checked", objectiveId)
    const bound =
      comp !== undefined &&
      comp.source === "verifier" &&
      comp.checkId === check.id &&
      comp.objectiveId === objectiveId &&
      comp.verifierResult.passed === true
    const metChecked = met && bound
    const cell: CritCell = { id, text, met: metChecked, kind: "checked", check }
    if (metChecked && comp !== undefined) cell.completion = comp
    return cell
  }
  const cell: CritCell = { id, text, met, kind: "manual" }
  const comp = rebuildCompletion(r.completion, "manual", objectiveId)
  if (comp !== undefined && comp.objectiveId === objectiveId) cell.completion = comp
  return cell
}

/** Re-apply the live `sanitizeCriteria` caps when rebuilding from a snapshot.
 *  R4 audit-M closure: without this, a hostile/corrupted snapshot could ship
 *  a 1M-entry `successCriteria` array and inflate the in-memory cell past the
 *  256-criterion live cap that `create()` enforces. R5 audit-H4 closure: emit a
 *  `logger.warn` when the cap is hit so the truncation is observable. */
const rebuildCriteria = (raw: unknown, objectiveId: string): CritCell[] => {
  if (!Array.isArray(raw)) return []
  const out: CritCell[] = []
  for (const c of raw) {
    if (out.length >= MAX_CRITERIA_PER_OBJECTIVE) break
    const cell = rebuildCritCell(c, objectiveId)
    if (cell !== null) out.push(cell)
  }
  if (raw.length > MAX_CRITERIA_PER_OBJECTIVE) {
    logger.warn(
      `objective.rebuild.truncate: criteria=${raw.length} capped to ${MAX_CRITERIA_PER_OBJECTIVE}`,
    )
  }
  return out
}

/** Mirror of `rebuildCriteria` for the 64-blocker live cap. Hostile snapshot
 *  could otherwise ship N blockers and stick the objective in `blocked` state
 *  forever (status derivation requires blockers.length === 0 to leave). */
const rebuildBlockers = (raw: unknown): Blocker[] => {
  if (!Array.isArray(raw)) return []
  const out: Blocker[] = []
  for (const b of raw) {
    if (b === null || typeof b !== "object") continue
    if (out.length >= MAX_BLOCKERS_PER_OBJECTIVE) break
    out.push({
      id: isNonEmptyString(b.id) ? b.id : randomUUID(),
      reason: typeof b.reason === "string" ? b.reason : "",
      waitingOn: b.waitingOn,
      since: finiteOrZero(b.since),
    })
  }
  if (raw.length > MAX_BLOCKERS_PER_OBJECTIVE) {
    logger.warn(
      `objective.rebuild.truncate: blockers=${raw.length} capped to ${MAX_BLOCKERS_PER_OBJECTIVE}`,
    )
  }
  return out
}

const normalizeWaitingOn = (value: unknown): WaitingOn | null =>
  value === "user" || value === "tool" || value === "network" || value === "child_agent"
    ? value
    : null

const rebuildBlockerObservations = (raw: unknown): BlockerObservation[] => {
  if (!Array.isArray(raw)) return []
  const out: BlockerObservation[] = []
  for (const item of raw) {
    if (out.length >= MAX_BLOCKER_OBSERVATIONS) break
    if (item === null || typeof item !== "object") continue
    const candidate = item as Partial<BlockerObservation>
    const waitingOn = normalizeWaitingOn(candidate.waitingOn)
    if (
      !isNonEmptyString(candidate.dependencyRef) ||
      candidate.dependencyRef.length > 2_100 ||
      waitingOn === null ||
      !Array.isArray(candidate.distinctAttemptIds)
    ) {
      continue
    }
    const attempts = [
      ...new Set(
        candidate.distinctAttemptIds.filter(
          (attempt): attempt is string => isNonEmptyString(attempt) && attempt.length <= 512,
        ),
      ),
    ].slice(0, 2)
    if (attempts.length === 0) continue
    out.push({
      observationId: isNonEmptyString(candidate.observationId)
        ? candidate.observationId
        : randomUUID(),
      dependencyRef: candidate.dependencyRef,
      waitingOn,
      distinctAttemptIds: attempts,
      lastObservedAt: finiteOrZero(candidate.lastObservedAt),
    })
  }
  return out
}

/**
 * Recover the persisted EXPLICIT intent from a snapshot entry.
 *
 * Read ONLY the dedicated `explicitStatus` field — NEVER the derived `status`.
 * GOAL-01: a legacy `"completed"` intent is discarded (⇒ `active`); the public
 * status is RE-DERIVED from criteria evidence after restore. */
const explicitFromSnapshot = (rec: { explicitStatus?: unknown }): ExplicitStatus =>
  rec.explicitStatus === "paused" ? "paused" : "active"

/** Reconstruct a mutable cell from a (possibly hostile) snapshot entry. */
export function cellFromObjective(o: unknown): Cell | null {
  if (o === null || typeof o !== "object") return null
  const rec = o as Partial<SnapshotObjective> & { createdBy?: ObjectiveActor }
  if (!isNonEmptyString(rec.threadId)) return null
  const identity = identityOf(rec.threadId, rec)
  const budget = (rec.budget ?? {}) as Partial<ObjectiveBudget>
  const maxTokens = finiteNonNegInt(budget.maxTokens)
  const maxTurns = finiteNonNegInt(budget.maxTurns)
  return {
    threadId: rec.threadId,
    ...identity,
    goal: typeof rec.goal === "string" ? rec.goal : "",
    criteria: rebuildCriteria(rec.successCriteria, identity.objectiveId),
    blockers: rebuildBlockers(rec.blockers),
    blockerObservations: rebuildBlockerObservations(rec.blockerObservations),
    nextActions: Array.isArray(rec.nextActions)
      ? rec.nextActions.filter((a): a is string => typeof a === "string")
      : [],
    explicitStatus: explicitFromSnapshot(rec),
    ...(typeof rec.usageLimitedUntil === "number" &&
    Number.isFinite(rec.usageLimitedUntil) &&
    rec.usageLimitedUntil > 0
      ? { usageLimitedUntil: rec.usageLimitedUntil }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: finiteNonNegInt(budget.tokensUsed) ?? 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: finiteNonNegInt(budget.turnsUsed) ?? 0,
    ...rebuildAttempts((rec as { attempts?: unknown }).attempts),
    createdAt: finiteOrZero(rec.createdAt),
    updatedAt: finiteOrZero(rec.updatedAt),
  }
}
