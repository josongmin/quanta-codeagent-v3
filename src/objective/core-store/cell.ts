/**
 * ADR-0394 objective store — the CELL model and its pure projections.
 *
 * `Cell` is the store's internal, mutable per-thread record; `Objective` is the
 * frozen projection callers see. Everything here is PURE: no clock, no map, no
 * I/O — a cell in, a value out — which is why it can be shared by the store's
 * operation groups without any of them reaching back into the factory.
 *
 * The derivation rule is unchanged — status is never stored as the source of
 * truth; the caller's last EXPLICIT value is persisted and the public status is
 * derived on every read/write. GOAL-01: the explicit intent is `active | paused`
 * only; `completed` is derived from met criteria (with evidence) and nothing else.
 */

import { randomUUID } from "node:crypto"
import type { ObjectiveAttemptState, StartedObjectiveAttempt } from "../attempt"
import {
  type CheckSpec,
  type CompletionReceipt,
  type CriterionDeclaration,
  type CriterionKind,
  normalizeCheckDeclaration,
} from "../criteria/model"
import { completionSatisfied } from "../policy"
import type { ObjectiveActor, ObjectiveMigrationSource } from "../provenance"
import type {
  Blocker,
  BlockerObservation,
  ExplicitObjectiveStatus,
  GoalDefinition,
  Objective,
  ObjectiveBudget,
  ObjectiveStatus,
  SuccessCriterion,
} from "../types"

/** RFC-03 C4 — internal MUTABLE criterion cell. `kind` discriminates manual vs
 *  checked; `check` is present (frozen, immutable) only for checked criteria;
 *  `completion` is the evidence receipt present only while met with provenance.
 *  Projected to the public frozen {@link SuccessCriterion} union by
 *  {@link toCriterion}. Optional fields are OMITTED when absent (never
 *  `: undefined`) so the projection is byte-stable. */
export interface CritCell {
  id: string
  text: string
  met: boolean
  kind: CriterionKind
  check?: CheckSpec
  completion?: CompletionReceipt
}

/** Internal mutable cell. `explicitStatus` is the caller's last non-derived
 *  intent ("active" | "paused"); the public status is always DERIVED. */
export interface Cell {
  threadId: string
  /** GOAL-01 — authority-issued generation identity. */
  objectiveId: string
  createdBy: ObjectiveActor
  migrationSource?: ObjectiveMigrationSource
  goal: string
  criteria: CritCell[]
  blockers: Blocker[]
  blockerObservations: BlockerObservation[]
  nextActions: string[]
  explicitStatus: ExplicitObjectiveStatus
  /** H17 — epoch-ms until which a transient external usage/rate limit applies.
   *  `undefined` ⇒ no window. Derives `usage_limited` while `now < this` AND the
   *  store enforces; auto-clears (re-derives) once the clock passes it. */
  usageLimitedUntil?: number
  maxTokens?: number
  tokensUsed: number
  maxTurns?: number
  turnsUsed: number
  /** GOAL-04 — durable attempt accounting. */
  autonomousTurnsStarted: number
  startedAttempt?: StartedObjectiveAttempt
  createdAt: number
  updatedAt: number
}

export const buildAttempts = (cell: Cell): ObjectiveAttemptState =>
  Object.freeze({
    autonomousTurnsStarted: cell.autonomousTurnsStarted,
    ...(cell.startedAttempt !== undefined
      ? { started: Object.freeze({ ...cell.startedAttempt }) }
      : {}),
  })

export const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

export const finiteNonNegInt = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined
  return Math.floor(v)
}

/** H17 — exact (NOT heuristic) budget-exhaustion predicate. The objective has
 *  exceeded its envelope when a CONFIGURED cap is met by accumulated usage:
 *  `tokensUsed >= maxTokens` OR `turnsUsed >= maxTurns`. Comparison is `>=`
 *  (reaching the cap is exhaustion). A cap that is `undefined` never triggers;
 *  no caps at all ⇒ never exhausted. Pure function of the cell. */
export const budgetExhausted = (cell: Cell): boolean =>
  (cell.maxTokens !== undefined && cell.tokensUsed >= cell.maxTokens) ||
  (cell.maxTurns !== undefined && cell.turnsUsed >= cell.maxTurns)

/** H17 — is a transient usage/rate window currently active? True only when a
 *  finite `usageLimitedUntil` is set AND the injected clock has NOT yet passed
 *  it (`now < until`). Equality (`now === until`) is the RESET instant: the
 *  window has elapsed and the status re-derives back to the explicit value — no
 *  sticky flag. Pure function of the cell + the clock reading. */
export const usageWindowActive = (cell: Cell, now: number): boolean =>
  cell.usageLimitedUntil !== undefined && now < cell.usageLimitedUntil

/** Derive the public status from the immutable SIX-state rule (Codex
 *  `core/src/goals.rs`). Priority-ordered, TOTAL over the cell + injected clock:
 *
 *    1. blockers.length > 0                  ⇒ blocked        (highest)
 *    2. enforce ∧ usage window active        ⇒ usage_limited  (auto-resets)
 *    3. enforce ∧ budget exhausted (>= cap)  ⇒ budget_limited (hard stop)
 *    4. all criteria met (>=1)               ⇒ completed
 *    5. else                                 ⇒ explicit (active | paused)
 *
 *  `enforce` is the store-level H17 gate (default false). When false this is
 *  byte-identical to the ADR-0394 derivation (neither `usage_limited` nor
 *  `budget_limited` is ever produced — budget stays informational and any usage
 *  window is inert). `now` is the injected clock reading so the usage window
 *  resets deterministically. */
export const deriveStatus = (cell: Cell, enforce: boolean, now: number): ObjectiveStatus => {
  if (cell.blockers.length > 0) return "blocked"
  if (enforce && usageWindowActive(cell, now)) return "usage_limited"
  if (enforce && budgetExhausted(cell)) return "budget_limited"
  // GOAL-02 — completion is a projection of TRUSTED evidence (user/system
  // attestation for a manual criterion, a bound passing verifier receipt for a
  // checked one), never of the bare `met` flag.
  if (
    completionSatisfied({
      objectiveId: cell.objectiveId,
      successCriteria: cell.criteria.map(toCriterion),
      blockers: cell.blockers,
    })
  ) {
    return "completed"
  }
  return cell.explicitStatus
}

/** RFC-03 C4 — project an internal {@link CritCell} to the frozen public
 *  {@link SuccessCriterion} union. `kind` is ALWAYS present (discriminant);
 *  `check`/`completion` are OMITTED when absent so the projection is byte-stable
 *  for a plain manual criterion (`{ kind, id, text, met }`). */
export const toCriterion = (c: CritCell): SuccessCriterion => {
  if (c.kind === "checked" && c.check !== undefined) {
    return Object.freeze({
      kind: "checked" as const,
      id: c.id,
      text: c.text,
      met: c.met,
      check: c.check,
      ...(c.completion !== undefined && c.completion.source === "verifier"
        ? { completion: c.completion }
        : {}),
    })
  }
  return Object.freeze({
    kind: "manual" as const,
    id: c.id,
    text: c.text,
    met: c.met,
    ...(c.completion !== undefined && c.completion.source === "manual"
      ? { completion: c.completion }
      : {}),
  })
}

export const buildBudget = (cell: Cell): ObjectiveBudget => {
  const base = { tokensUsed: cell.tokensUsed, turnsUsed: cell.turnsUsed }
  return Object.freeze({
    ...base,
    ...(cell.maxTokens !== undefined ? { maxTokens: cell.maxTokens } : {}),
    ...(cell.maxTurns !== undefined ? { maxTurns: cell.maxTurns } : {}),
  })
}

/** Project a cell to the frozen public `Objective`. Derives status here (with
 *  the injected clock reading `now`, for the usage-window reset) so no read can
 *  ever observe a status that contradicts blockers/criteria/budget/usage. */
export const toObjective = (cell: Cell, enforce: boolean, now: number): Objective =>
  Object.freeze({
    objectiveId: cell.objectiveId,
    threadId: cell.threadId,
    goal: cell.goal,
    createdBy: cell.createdBy,
    ...(cell.migrationSource !== undefined ? { migrationSource: cell.migrationSource } : {}),
    successCriteria: Object.freeze(cell.criteria.map(toCriterion)),
    status: deriveStatus(cell, enforce, now),
    budget: buildBudget(cell),
    blockers: Object.freeze(cell.blockers.map((b) => Object.freeze({ ...b }))),
    blockerObservations: Object.freeze(
      cell.blockerObservations.map((observation) =>
        Object.freeze({
          ...observation,
          distinctAttemptIds: Object.freeze([...observation.distinctAttemptIds]),
        }),
      ),
    ),
    nextActions: Object.freeze([...cell.nextActions]),
    attempts: buildAttempts(cell),
    createdAt: cell.createdAt,
    updatedAt: cell.updatedAt,
  })

/**
 * SERDE — persist INTENT, not derivation.
 *
 * The public `Objective.status` is a DERIVED value (blockers/criteria win over
 * the caller's explicit intent). The snapshot serializes the underlying
 * `explicitStatus` alongside the derived view; the field is read back verbatim
 * on restore (never inferred from `status`). */
export interface SnapshotObjective extends Objective {
  /** The caller's last EXPLICIT intent — the ONLY status source on restore. */
  readonly explicitStatus: ExplicitObjectiveStatus
  /** H17 — the transient usage window expiry (epoch ms), persisted so a
   *  usage_limited goal stays limited across a snapshot round-trip until its
   *  window naturally elapses. Omitted when no window is set. */
  readonly usageLimitedUntil?: number
}

export const toSnapshotObjective = (cell: Cell, enforce: boolean, now: number): SnapshotObjective =>
  Object.freeze({
    ...toObjective(cell, enforce, now),
    explicitStatus: cell.explicitStatus,
    ...(cell.usageLimitedUntil !== undefined ? { usageLimitedUntil: cell.usageLimitedUntil } : {}),
  })

/** Audit R2 (F3) defensive caps. The agent populates its own threads, so the
 *  exploit surface is "agent misbehaves and floods its own state" — but a
 *  bounded cap is cheap and mirrors the mailbox/run-ledger/approval-LRU
 *  retention discipline. Tuned far above any realistic objective: 256 success
 *  criteria + 64 simultaneous blockers per thread are already absurd; the cap
 *  exists purely to bound pathological growth. */
export const MAX_CRITERIA_PER_OBJECTIVE = 256
export const MAX_BLOCKERS_PER_OBJECTIVE = 64
export const MAX_BLOCKER_OBSERVATIONS = 8

/** RFC-03 C4 — mint a fresh MANUAL criterion cell (not met, no completion). */
export const manualCrit = (text: string): CritCell => ({
  id: randomUUID(),
  text,
  met: false,
  kind: "manual",
})

/** RFC-03 C4 — mint a fresh CHECKED criterion cell from a (validated) check
 *  declaration. The `check` is domain-stamped with a fresh immutable `id` +
 *  fixed `cwdPolicy:"thread"` and FROZEN so it can never mutate after creation. */
export const checkedCrit = (text: string, decl: CheckSpecDeclarationLike): CritCell => ({
  id: randomUUID(),
  text,
  met: false,
  kind: "checked",
  check: Object.freeze({
    id: randomUUID(),
    kind: "command",
    argv: Object.freeze([...decl.argv]),
    cwdPolicy: "thread",
    timeoutMs: decl.timeoutMs,
    successExitCodes: Object.freeze([...decl.successExitCodes]),
  }),
})

export type CheckSpecDeclarationLike = {
  argv: readonly string[]
  timeoutMs: number
  successExitCodes: readonly number[]
}

/** Append manual cells for each string in the legacy list, honoring the live cap
 *  (`push` returns false when full ⇒ stop). Non-string entries are skipped. */
export const collectStringCriteria = (
  raw: readonly string[] | undefined,
  push: (c: CritCell) => boolean,
): void => {
  if (!Array.isArray(raw)) return
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    if (!push(manualCrit(entry))) break
  }
}

/** Append cells for each RFC-03 C4 rich declaration: a runnable `check` ⇒ checked,
 *  else manual. Honors the live cap via `push` (false ⇒ stop); malformed entries
 *  are skipped. */
export const collectDeclarationCriteria = (
  declarations: readonly CriterionDeclaration[] | undefined,
  push: (c: CritCell) => boolean,
): void => {
  if (!Array.isArray(declarations)) return
  for (const decl of declarations) {
    if (decl === null || typeof decl !== "object") continue
    const text = typeof decl.text === "string" ? decl.text : ""
    const check = normalizeCheckDeclaration(decl.check)
    if (!push(check !== null ? checkedCrit(text, check) : manualCrit(text))) break
  }
}

/** Build criterion cells from the legacy string list PLUS the RFC-03 C4 rich
 *  declarations. Strings ⇒ manual; a declaration with a runnable `check` ⇒
 *  checked; a declaration with no/invalid check ⇒ manual. Applies the live cap
 *  via the shared `push` (both collectors share the ONE cap budget). */
export const sanitizeCriteria = (
  raw: readonly string[] | undefined,
  declarations: readonly CriterionDeclaration[] | undefined,
): CritCell[] => {
  const out: CritCell[] = []
  const push = (c: CritCell): boolean => {
    if (out.length >= MAX_CRITERIA_PER_OBJECTIVE) return false
    out.push(c)
    return true
  }
  collectStringCriteria(raw, push)
  collectDeclarationCriteria(declarations, push)
  return out
}

/** GOAL-01 — the provenance the authority binds when minting a generation. */
export interface CellProvenance {
  readonly objectiveId: string
  readonly createdBy: ObjectiveActor
}

/** Build a fresh cell from an already-normalized definition + bound provenance. */
export const cellFromDefinition = (
  threadId: string,
  definition: GoalDefinition,
  provenance: CellProvenance,
  t: number,
): Cell => {
  const maxTokens = finiteNonNegInt(definition.budget?.maxTokens)
  const maxTurns = finiteNonNegInt(definition.budget?.maxTurns)
  return {
    threadId,
    objectiveId: provenance.objectiveId,
    createdBy: provenance.createdBy,
    goal: typeof definition.goal === "string" ? definition.goal : "",
    criteria: sanitizeCriteria(
      definition.successCriteria ?? undefined,
      definition.criteria ?? undefined,
    ),
    blockers: [],
    blockerObservations: [],
    nextActions: [],
    explicitStatus: "active",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: 0,
    autonomousTurnsStarted: 0,
    createdAt: t,
    updatedAt: t,
  }
}
