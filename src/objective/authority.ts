/**
 * RFC-03 C1 — the revisioned objective mutation AUTHORITY.
 *
 * The single writer of the objective domain. It wraps the raw core store
 * (`./store`) and adds:
 *
 *   - a per-thread monotonic REVISION,
 *   - the closed `ObjectiveMutation` union routed through ONE exhaustive dispatch
 *     table (adding a variant without a handler fails compile; deleting a live
 *     handler makes the mutation-completeness ratchet RED),
 *   - `prepare` / `commit` with compare-and-swap so two writers that prepared at
 *     the same revision cannot both apply — exactly one commits, the other is
 *     `stale` (and never clobbers the winner),
 *   - `restore(prior, expectedRevision)` for EXACT undo under CAS,
 *   - ACTOR/THREAD binding: thread identity and actor come from the CALLER, never
 *     model input (RFC-03 §8), and a MODEL actor may NOT complete a criterion —
 *     the authority owns completion.
 *
 * The legacy `ObjectivePort` surface is preserved so EVERY existing caller
 * (objective tools, approval-state-machine attribution, `/goal`, continuation,
 * usage-limit wire) routes through the authority unchanged — no direct store
 * call remains. Those surface mutators commit as a trusted `system` actor.
 *
 * GATE-OFF (`gateOn:false`, the default) is byte-identical to the historical
 * store: model mutations commit without approval, a model may self-mark criteria,
 * and the revision is invisible to the public `Objective` projection.
 *
 * SLICE FENCE: imports ONLY sibling modules + is a pure leaf (no `@/agent` etc.).
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { ObjectiveDomainSnapshot } from "./model"
import type { ObjectiveMutation, ObjectiveOperationKind } from "./mutations"
import type {
  ApprovalReceipt,
  CommitResult,
  ObjectiveAuthority,
  ObjectiveAuthorityOptions,
  ObjectiveMutationCommand,
  PreparedObjectiveMutation,
} from "./ports"
import { createObjectiveCoreStore, type ObjectiveCore } from "./store"
import type { Objective, ObjectivePort } from "./types"

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

/** Outcome of applying one mutation to the core. `applied:false` ⇒ the op did
 *  not take effect (unknown thread for a non-`set` op, malformed input) so the
 *  revision must NOT advance; `result` is the core's byte-identical return. */
interface ApplyOutcome {
  readonly applied: boolean
  readonly result: Objective | null
}

type HandlerFor<K extends ObjectiveOperationKind> = (
  core: ObjectiveCore,
  threadId: string,
  m: Extract<ObjectiveMutation, { kind: K }>,
) => ApplyOutcome

/** The ONE exhaustive dispatch table. `{ [K in ObjectiveOperationKind]: … }`
 *  makes a new union variant a COMPILE error until it is routed here; deleting a
 *  handler removes the op's effect and the ratchet catches it. */
type DispatchTable = { [K in ObjectiveOperationKind]: HandlerFor<K> }

const applied = (result: Objective | null): ApplyOutcome => ({ applied: result !== null, result })

const DISPATCH: DispatchTable = {
  set: (core, threadId, m) => {
    const init: {
      goal: string
      successCriteria?: readonly string[]
      budget?: { maxTokens?: number; maxTurns?: number }
    } = { goal: m.goal }
    if (m.successCriteria !== undefined) init.successCriteria = m.successCriteria
    if (m.budget !== undefined) {
      const budget: { maxTokens?: number; maxTurns?: number } = {}
      if (m.budget.maxTokens !== undefined) budget.maxTokens = m.budget.maxTokens
      if (m.budget.maxTurns !== undefined) budget.maxTurns = m.budget.maxTurns
      if (Object.keys(budget).length > 0) init.budget = budget
    }
    const result = core.set(threadId, init)
    // `set` creates unconditionally for a valid thread id; a malformed id returns
    // the synthetic contract objective WITHOUT storing (so it did not "apply").
    return { applied: isNonEmptyString(threadId), result }
  },
  updateStatus: (core, threadId, m) => applied(core.updateStatus(threadId, m.status)),
  addBlocker: (core, threadId, m) =>
    applied(core.addBlocker(threadId, { reason: m.reason, waitingOn: m.waitingOn })),
  clearBlocker: (core, threadId, m) => applied(core.clearBlocker(threadId, m.blockerId)),
  setNextActions: (core, threadId, m) => applied(core.setNextActions(threadId, m.actions)),
  markCriterion: (core, threadId, m) => applied(core.markCriterion(threadId, m.criterionId, m.met)),
  recordUsage: (core, threadId, m) => {
    const used: { tokens?: number; turns?: number } = {}
    if (m.tokens !== undefined) used.tokens = m.tokens
    if (m.turns !== undefined) used.turns = m.turns
    return applied(core.recordUsage(threadId, used))
  },
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

const applyMutation = (core: ObjectiveCore, threadId: string, m: ObjectiveMutation): ApplyOutcome =>
  (DISPATCH[m.kind] as HandlerFor<typeof m.kind>)(core, threadId, m as never)

/** Policy classification of a bound command against the gate posture. */
interface Policy {
  readonly approvalRequired: boolean
  /** A model actor attempting to COMPLETE a criterion — always refused. */
  readonly forbiddenCompletion: boolean
}

const classify = (command: ObjectiveMutationCommand, gateOn: boolean): Policy => {
  if (!gateOn || command.actor !== "model") {
    return { approvalRequired: false, forbiddenCompletion: false }
  }
  // Gate ON + model actor: every model mutation is mediated; completion is owned.
  const forbiddenCompletion =
    command.mutation.kind === "markCriterion" && command.mutation.met === true
  return { approvalRequired: true, forbiddenCompletion }
}

/** Resolve the policy verdict into a commit rejection reason, or `null` when the
 *  mutation may proceed to the CAS check. Extracted so `commit` stays under the
 *  cognitive-complexity cap (one linear gate, then CAS + apply). */
const policyRejection = (
  policy: Policy,
  approval: ApprovalReceipt,
  confirmationAvailable: boolean,
): "forbidden-completion" | "approval-unavailable" | "approval-required" | null => {
  if (policy.forbiddenCompletion) return "forbidden-completion" // authority owns completion
  if (!policy.approvalRequired) return null
  if (!confirmationAvailable) return "approval-unavailable" // fail-closed, no bypass
  if (approval.admitted !== true) return "approval-required"
  return null
}

export const createObjectiveAuthority = (opts?: ObjectiveAuthorityOptions): ObjectiveAuthority =>
  createObjectiveAuthorityWithCore(
    createObjectiveCoreStore({
      ...(opts?.now !== undefined ? { now: opts.now } : {}),
      ...(opts?.enforceBudget !== undefined ? { enforceBudget: opts.enforceBudget } : {}),
    }),
    opts,
  )

/**
 * PUBLIC objective store constructor — now an authority. Returned typed as the
 * legacy `ObjectivePort` so every existing production consumer
 * (`host/runtime/objective-store-wire`, CLI `core-state`, agent
 * `observability-wire`) gets the revisioned authority WITHOUT a call-site change:
 * their mutations route through CAS and the actor is `system`. The richer
 * `ObjectiveAuthority` surface is recovered by the tool composition root via
 * {@link asObjectiveAuthority}.
 */
export const createObjectiveStore = (opts?: {
  now?: () => number
  enforceBudget?: boolean
}): ObjectivePort =>
  createObjectiveAuthority({
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
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

/** Wrap a plain `ObjectivePort` (a non-authority double) in the authority
 *  protocol over that exact port, so tool composition can bind actor policy even
 *  when the host supplied a bespoke port. The wrapped port is the core; its own
 *  per-thread snapshot/restore is synthesized from `to/fromSnapshot` when the
 *  port does not implement {@link ObjectiveCore}. */
const wrapPortAsAuthority = (
  port: ObjectivePort,
  opts?: ObjectiveAuthorityOptions,
): ObjectiveAuthority =>
  createObjectiveAuthorityWithCore(isObjectiveCore(port) ? port : coreFromPort(port), opts)

const isObjectiveCore = (port: ObjectivePort): port is ObjectiveCore =>
  typeof (port as Partial<ObjectiveCore>).snapshotThread === "function" &&
  typeof (port as Partial<ObjectiveCore>).restoreThread === "function"

/** Adapt a bare `ObjectivePort` to `ObjectiveCore` via the whole-store codec so
 *  the authority's exact-restore still works over a foreign port. The port's
 *  methods are closure-bound (objective ports are object literals, not classes)
 *  so a spread preserves them; a partial test double keeps whatever it defined
 *  (a missing method throws only if actually invoked, caught by the caller). */
const coreFromPort = (port: ObjectivePort): ObjectiveCore => ({
  ...port,
  snapshotThread(threadId) {
    const o = port.get(threadId)
    if (o === null) return null
    const explicit =
      o.status === "paused" ? "paused" : o.status === "completed" ? "completed" : "active"
    return Object.freeze({
      objective: o,
      explicitStatus: explicit as "active" | "paused" | "completed",
    })
  },
  restoreThread(threadId, state) {
    if (state === null) {
      // A foreign port cannot delete a single thread through the public surface;
      // approximate by clearing the goal to an empty objective.
      port.set(threadId, { goal: "" })
      return true
    }
    const o = state.objective
    port.set(threadId, {
      goal: o.goal,
      successCriteria: o.successCriteria.map((c) => c.text),
    })
    return true
  },
})

/** Factory variant that adopts an existing core (rather than minting one). */
const createObjectiveAuthorityWithCore = (
  core: ObjectiveCore,
  opts?: ObjectiveAuthorityOptions,
): ObjectiveAuthority => {
  const gateOn = opts?.gateOn === true
  const confirmationAvailable = opts?.confirmationAvailable !== false
  const revisions = new Map<string, number>()
  const revisionOf = (threadId: string): number => revisions.get(threadId) ?? 0
  const bump = (threadId: string): number => {
    const next = revisionOf(threadId) + 1
    revisions.set(threadId, next)
    return next
  }
  const readDomain = (threadId: string): ObjectiveDomainSnapshot => ({
    threadId: isNonEmptyString(threadId) ? threadId : "",
    revision: revisionOf(threadId),
    state: isNonEmptyString(threadId) ? core.snapshotThread(threadId) : null,
  })
  const route = (threadId: string, mutation: ObjectiveMutation): ApplyOutcome => {
    const outcome = applyMutation(core, threadId, mutation)
    if (outcome.applied) bump(threadId)
    return outcome
  }
  const system = (threadId: string, mutation: ObjectiveMutation): Objective | null =>
    route(threadId, mutation).result
  const prepare = (command: ObjectiveMutationCommand): PreparedObjectiveMutation => {
    const threadId = isNonEmptyString(command.threadId) ? command.threadId : ""
    return {
      command,
      expectedRevision: command.expectedRevision ?? revisionOf(threadId),
      prior: readDomain(threadId),
      approvalRequired: classify(command, gateOn).approvalRequired,
    }
  }
  const commit = (prepared: PreparedObjectiveMutation, approval: ApprovalReceipt): CommitResult => {
    const command = prepared.command
    const threadId = isNonEmptyString(command.threadId) ? command.threadId : ""
    if (threadId === "") return { ok: false, reason: "invalid", currentRevision: 0 }
    const current = revisionOf(threadId)
    const rejected = policyRejection(classify(command, gateOn), approval, confirmationAvailable)
    if (rejected !== null) return { ok: false, reason: rejected, currentRevision: current }
    // CAS — the domain must still be at the prepared revision.
    if (current !== prepared.expectedRevision) {
      return { ok: false, reason: "stale", currentRevision: current }
    }
    const outcome = route(threadId, command.mutation)
    if (!outcome.applied) return { ok: false, reason: "invalid", currentRevision: current }
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
    bump(threadId)
    return { ok: true, revision: revisionOf(threadId), snapshot: readDomain(threadId) }
  }
  return {
    readDomain,
    prepare,
    commit,
    restore,
    set: (threadId, init) =>
      (system(threadId, {
        kind: "set",
        goal: init?.goal,
        ...(init?.successCriteria !== undefined ? { successCriteria: init.successCriteria } : {}),
        ...(init?.budget !== undefined ? { budget: init.budget } : {}),
      }) ?? core.get(threadId)) as Objective,
    get: (threadId) => core.get(threadId),
    updateStatus: (threadId, status) => system(threadId, { kind: "updateStatus", status }),
    addBlocker: (threadId, blocker) =>
      system(threadId, {
        kind: "addBlocker",
        reason: blocker?.reason,
        waitingOn: blocker?.waitingOn,
      }),
    clearBlocker: (threadId, blockerId) => system(threadId, { kind: "clearBlocker", blockerId }),
    setNextActions: (threadId, actions) => system(threadId, { kind: "setNextActions", actions }),
    markCriterion: (threadId, criterionId, met) =>
      system(threadId, { kind: "markCriterion", criterionId, met }),
    recordUsage: (threadId, used) =>
      system(threadId, {
        kind: "recordUsage",
        ...(used?.tokens !== undefined ? { tokens: used.tokens } : {}),
        ...(used?.turns !== undefined ? { turns: used.turns } : {}),
      }),
    markUsageLimited: (threadId, untilEpochMs) =>
      system(threadId, { kind: "markUsageLimited", untilEpochMs }),
    list: () => core.list(),
    toSnapshot: () => core.toSnapshot(),
    fromSnapshot: (snap) => {
      core.fromSnapshot(snap)
      revisions.clear()
      for (const o of core.list()) revisions.set(o.threadId, 1)
    },
  }
}
