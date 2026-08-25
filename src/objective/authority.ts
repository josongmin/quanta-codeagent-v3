/**
 * RFC-03 C1 / GOAL-01 — the revisioned objective mutation AUTHORITY.
 *
 * The single writer of the objective domain. It wraps the raw core store
 * (`./store`) and adds:
 *
 *   - a per-thread monotonic REVISION (kept as a TOMBSTONE after `clear`),
 *   - the closed `ObjectiveMutation` union routed through ONE exhaustive dispatch
 *     table (adding a variant without a handler fails compile; deleting a live
 *     handler makes the mutation-completeness ratchet RED),
 *   - `prepare` / `commit` with compare-and-swap so two writers that prepared at
 *     the same revision cannot both apply — exactly one commits, the other is
 *     `stale` (and never clobbers the winner),
 *   - `restore(prior, expectedRevision)` for EXACT undo under CAS,
 *   - ACTOR/THREAD binding: thread identity and actor come from the CALLER, never
 *     model input (RFC-03 §8); a MODEL actor may NOT complete a criterion,
 *   - GENERATION identity: `create`/`replace` mint an `objectiveId` and bind
 *     `createdBy`; every evidence family is dropped when a generation starts or
 *     ends, and a receipt bound to another generation is refused,
 *   - HOST-measured usage: `settleAttempt` (system actor only) is the sole
 *     budget debit and progress-receipt producer.
 *
 * The `ObjectivePort` surface is the SYSTEM-actor capability every existing
 * caller routes through — no direct store call remains.
 *
 * SLICE FENCE: imports ONLY sibling modules + is a pure leaf (no `@/agent` etc.).
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import { errMessage, logger } from "@/shared"
import type { CellProvenance } from "./core-store/cell"
import type { ManualCompletionReceipt } from "./criteria/model"
import { isVerifierReceipt } from "./criteria/model"
import { checkPassed, MAX_CHECKS_PER_BATCH, type VerificationBatch } from "./criteria/ports"
import { autonomousAllowance, resolveProductAutonomousTurnCap } from "./goal-wake-policy"
import { defaultObjectiveIdFactory, MAX_GOAL_CHARS, normalizeGoalText } from "./identity"
import type { ObjectiveDomainSnapshot, ValidationContract } from "./model"
import {
  isGenerationMutationKind,
  type ObjectiveActor,
  type ObjectiveAttemptSettlement,
  type ObjectiveMutation,
  type ObjectiveOperationKind,
} from "./mutations"
import { authorizeMutation, validationContractOf } from "./policy"
import type {
  ApprovalReceipt,
  CommitRejection,
  CommitResult,
  ObjectiveAuthority,
  ObjectiveAuthorityOptions,
  ObjectiveMutationCommand,
  PreparedObjectiveMutation,
} from "./ports"
import {
  appendProgressReceipt,
  MAX_PROGRESS_RECEIPTS,
  normalizeProgressReceipt,
  type ProgressReceipt,
  verifierReceiptRef,
} from "./progress-receipt"
import { createObjectiveCoreStore, type ObjectiveCore } from "./store"
import type { GoalDefinition, Objective, ObjectivePort } from "./types"

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

/** GOAL-02 — the derived stopping-contract field of a domain snapshot. */
const contractOf = (
  o: Objective | null,
): { readonly validationContract: ValidationContract } | Record<never, never> =>
  o === null ? {} : { validationContract: validationContractOf(o) }

/** Per-thread evidence view a handler may read/append (bound by `route`). */
interface EvidenceContext {
  readonly receipts: readonly ProgressReceipt[]
  readonly append: (receipt: ProgressReceipt) => void
}

/** RFC-03 C4 — provenance context threaded into every mutation handler: the
 *  BOUND actor, the current (pre-apply) revision, the clock reading, the id
 *  minter and the thread's evidence view. Handlers that record completion
 *  evidence mint receipts from this — never from the mutation payload. */
interface MutationContext {
  readonly actor: ObjectiveActor
  readonly revision: number
  readonly now: number
  readonly mintId: () => string
  readonly evidence: EvidenceContext
  /** GOAL-06 — the effective product autonomous cap for this authority. */
  readonly productAutonomousTurnCap: number
}

/** Outcome of applying one mutation to the core. `applied:false` ⇒ the op did
 *  not take effect so the revision must NOT advance; `result` is the core's
 *  byte-identical return. `rejection` carries the precise refusal reason a
 *  structural guard produced; absent ⇒ the commit defaults to `invalid`. */
interface ApplyOutcome {
  readonly applied: boolean
  readonly result: Objective | null
  readonly rejection?: CommitRejection | undefined
}

type HandlerFor<K extends ObjectiveOperationKind> = (
  core: ObjectiveCore,
  threadId: string,
  m: Extract<ObjectiveMutation, { kind: K }>,
  ctx: MutationContext,
) => ApplyOutcome

/** The ONE exhaustive dispatch table. `{ [K in ObjectiveOperationKind]: … }`
 *  makes a new union variant a COMPILE error until it is routed here; deleting a
 *  handler removes the op's effect and the ratchet catches it. */
type DispatchTable = { [K in ObjectiveOperationKind]: HandlerFor<K> }

const applied = (result: Objective | null): ApplyOutcome => ({ applied: result !== null, result })

const refused = (
  core: ObjectiveCore,
  threadId: string,
  rejection: CommitRejection,
): ApplyOutcome => ({
  applied: false,
  result: core.get(threadId),
  rejection,
})

/** GOAL-01 — the domain-owned goal-text check shared by create/replace. */
const definitionRejection = (definition: GoalDefinition): CommitRejection | null => {
  if (definition === null || typeof definition !== "object") return "invalid"
  if (typeof definition.goal === "string" && definition.goal.length > MAX_GOAL_CHARS) {
    return "goal-too-long"
  }
  return normalizeGoalText(definition.goal) === null ? "invalid" : null
}

const mintGeneration = (
  core: ObjectiveCore,
  threadId: string,
  m: Extract<ObjectiveMutation, { kind: "create" | "replace" }>,
  ctx: MutationContext,
): ApplyOutcome => {
  const rejection = definitionRejection(m.definition)
  if (rejection !== null) return refused(core, threadId, rejection)
  const exists = core.get(threadId) !== null
  if (m.kind === "create" && exists) return refused(core, threadId, "objective-exists")
  if (m.kind === "replace" && !exists) return refused(core, threadId, "objective-missing")
  const provenance: CellProvenance = { objectiveId: ctx.mintId(), createdBy: ctx.actor }
  const result =
    m.kind === "create"
      ? core.create(threadId, m.definition, provenance)
      : core.replace(threadId, m.definition, provenance)
  return result === null ? refused(core, threadId, "invalid") : { applied: true, result }
}

/** GOAL-04 — every reason a settlement is refused, in check order. */
const settlementRejection = (
  current: Objective,
  settlement: ObjectiveAttemptSettlement,
  ctx: MutationContext,
): CommitRejection | undefined => {
  if (
    settlement === null ||
    typeof settlement !== "object" ||
    !isNonEmptyString(settlement.attemptId)
  ) {
    return "invalid"
  }
  if (settlement.objectiveId !== current.objectiveId) return "objective-mismatch"
  if (ctx.evidence.receipts.some((r) => r.attemptKey === settlement.attemptId)) {
    return "attempt-replayed"
  }
  // A durable started attempt must be the one being settled.
  const started = current.attempts.started
  if (started !== undefined && started.attemptId !== settlement.attemptId) {
    return "attempt-in-flight"
  }
  return undefined
}

const passingVerifierRefs = (current: Objective): readonly string[] =>
  current.successCriteria.flatMap((c) =>
    c.kind === "checked" && c.completion !== undefined && c.completion.verifierResult.passed
      ? [
          verifierReceiptRef({
            criterionId: c.id,
            checkId: c.completion.checkId,
            objectiveRevision: c.completion.objectiveRevision,
          }),
        ]
      : [],
  )

const buildSettlementReceipt = (
  current: Objective,
  settlement: ObjectiveAttemptSettlement,
  ctx: MutationContext,
): ProgressReceipt | null => {
  const before = new Set(settlement.criterionIdsBefore ?? [])
  const refsBefore = new Set(settlement.verifierReceiptIdsBefore ?? [])
  return normalizeProgressReceipt({
    objectiveId: current.objectiveId,
    attemptKey: settlement.attemptId,
    objectiveRevisionBefore: Math.min(
      Number.isSafeInteger(settlement.startedRevision) ? settlement.startedRevision : ctx.revision,
      ctx.revision + 1,
    ),
    // `route` bumps exactly once after a successful apply.
    objectiveRevisionAfter: ctx.revision + 1,
    turnOutcome: settlement.outcome,
    criterionTransitions: current.successCriteria
      .filter((c) => c.met && !before.has(c.id))
      .map((c) => c.id),
    verifierReceiptRefs: passingVerifierRefs(current).filter((ref) => !refsBefore.has(ref)),
    ...(settlement.sourceDigest !== undefined ? { sourceDigest: settlement.sourceDigest } : {}),
    remainingCriterionIds: current.successCriteria.filter((c) => !c.met).map((c) => c.id),
    recordedAt: settlement.recordedAt,
  })
}

const settleAttempt = (
  core: ObjectiveCore,
  threadId: string,
  settlement: ObjectiveAttemptSettlement,
  ctx: MutationContext,
): ApplyOutcome => {
  if (ctx.actor !== "system") return refused(core, threadId, "actor-forbidden")
  const current = core.get(threadId)
  if (current === null) return refused(core, threadId, "objective-missing")
  const rejection = settlementRejection(current, settlement, ctx)
  if (rejection !== undefined) return refused(core, threadId, rejection)
  const receipt = buildSettlementReceipt(current, settlement, ctx)
  if (receipt === null) return refused(core, threadId, "invalid")
  // GOAL-04 — the turn was already reserved at `beginAttempt`, so settlement
  // never re-debits it; a legacy (unreserved) settlement still debits one turn.
  const started = current.attempts.started
  const usage = core.applyUsage(threadId, {
    tokens: settlement.tokensUsed,
    turns: started === undefined && settlement.turnsUsed === 1 ? 1 : 0,
  })
  if (usage === null) return refused(core, threadId, "invalid")
  const result = started === undefined ? usage : (core.clearStartedAttempt(threadId) ?? usage)
  ctx.evidence.append(receipt)
  return { applied: true, result }
}

/** GOAL-03 — validate a whole batch against the live objective BEFORE anything
 *  is touched (all-or-nothing). Returns the per-criterion pass plan or a code. */
const planVerificationBatch = (
  current: Objective,
  batch: VerificationBatch,
  revision: number,
): { criterionId: string; passed: boolean; exitCode: number | null }[] | CommitRejection => {
  if (batch === null || typeof batch !== "object" || !Array.isArray(batch.results)) return "invalid"
  if (batch.objectiveId !== current.objectiveId) return "objective-mismatch"
  if (batch.expectedRevision !== revision) return "stale"
  if (!isNonEmptyString(batch.sourceDigest) || batch.results.length > MAX_CHECKS_PER_BATCH) {
    return "invalid"
  }
  const plan: { criterionId: string; passed: boolean; exitCode: number | null }[] = []
  for (const r of batch.results) {
    const c = current.successCriteria.find((x) => x.id === r.criterionId)
    if (c === undefined || c.kind !== "checked" || c.check.id !== r.checkId) return "invalid"
    plan.push({ criterionId: c.id, passed: checkPassed(c.check, r), exitCode: r.exitCode })
  }
  return plan
}

/** GOAL-03 — the verifier's batch commit. The authority re-validates EVERY
 *  identity (generation, revision, criterion, check) and RECOMPUTES `passed`
 *  from the immutable `successExitCodes`; a supplied verdict is never trusted. */
const applyVerificationBatch = (
  core: ObjectiveCore,
  threadId: string,
  batch: VerificationBatch,
  ctx: MutationContext,
): ApplyOutcome => {
  if (ctx.actor !== "verifier") return refused(core, threadId, "actor-forbidden")
  const current = core.get(threadId)
  if (current === null) return refused(core, threadId, "objective-missing")
  const plan = planVerificationBatch(current, batch, ctx.revision)
  if (typeof plan === "string") return refused(core, threadId, plan)
  let result: Objective | null = current
  for (const { criterionId, passed, exitCode } of plan) {
    const c = current.successCriteria.find((x) => x.id === criterionId)
    if (c === undefined || c.kind !== "checked") continue
    result = passed
      ? (core.applyVerifierCompletion(threadId, criterionId, {
          source: "verifier",
          objectiveId: current.objectiveId,
          checkId: c.check.id,
          objectiveRevision: ctx.revision,
          sourceDigest: batch.sourceDigest,
          verifierResult: { exitCode: exitCode ?? -1, passed: true },
          verifiedAt: Number.isFinite(batch.verifiedAt) ? batch.verifiedAt : ctx.now,
        }) ?? result)
      : (core.resetCheckedCriterion(threadId, criterionId) ?? result)
  }
  return { applied: true, result }
}

const DISPATCH: DispatchTable = {
  create: mintGeneration,
  replace: mintGeneration,
  clear: (core, threadId) =>
    core.get(threadId) === null
      ? refused(core, threadId, "objective-missing")
      : { applied: core.clear(threadId), result: null },
  setExplicitStatus: (core, threadId, m) =>
    m.status === "active" || m.status === "paused"
      ? applied(core.setExplicitStatus(threadId, m.status))
      : refused(core, threadId, "invalid"),
  addBlocker: (core, threadId, m) =>
    applied(core.addBlocker(threadId, { reason: m.reason, waitingOn: m.waitingOn })),
  clearBlocker: (core, threadId, m) => applied(core.clearBlocker(threadId, m.blockerId)),
  setNextActions: (core, threadId, m) => applied(core.setNextActions(threadId, m.actions)),
  // RFC-03 C4 — the MANUAL/provenance completion path. A CHECKED criterion is
  // verifier-only (structural, gate-independent) ⇒ refused; a MANUAL criterion
  // is completed with an AUTHORITY-minted receipt (actor + generation + revision
  // + clock from ctx — never the payload). A missing criterion ⇒ invalid.
  markCriterion: (core, threadId, m, ctx) => {
    const current = core.get(threadId)
    const c = core.getCriterion(threadId, m.criterionId)
    if (current === null || c === null) return { applied: false, result: current }
    if (c.kind === "checked") return refused(core, threadId, "checked-verifier-only")
    const receipt: ManualCompletionReceipt | null =
      m.met === true
        ? {
            source: "manual",
            objectiveId: current.objectiveId,
            actor: ctx.actor,
            objectiveRevision: ctx.revision,
            verifiedAt: ctx.now,
          }
        : null
    return applied(core.applyManualCompletion(threadId, m.criterionId, m.met, receipt))
  },
  // RFC-03 C4 — the VERIFIER-ONLY checked completion. Admitted ONLY for a
  // `verifier` actor against a CHECKED criterion whose declared `check.id`
  // matches the receipt, for the LIVE generation, at the current revision, with
  // a well-formed PASSING result. No tool input schema produces this kind.
  markCriterionVerified: (core, threadId, m, ctx) => {
    if (ctx.actor !== "verifier") return refused(core, threadId, "forbidden-completion")
    const current = core.get(threadId)
    const c = core.getCriterion(threadId, m.criterionId)
    if (current === null || c === null || c.kind !== "checked")
      return refused(core, threadId, "invalid")
    if (!isVerifierReceipt(m.receipt)) return refused(core, threadId, "invalid")
    if (m.receipt.objectiveId !== current.objectiveId)
      return refused(core, threadId, "objective-mismatch")
    if (m.receipt.objectiveRevision !== ctx.revision) return refused(core, threadId, "stale")
    const result = core.applyVerifierCompletion(threadId, m.criterionId, m.receipt)
    return result !== null ? { applied: true, result } : refused(core, threadId, "invalid")
  },
  amendBudget: (core, threadId, m) => applied(core.amendBudget(threadId, m.budget)),
  beginAttempt: (core, threadId, m, ctx) => {
    if (ctx.actor !== "system") return refused(core, threadId, "actor-forbidden")
    const current = core.get(threadId)
    if (current === null) return refused(core, threadId, "objective-missing")
    if (
      m.attempt === null ||
      typeof m.attempt !== "object" ||
      !isNonEmptyString(m.attempt.attemptId)
    ) {
      return refused(core, threadId, "invalid")
    }
    if (m.attempt.objectiveId !== current.objectiveId)
      return refused(core, threadId, "objective-mismatch")
    if (current.attempts.started !== undefined) return refused(core, threadId, "attempt-in-flight")
    if (ctx.evidence.receipts.some((r) => r.attemptKey === m.attempt.attemptId)) {
      return refused(core, threadId, "attempt-replayed")
    }
    // GOAL-06 — the AUTHORITY rechecks both counters atomically before the
    // slot is consumed (the controller's precheck is advisory). A user-requested
    // attempt consumes no product-cap turn, so only the user budget bounds it.
    const allowance = autonomousAllowance({
      userMaxTurns: current.budget.maxTurns,
      turnsUsed: current.budget.turnsUsed,
      autonomousTurnsStarted: current.attempts.autonomousTurnsStarted,
      productCap: ctx.productAutonomousTurnCap,
    })
    if (m.attempt.provenance === "autonomous-continuation" && !allowance.allowed) {
      return refused(
        core,
        threadId,
        allowance.limitingSource === "product-hard-cap" ? "hard-cap-exhausted" : "budget-exhausted",
      )
    }
    if (m.attempt.provenance === "user-requested-goal-work" && allowance.userRemaining <= 0) {
      return refused(core, threadId, "budget-exhausted")
    }
    return applied(
      core.startAttempt(threadId, {
        attemptId: m.attempt.attemptId,
        provenance: m.attempt.provenance,
        executionMode: m.attempt.executionMode,
        startedRevision: Number.isSafeInteger(m.attempt.startedRevision)
          ? m.attempt.startedRevision
          : ctx.revision,
        startedAt: ctx.now,
      }),
    )
  },
  abandonAttempt: (core, threadId, m) => {
    const current = core.get(threadId)
    if (current === null) return refused(core, threadId, "objective-missing")
    const started = current.attempts.started
    if (started === undefined) return { applied: false, result: current }
    if (m.attemptId !== undefined && m.attemptId !== started.attemptId) {
      return refused(core, threadId, "attempt-replayed")
    }
    return applied(core.clearStartedAttempt(threadId))
  },
  applyVerificationBatch: (core, threadId, m, ctx) =>
    applyVerificationBatch(core, threadId, m.batch, ctx),
  invalidateVerification: (core, threadId, m, ctx) => {
    if (ctx.actor !== "verifier") return refused(core, threadId, "actor-forbidden")
    const current = core.get(threadId)
    if (current === null) return refused(core, threadId, "objective-missing")
    if (m.objectiveId !== current.objectiveId) return refused(core, threadId, "objective-mismatch")
    const wanted = new Set(m.checkIds)
    let result: Objective | null = current
    let touched = false
    for (const c of current.successCriteria) {
      if (c.kind === "checked" && wanted.has(c.check.id) && c.met) {
        result = core.resetCheckedCriterion(threadId, c.id) ?? result
        touched = true
      }
    }
    // Nothing to invalidate is a no-op (no revision bump), not a refusal.
    return { applied: touched, result }
  },
  settleAttempt: (core, threadId, m, ctx) => settleAttempt(core, threadId, m.settlement, ctx),
  markUsageLimited: (core, threadId, m) => applied(core.markUsageLimited(threadId, m.untilEpochMs)),
  restore: (core, threadId, m) => {
    const ok = core.restoreThread(threadId, m.snapshot.state)
    return { applied: ok, result: core.get(threadId) }
  },
}

/** The runtime dispatch keys — the exhaustive set of routed operation kinds.
 *  The mutation-completeness ratchet asserts this equals the closed union floor,
 *  so an unrouted (or removed) operation is caught. */
export const objectiveMutationDispatchKeys = (): readonly ObjectiveOperationKind[] =>
  Object.keys(DISPATCH) as ObjectiveOperationKind[]

const applyMutation = (
  core: ObjectiveCore,
  threadId: string,
  m: ObjectiveMutation,
  ctx: MutationContext,
): ApplyOutcome => {
  const handler = DISPATCH[m?.kind as ObjectiveOperationKind] as
    | HandlerFor<ObjectiveOperationKind>
    | undefined
  if (handler === undefined) return refused(core, threadId, "invalid")
  return handler(core, threadId, m as never, ctx)
}

/** GOAL-02 — resolve the policy verdict for a bound command into a commit
 *  rejection (or `null` to proceed to CAS). `approval` needs an admitted receipt
 *  AND a confirmation-capable surface (fail-closed, never a bypass). */
const policyRejection = (
  prior: ObjectiveDomainSnapshot,
  command: ObjectiveMutationCommand,
  approval: ApprovalReceipt,
  gateOn: boolean,
  confirmationAvailable: boolean,
): CommitRejection | null => {
  const verdict = authorizeMutation(prior, command, gateOn)
  if (verdict.verdict === "deny") return verdict.reason
  if (verdict.verdict === "allow") return null
  if (!confirmationAvailable) return "approval-unavailable"
  if (approval.admitted !== true) return "approval-required"
  return null
}

export const createObjectiveAuthority = (opts?: ObjectiveAuthorityOptions): ObjectiveAuthority =>
  createObjectiveAuthorityWithCore(
    createObjectiveCoreStore({
      ...(opts?.now !== undefined ? { now: opts.now } : {}),
      ...(opts?.idFactory !== undefined ? { idFactory: opts.idFactory } : {}),
      ...(opts?.enforceBudget !== undefined ? { enforceBudget: opts.enforceBudget } : {}),
      ...(opts?.productAutonomousTurnCap !== undefined
        ? { productAutonomousTurnCap: opts.productAutonomousTurnCap }
        : {}),
    }),
    opts,
  )

/**
 * PUBLIC objective store constructor — now an authority. Returned typed as the
 * `ObjectivePort` (system capability) so every existing production consumer
 * gets the revisioned authority WITHOUT a call-site change: their mutations
 * route through CAS and the actor is `system`. The richer `ObjectiveAuthority`
 * surface is recovered by the composition root via {@link asObjectiveAuthority}.
 */
export const createObjectiveStore = (opts?: {
  now?: () => number
  idFactory?: () => string
  enforceBudget?: boolean
}): ObjectivePort =>
  createObjectiveAuthority({
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
    ...(opts?.idFactory !== undefined ? { idFactory: opts.idFactory } : {}),
    ...(opts?.enforceBudget !== undefined ? { enforceBudget: opts.enforceBudget } : {}),
  })

/** True when a port is the revisioned authority (has the `prepare` protocol). */
export const isObjectiveAuthority = (port: ObjectivePort): port is ObjectiveAuthority =>
  typeof (port as Partial<ObjectiveAuthority>).prepare === "function" &&
  typeof (port as Partial<ObjectiveAuthority>).commit === "function"

/**
 * Recover the {@link ObjectiveAuthority} from an injected `ObjectivePort`. In
 * production the port IS the authority ({@link createObjectiveStore}); a bare
 * test double is wrapped so the caller always gets the revisioned protocol
 * without a second live authority contending for the SAME core (the wrapper's
 * core is the double itself).
 */
export const asObjectiveAuthority = (
  port: ObjectivePort,
  opts?: ObjectiveAuthorityOptions,
): ObjectiveAuthority => {
  if (isObjectiveAuthority(port)) return port
  return wrapPortAsAuthority(port, opts)
}

const wrapPortAsAuthority = (
  port: ObjectivePort,
  opts?: ObjectiveAuthorityOptions,
): ObjectiveAuthority =>
  createObjectiveAuthorityWithCore(isObjectiveCore(port) ? port : coreFromPort(port), opts)

const isObjectiveCore = (port: ObjectivePort): port is ObjectiveCore =>
  typeof (port as Partial<ObjectiveCore>).snapshotThread === "function" &&
  typeof (port as Partial<ObjectiveCore>).restoreThread === "function"

/** Adapt a bare `ObjectivePort` to `ObjectiveCore` via the public surface so the
 *  authority protocol still works over a foreign port (test doubles). The port's
 *  methods are closure-bound (objective ports are object literals, not classes)
 *  so a spread preserves them; a partial double keeps whatever it defined. */
const coreFromPort = (port: ObjectivePort): ObjectiveCore => ({
  ...port,
  snapshotThread(threadId) {
    const o = port.get(threadId)
    if (o === null) return null
    return Object.freeze({
      objective: o,
      explicitStatus: o.status === "paused" ? ("paused" as const) : ("active" as const),
    })
  },
  restoreThread(threadId, state) {
    if (state === null) return port.clear(threadId)
    const o = state.objective
    const definition: GoalDefinition = {
      goal: o.goal,
      successCriteria: o.successCriteria.map((c) => c.text),
    }
    return (
      (port.get(threadId) === null
        ? port.create(threadId, definition)
        : port.replace(threadId, definition)) !== null
    )
  },
  getCriterion(threadId, criterionId) {
    const c = port.get(threadId)?.successCriteria.find((x) => x.id === criterionId)
    if (c === undefined) return null
    return { kind: c.kind, met: c.met, checkId: c.kind === "checked" ? c.check.id : null }
  },
  applyManualCompletion(threadId, criterionId, met) {
    return port.markCriterion(threadId, criterionId, met)
  },
  applyVerifierCompletion(threadId, criterionId, receipt) {
    const c = port.get(threadId)?.successCriteria.find((x) => x.id === criterionId)
    if (c === undefined || c.kind !== "checked" || receipt.checkId !== c.check.id) return null
    if (receipt.verifierResult.passed !== true) return null
    return port.markCriterion(threadId, criterionId, true)
  },
  applyUsage(threadId) {
    // A bare foreign port has no usage substrate; report the unchanged objective.
    return port.get(threadId)
  },
  resetCheckedCriterion(threadId) {
    // A bare foreign port cannot un-complete a checked criterion; report unchanged.
    return port.get(threadId)
  },
  startAttempt(threadId) {
    // No attempt substrate on a bare foreign port; report unchanged.
    return port.get(threadId)
  },
  clearStartedAttempt(threadId) {
    return port.get(threadId)
  },
})

/** RFC-03 C2 — restore-at-construction. Load each persisted per-thread domain
 *  snapshot verbatim into the core and restore its EXACT revision (NOT the
 *  `fromSnapshot` reset-to-1). A `state: null` entry with a positive revision is
 *  a TOMBSTONE: only the revision is planted. Malformed entries are skipped. */
const hydrateDomains = (
  core: ObjectiveCore,
  revisions: Map<string, number>,
  domains: readonly ObjectiveDomainSnapshot[] | undefined,
): void => {
  if (domains === undefined) return
  for (const dom of domains) plantDomain(core, revisions, dom)
}

const plantDomain = (
  core: ObjectiveCore,
  revisions: Map<string, number>,
  dom: ObjectiveDomainSnapshot,
): boolean => {
  const threadId = isNonEmptyString(dom?.threadId) ? dom.threadId : ""
  if (threadId === "") return false
  const revision = Number.isFinite(dom.revision) && dom.revision >= 0 ? dom.revision : 1
  if (dom.state === null) {
    if (revision <= 0) return false
    core.clear(threadId)
    revisions.set(threadId, revision)
    return true
  }
  if (!core.restoreThread(threadId, dom.state)) return false
  revisions.set(threadId, revision)
  return true
}

const normalizeProgressReceipts = (
  receipts: readonly ProgressReceipt[] | undefined,
): readonly ProgressReceipt[] =>
  Object.freeze(
    (receipts ?? [])
      .map(normalizeProgressReceipt)
      .filter((receipt): receipt is ProgressReceipt => receipt !== null)
      .slice(-MAX_PROGRESS_RECEIPTS),
  )

/** GOAL-01 — only receipts bound to the live generation survive a hydrate. */
const receiptsForGeneration = (
  core: ObjectiveCore,
  threadId: string,
  receipts: readonly ProgressReceipt[] | undefined,
): readonly ProgressReceipt[] => {
  const live = core.get(threadId)?.objectiveId
  return Object.freeze(normalizeProgressReceipts(receipts).filter((r) => r.objectiveId === live))
}

const hydrateProgressReceipts = (
  core: ObjectiveCore,
  progress: Map<string, readonly ProgressReceipt[]>,
  domains: readonly ObjectiveDomainSnapshot[] | undefined,
): void => {
  for (const domain of domains ?? []) {
    if (isNonEmptyString(domain.threadId) && domain.progressReceipts !== undefined) {
      progress.set(
        domain.threadId,
        receiptsForGeneration(core, domain.threadId, domain.progressReceipts),
      )
    }
  }
}

const safeClockNow = (now: () => number): number => {
  try {
    const value = now()
    return Number.isFinite(value) ? value : Date.now()
  } catch (e) {
    logger.warn(`objective.authority.clockNow: ${errMessage(e)}`)
    return Date.now()
  }
}

interface AuthoritySurfaceDeps {
  readonly core: ObjectiveCore
  readonly revisions: Map<string, number>
  readonly progress: Map<string, readonly ProgressReceipt[]>
  readonly revisionOf: (threadId: string) => number
  readonly readDomain: (threadId: string) => ObjectiveDomainSnapshot
  readonly prepare: ObjectiveAuthority["prepare"]
  readonly commit: ObjectiveAuthority["commit"]
  readonly restore: ObjectiveAuthority["restore"]
  readonly restoreDomain: ObjectiveAuthority["restoreDomain"]
  readonly system: (threadId: string, mutation: ObjectiveMutation) => Objective | null
}

const createAuthoritySurface = (deps: AuthoritySurfaceDeps): ObjectiveAuthority => ({
  readDomain: deps.readDomain,
  prepare: deps.prepare,
  commit: deps.commit,
  restore: deps.restore,
  restoreDomain: deps.restoreDomain,
  knownThreadIds: () =>
    Object.freeze([
      ...new Set([...deps.revisions.keys(), ...deps.core.list().map((o) => o.threadId)]),
    ]),
  recordProgressReceipt: (threadId, receipt): boolean => {
    if (!isNonEmptyString(threadId)) return false
    const live = deps.core.get(threadId)
    if (live === null) return false
    const normalized = normalizeProgressReceipt(receipt)
    if (normalized === null) return false
    if (normalized.objectiveId !== live.objectiveId) return false
    if (normalized.objectiveRevisionAfter !== deps.revisionOf(threadId)) return false
    const existing = deps.progress.get(threadId) ?? []
    if (existing.some((item) => item.attemptKey === normalized.attemptKey)) return false
    deps.progress.set(threadId, appendProgressReceipt(existing, normalized))
    return true
  },
  create: (threadId, definition) => deps.system(threadId, { kind: "create", definition }),
  replace: (threadId, definition) => deps.system(threadId, { kind: "replace", definition }),
  clear: (threadId) => {
    const had = deps.core.get(threadId) !== null
    deps.system(threadId, { kind: "clear" })
    return had && deps.core.get(threadId) === null
  },
  get: (threadId) => deps.core.get(threadId),
  setExplicitStatus: (threadId, status) =>
    deps.system(threadId, { kind: "setExplicitStatus", status }),
  amendBudget: (threadId, budget) => deps.system(threadId, { kind: "amendBudget", budget }),
  addBlocker: (threadId, blocker) =>
    deps.system(threadId, {
      kind: "addBlocker",
      reason: blocker?.reason,
      waitingOn: blocker?.waitingOn,
    }),
  clearBlocker: (threadId, blockerId) => deps.system(threadId, { kind: "clearBlocker", blockerId }),
  setNextActions: (threadId, actions) => deps.system(threadId, { kind: "setNextActions", actions }),
  markCriterion: (threadId, criterionId, met) =>
    deps.system(threadId, { kind: "markCriterion", criterionId, met }),
  markUsageLimited: (threadId, untilEpochMs) =>
    deps.system(threadId, { kind: "markUsageLimited", untilEpochMs }),
  list: () => deps.core.list(),
  toSnapshot: () => deps.core.toSnapshot(),
  fromSnapshot: (snap) => {
    deps.core.fromSnapshot(snap)
    deps.revisions.clear()
    // GOAL-01 — a whole-store replacement carries NO evidence forward: every
    // previous thread's receipts are dropped (they belong to generations that no
    // longer exist here), never projected into a judge/renderer context.
    deps.progress.clear()
    for (const objective of deps.core.list()) deps.revisions.set(objective.threadId, 1)
  },
})

/** Factory variant that adopts an existing core (rather than minting one). */
const createObjectiveAuthorityWithCore = (
  core: ObjectiveCore,
  opts?: ObjectiveAuthorityOptions,
): ObjectiveAuthority => {
  const gateOn = opts?.gateOn === true
  const confirmationAvailable = opts?.confirmationAvailable !== false
  const nowFn = opts?.now ?? Date.now
  const mintId = opts?.idFactory ?? defaultObjectiveIdFactory
  const productAutonomousTurnCap = resolveProductAutonomousTurnCap(opts?.productAutonomousTurnCap)
  const revisions = new Map<string, number>()
  const progress = new Map<string, readonly ProgressReceipt[]>()
  const revisionOf = (threadId: string): number => revisions.get(threadId) ?? 0
  const bump = (threadId: string): number => {
    const next = revisionOf(threadId) + 1
    revisions.set(threadId, next)
    return next
  }
  // RFC-03 C2 — restore-at-construction (durable resume): load each persisted
  // per-thread snapshot verbatim + its EXACT revision (tombstones included).
  hydrateDomains(core, revisions, opts?.restoreDomains)
  hydrateProgressReceipts(core, progress, opts?.restoreDomains)
  const readDomain = (threadId: string): ObjectiveDomainSnapshot => ({
    threadId: isNonEmptyString(threadId) ? threadId : "",
    revision: revisionOf(threadId),
    state: isNonEmptyString(threadId) ? core.snapshotThread(threadId) : null,
    progressReceipts: isNonEmptyString(threadId) ? (progress.get(threadId) ?? []) : [],
    ...contractOf(isNonEmptyString(threadId) ? core.get(threadId) : null),
  })
  const route = (
    threadId: string,
    mutation: ObjectiveMutation,
    actor: ObjectiveActor,
  ): ApplyOutcome => {
    const evidence: EvidenceContext = {
      receipts: progress.get(threadId) ?? [],
      append: (receipt) =>
        progress.set(threadId, appendProgressReceipt(progress.get(threadId) ?? [], receipt)),
    }
    const ctx: MutationContext = {
      actor,
      revision: revisionOf(threadId),
      now: safeClockNow(nowFn),
      mintId,
      evidence,
      productAutonomousTurnCap,
    }
    const outcome = applyMutation(core, threadId, mutation, ctx)
    if (outcome.applied) {
      // A generation boundary (create / replace / clear) drops every evidence
      // family: old receipts must never be projected into a new goal's context.
      if (isGenerationMutationKind(mutation.kind)) progress.delete(threadId)
      bump(threadId)
    }
    return outcome
  }
  // The `ObjectivePort` surface commits as a trusted `system` actor. A REFUSED
  // mutation (a typed rejection) reports `null` — never the untouched current
  // objective, which would read as success. A plain no-op with no rejection
  // (e.g. marking an unknown criterion id) still returns the unchanged objective,
  // the historical port contract.
  const system = (threadId: string, mutation: ObjectiveMutation): Objective | null => {
    const outcome = route(threadId, mutation, "system")
    return outcome.applied || outcome.rejection === undefined ? outcome.result : null
  }
  const prepare = (command: ObjectiveMutationCommand): PreparedObjectiveMutation => {
    const threadId = isNonEmptyString(command.threadId) ? command.threadId : ""
    return {
      command,
      expectedRevision: command.expectedRevision ?? revisionOf(threadId),
      prior: readDomain(threadId),
      approvalRequired:
        authorizeMutation(readDomain(threadId), command, gateOn).verdict === "approval",
    }
  }
  const commit = (prepared: PreparedObjectiveMutation, approval: ApprovalReceipt): CommitResult => {
    const command = prepared.command
    const threadId = isNonEmptyString(command.threadId) ? command.threadId : ""
    if (threadId === "") return { ok: false, reason: "invalid", currentRevision: 0 }
    const current = revisionOf(threadId)
    // CAS — the domain must still be at the prepared revision.
    if (current !== prepared.expectedRevision) {
      return { ok: false, reason: "stale", currentRevision: current }
    }
    // GOAL-02 — policy runs AFTER CAS: a writer that lost the race sees `stale`
    // (it must re-read), a current writer sees the policy verdict.
    const rejected = policyRejection(
      readDomain(threadId),
      command,
      approval,
      gateOn,
      confirmationAvailable,
    )
    if (rejected !== null) return { ok: false, reason: rejected, currentRevision: current }
    const outcome = route(threadId, command.mutation, command.actor)
    if (!outcome.applied) {
      return { ok: false, reason: outcome.rejection ?? "invalid", currentRevision: current }
    }
    return { ok: true, revision: revisionOf(threadId), snapshot: readDomain(threadId) }
  }
  const restore = (previous: ObjectiveDomainSnapshot, expectedRevision: number): CommitResult => {
    const threadId = isNonEmptyString(previous?.threadId) ? previous.threadId : ""
    if (threadId === "") return { ok: false, reason: "invalid", currentRevision: 0 }
    const current = revisionOf(threadId)
    if (current !== expectedRevision)
      return { ok: false, reason: "stale", currentRevision: current }
    if (!core.restoreThread(threadId, previous.state)) {
      return { ok: false, reason: "invalid", currentRevision: current }
    }
    if (previous.progressReceipts === undefined) progress.delete(threadId)
    else progress.set(threadId, receiptsForGeneration(core, threadId, previous.progressReceipts))
    bump(threadId)
    return { ok: true, revision: revisionOf(threadId), snapshot: readDomain(threadId) }
  }
  // RFC-03 C2 (web parity) — LIVE post-construction durable-resume load of ONE
  // per-thread snapshot. Plants the state verbatim (or a tombstone) and pins the
  // EXACT persisted revision; no bump, no CAS.
  const restoreDomain = (snapshot: ObjectiveDomainSnapshot): boolean => {
    if (!plantDomain(core, revisions, snapshot)) return false
    progress.set(
      snapshot.threadId,
      receiptsForGeneration(core, snapshot.threadId, snapshot.progressReceipts),
    )
    return true
  }
  return createAuthoritySurface({
    core,
    revisions,
    progress,
    revisionOf,
    readDomain,
    prepare,
    commit,
    restore,
    restoreDomain,
    system,
  })
}
