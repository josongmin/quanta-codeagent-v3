/**
 * ADR-0394 objective store — snapshot -> `Cell` rehydration.
 *
 * The inverse of `cell.ts`'s projections, and deliberately TOTAL: every builder
 * here validates the raw shape and drops what it cannot rebuild, so a truncated
 * or foreign snapshot restores a partial-but-valid store rather than throwing
 * into a caller that expects the store's no-throw contract.
 *
 * Moved out of `../store.ts` with `cell.ts`, for the same cycle reason.
 */

import { randomUUID } from "node:crypto"
import { logger } from "@/shared"
import {
  type CheckSpec,
  type CompletionReceipt,
  type CriterionKind,
  isManualReceipt,
  isVerifierReceipt,
  normalizeCheckDeclaration,
} from "../criteria/model"
import type { ExplicitStatus, ObjectiveThreadSnapshot } from "../model"
import type { Blocker, ObjectiveBudget } from "../types"
import {
  type Cell,
  type CritCell,
  finiteNonNegInt,
  isNonEmptyString,
  MAX_BLOCKERS_PER_OBJECTIVE,
  MAX_CRITERIA_PER_OBJECTIVE,
  type SnapshotObjective,
} from "./cell"

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
  const explicit: ExplicitStatus =
    state.explicitStatus === "completed"
      ? "completed"
      : state.explicitStatus === "paused"
        ? "paused"
        : "active"
  const maxTokens = finiteNonNegInt(o.budget?.maxTokens)
  const maxTurns = finiteNonNegInt(o.budget?.maxTurns)
  return {
    threadId,
    goal: typeof o.goal === "string" ? o.goal : "",
    // RFC-03 C4 — rebuild criteria kind/check/completion verbatim (ids + check
    // ids preserved) so an EXACT undo/restore never drops provenance.
    criteria: rebuildCriteria(o.successCriteria),
    blockers: (Array.isArray(o.blockers) ? o.blockers : []).map((b) => ({
      id: isNonEmptyString(b.id) ? b.id : randomUUID(),
      reason: typeof b.reason === "string" ? b.reason : "",
      waitingOn: b.waitingOn,
      since: finiteOrZero(b.since),
    })),
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
    createdAt: finiteOrZero(o.createdAt),
    updatedAt: finiteOrZero(o.updatedAt),
  }
}

const finiteOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Re-apply the live `sanitizeCriteria` caps when rebuilding from a snapshot.
 *  R4 audit-M closure: without this, a hostile/corrupted snapshot could ship
 *  a 1M-entry `successCriteria` array and inflate the in-memory cell past the
 *  256-criterion live cap that `set()` enforces. Slice equally with the live
 *  path so byte-identical snapshot round-trip from a healthy run stays exact
 *  (every healthy snapshot is already ≤ MAX_CRITERIA_PER_OBJECTIVE).
 *
 *  R5 audit-H4 closure: emit a `logger.warn` when the cap is hit so the
 *  truncation is observable (silent truncation was invisible to operators
 *  inspecting why a snapshot lost data). Single line per rebuild — the
 *  label-keyed leaky bucket in `logger.ts` bounds the rate even under a
 *  pathological replay flood. */
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

/** RFC-03 C4 — rebuild a completion receipt from a persisted/snapshot record,
 *  matching the arm: a MANUAL criterion accepts only a manual receipt, a CHECKED
 *  criterion only a verifier receipt. A malformed/mismatched receipt is DROPPED
 *  (⇒ undefined) rather than fabricated. Stored frozen. */
const rebuildCompletion = (raw: unknown, kind: CriterionKind): CompletionReceipt | undefined => {
  if (kind === "checked") return isVerifierReceipt(raw) ? Object.freeze({ ...raw }) : undefined
  return isManualReceipt(raw) ? Object.freeze({ ...raw }) : undefined
}

/** RFC-03 C4 — rebuild ONE criterion cell from a persisted/snapshot record. A
 *  record with `kind:"checked"` and a valid check ⇒ checked (id preserved); any
 *  other record (legacy `{id,text,met}`, `kind:"manual"`, or a checked record
 *  whose check is unrecoverable) ⇒ manual. Completion evidence rides along when
 *  it matches the arm. */
const rebuildCritCell = (raw: unknown): CritCell | null => {
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
    // receipt that BINDS this check (checkId === check.id) AND passed — the exact
    // invariant `applyVerifierCompletion` enforces on the live path. A forged
    // `met:true` with an absent/mismatched/failed receipt (hand-edited snapshot)
    // is downgraded to the un-completed checked state (met:false, no completion).
    const comp = rebuildCompletion(r.completion, "checked")
    const bound =
      comp !== undefined &&
      comp.source === "verifier" &&
      comp.checkId === check.id &&
      comp.verifierResult.passed === true
    const metChecked = met && bound
    const cell: CritCell = { id, text, met: metChecked, kind: "checked", check }
    if (metChecked && comp !== undefined) cell.completion = comp
    return cell
  }
  const cell: CritCell = { id, text, met, kind: "manual" }
  const comp = rebuildCompletion(r.completion, "manual")
  if (comp !== undefined) cell.completion = comp
  return cell
}

const rebuildCriteria = (raw: unknown): CritCell[] => {
  if (!Array.isArray(raw)) return []
  const out: CritCell[] = []
  for (const c of raw) {
    if (out.length >= MAX_CRITERIA_PER_OBJECTIVE) break
    const cell = rebuildCritCell(c)
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
 *  forever (status derivation requires blockers.length === 0 to leave).
 *
 *  R5 audit-H4 closure: same observability discipline as `rebuildCriteria`. */
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

/**
 * Recover the persisted EXPLICIT intent from a snapshot entry.
 *
 * SERDE fix: read ONLY the dedicated `explicitStatus` field — NEVER the derived
 * `status`. If the explicit field is absent (legacy snapshot written before the
 * field existed, or a hostile payload), we cannot know whether a `completed`
 * status was explicit intent or auto-derived from met criteria; the safe,
 * non-fabricating answer is `active`. Defaulting to `active` is correct rather
 * than a silent fallback: the public `status` is RE-DERIVED from criteria after
 * restore, so a genuinely-complete objective (all criteria met) still reports
 * `completed`, and only the explicit-vs-derived distinction is reset — exactly
 * the field whose legacy value is unknowable. This never UPGRADES a derived
 * completion to explicit intent (the bug), it only ever stays/declines. */
const explicitFromSnapshot = (rec: {
  explicitStatus?: unknown
}): "active" | "paused" | "completed" => {
  if (rec.explicitStatus === "completed") return "completed"
  if (rec.explicitStatus === "paused") return "paused"
  return "active"
}

/** Reconstruct a mutable cell from a (possibly hostile) snapshot entry. */
export function cellFromObjective(o: unknown): Cell | null {
  if (o === null || typeof o !== "object") return null
  const rec = o as Partial<SnapshotObjective>
  if (!isNonEmptyString(rec.threadId)) return null
  const budget = (rec.budget ?? {}) as Partial<ObjectiveBudget>
  const maxTokens = finiteNonNegInt(budget.maxTokens)
  const maxTurns = finiteNonNegInt(budget.maxTurns)
  return {
    threadId: rec.threadId,
    goal: typeof rec.goal === "string" ? rec.goal : "",
    criteria: rebuildCriteria(rec.successCriteria),
    blockers: rebuildBlockers(rec.blockers),
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
    createdAt: finiteOrZero(rec.createdAt),
    updatedAt: finiteOrZero(rec.updatedAt),
  }
}
