import type {
  CriterionDeclaration,
  ObjectiveBudget,
  ObjectiveDomainSnapshot,
  ObjectiveFreshRead,
  ObjectivePort,
  ObjectiveStatus,
  ObjectiveVerificationPort,
  UserObjectiveMutation,
  VerificationOutcome,
} from "@/objective"
import {
  createObjectiveCapabilities,
  DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES,
  DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS,
  reconcileObjectiveRead,
} from "@/objective"
import { readCliKnob } from "../cli-knobs-accessor"
import type { SlashCommand } from "../slash-contract"
import { runGoalCommand } from "./goal-cmd"

export type GoalControlOutcome =
  | { readonly kind: "ok"; readonly domain: ObjectiveDomainSnapshot }
  | { readonly kind: "stale"; readonly domain: ObjectiveDomainSnapshot }
  | {
      readonly kind: "rejected"
      readonly reason: string
      readonly domain: ObjectiveDomainSnapshot
    }

export interface GoalControl {
  read(): ObjectiveDomainSnapshot
  reconcileAndRead(): Promise<ObjectiveFreshRead>
  create(goal: string): GoalControlOutcome
  replace(goal: string): GoalControlOutcome
  pause(): GoalControlOutcome
  resume(): GoalControlOutcome
  clear(): GoalControlOutcome
  addCriterion(text: string): GoalControlOutcome
  /** GOAL P0-2 — the operator's manual attestation. A MANUAL criterion has no
   *  other satisfier: the model's `met:true` is refused as
   *  `manual-attestation-required` and a checked criterion needs a verifier
   *  receipt, so without this a manual-only stopping contract can never be
   *  met and the goal pursues until its budget or hard cap runs out. */
  attestCriterion(selector: string): GoalControlOutcome
  /** GOAL P0-3 — release a DURABLE started attempt that never settled (a crash,
   *  or a settlement whose persistence failed). While one is held the authority
   *  refuses `replace`/`clear` with `attempt-in-flight`, so without this verb a
   *  stuck goal can never be edited or deleted. The reserved turn is NOT
   *  refunded: the turn really ran; this only frees the lock. */
  abandonAttempt(): GoalControlOutcome & { readonly hadAttempt: boolean }
  /** GOAL P0-B — clear every live blocker. `/goal resume` on a blocked goal
   *  tells the operator to "clear blocker first", and until this verb existed
   *  the CLI offered no way to do it: the mutation is user-allowed, but the only
   *  production caller was the approval state machine clearing its OWN id. */
  clearBlockers(): GoalControlOutcome & { readonly cleared: number }
  addCheck(text: string, argv: readonly string[]): GoalControlOutcome
  setBudget(budget: {
    maxTokens?: number | undefined
    maxTurns?: number | undefined
  }): GoalControlOutcome
  verify(): Promise<GoalControlOutcome & { readonly verification?: VerificationOutcome }>
  edit(goal: string): GoalControlOutcome
  setStatus(status: "active" | "paused"): GoalControlOutcome
}

const criterionDeclarations = (domain: ObjectiveDomainSnapshot): CriterionDeclaration[] =>
  (domain.state?.objective.successCriteria ?? []).map((criterion) =>
    criterion.kind === "checked"
      ? {
          text: criterion.text,
          check: {
            kind: "command",
            argv: criterion.check.argv,
            timeoutMs: criterion.check.timeoutMs,
            successExitCodes: criterion.check.successExitCodes,
          },
        }
      : { text: criterion.text },
  )

const budgetCaps = (budget: ObjectiveBudget): { maxTokens?: number; maxTurns?: number } => ({
  ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
  ...(budget.maxTurns !== undefined ? { maxTurns: budget.maxTurns } : {}),
})

export const buildGoalControl = (
  port: ObjectivePort,
  threadId: string,
  onMutation?: () => void,
  verifier?: ObjectiveVerificationPort,
  onInfrastructureUnavailable?: (objectiveRevision: number, observedAt: number) => void,
): GoalControl => {
  const capabilities = createObjectiveCapabilities(port)
  const read = (): ObjectiveDomainSnapshot => capabilities.read.readDomain(threadId)
  const commit = (mutation: UserObjectiveMutation): GoalControlOutcome => {
    const result = capabilities.user.commit(threadId, mutation)
    const domain = read()
    if (result.ok) {
      onMutation?.()
      return { kind: "ok", domain }
    }
    return result.reason === "stale"
      ? { kind: "stale", domain }
      : { kind: "rejected", reason: result.reason, domain }
  }
  const replaceWith = (criteria: readonly CriterionDeclaration[]): GoalControlOutcome => {
    const current = read().state?.objective
    if (current === undefined)
      return { kind: "rejected", reason: "objective-missing", domain: read() }
    return commit({
      kind: "replace",
      definition: {
        goal: current.goal,
        criteria,
        budget: budgetCaps(current.budget),
      },
    })
  }
  const setStatus = (status: "active" | "paused"): GoalControlOutcome =>
    commit({ kind: "setExplicitStatus", status })
  return {
    read,
    reconcileAndRead: async () => {
      const before = read().revision
      const result = await reconcileObjectiveRead(capabilities.read, verifier, threadId)
      if (result.freshness.kind === "invalidated" && result.domain.revision !== before) {
        onMutation?.()
      }
      return result
    },
    create: (goal) => commit({ kind: "create", definition: { goal } }),
    replace: (goal) => {
      const current = read().state?.objective
      return commit({
        kind: "replace",
        definition: {
          goal,
          ...(current === undefined ? {} : { budget: budgetCaps(current.budget) }),
        },
      })
    },
    pause: () => setStatus("paused"),
    resume: () => setStatus("active"),
    clear: () => commit({ kind: "clear" }),
    addCriterion: (text) => replaceWith([...criterionDeclarations(read()), { text }]),
    clearBlockers: () => {
      const domain = read()
      if (domain.state === null) {
        return { kind: "rejected", reason: "objective-missing", domain, cleared: 0 }
      }
      const ids = domain.state.objective.blockers.map((blocker) => blocker.id)
      // Nothing to clear ⇒ issue no mutation: an unapplied commit would render
      // as a failure for what is simply "there was nothing blocking".
      if (ids.length === 0) return { kind: "ok", domain, cleared: 0 }
      let outcome = commit({ kind: "clearBlocker", blockerId: ids[0] as string })
      for (const blockerId of ids.slice(1)) {
        if (outcome.kind !== "ok") break
        outcome = commit({ kind: "clearBlocker", blockerId })
      }
      const remaining = read().state?.objective.blockers.length ?? 0
      return { ...outcome, cleared: ids.length - remaining }
    },

    abandonAttempt: () => {
      const domain = read()
      if (domain.state === null) {
        return { kind: "rejected", reason: "objective-missing", domain, hadAttempt: false }
      }
      const hadAttempt = domain.state.objective.attempts.started !== undefined
      // Nothing in flight ⇒ do not issue a mutation at all: the authority
      // reports an unapplied commit and the surface would render that as a
      // failure for what is simply "there was nothing to free".
      if (!hadAttempt) return { kind: "ok", domain, hadAttempt: false }
      const outcome = commit({ kind: "abandonAttempt" })
      return { ...outcome, hadAttempt }
    },
    attestCriterion: (selector) => {
      const criteria = read().state?.objective.successCriteria ?? []
      const index = Number.parseInt(selector, 10)
      const target =
        criteria.find((criterion) => criterion.id === selector) ??
        (Number.isInteger(index) && index >= 1 && index <= criteria.length
          ? criteria[index - 1]
          : undefined)
      if (target === undefined) {
        return { kind: "rejected", reason: "unknown-criterion", domain: read() }
      }
      // A checked criterion is verifier-owned; the authority refuses the
      // attestation anyway, but refusing here names the reason precisely.
      if (target.kind === "checked") {
        return { kind: "rejected", reason: "checked-criterion-needs-verify", domain: read() }
      }
      return commit({ kind: "markCriterion", criterionId: target.id, met: true })
    },
    addCheck: (text, argv) =>
      replaceWith([
        ...criterionDeclarations(read()),
        {
          text,
          check: {
            kind: "command",
            argv: [...argv],
            timeoutMs: DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS,
            successExitCodes: DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES,
          },
        },
      ]),
    setBudget: (budget) => commit({ kind: "amendBudget", budget }),
    verify: async () => {
      if (verifier === undefined) {
        const domain = read()
        onInfrastructureUnavailable?.(domain.revision, Date.now())
        return { kind: "rejected", reason: "verifier-unavailable", domain: read() }
      }
      const verification = await verifier.verify(threadId)
      const domain = read()
      return verification.kind === "verified"
        ? { kind: "ok", domain, verification }
        : { kind: "rejected", reason: verification.kind, domain, verification }
    },
    edit: (goal) =>
      read().state === null
        ? commit({ kind: "create", definition: { goal } })
        : commit({ kind: "replace", definition: { goal } }),
    setStatus,
  }
}

export const buildObjectiveSlashState = buildGoalControl
export type ObjectiveSlashState = GoalControl
export type ObjectiveEditOutcome = GoalControlOutcome
export interface ObjectiveEditView {
  readonly goal: string
  readonly status: ObjectiveStatus
  readonly revision: number
  readonly updatedAt: number
}

export const isGoalEnabled = (): boolean => readCliKnob("QUANTA_GOAL", "bool") ?? true
export const isObjectiveEditorEnabled = isGoalEnabled

export const objectiveCmd: SlashCommand = {
  name: "/objective",
  describe: "Deprecated alias for /goal",
  category: "session",
  run: (args, ctx) => runGoalCommand(args, ctx, "/objective"),
}
