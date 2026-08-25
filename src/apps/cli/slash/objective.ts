import type {
  CriterionDeclaration,
  ObjectiveBudget,
  ObjectiveDomainSnapshot,
  ObjectivePort,
  ObjectiveStatus,
  ObjectiveVerificationPort,
  UserObjectiveMutation,
  VerificationOutcome,
} from "@/objective"
import { createObjectiveCapabilities } from "@/objective"
import { readCliKnob } from "../cli-knobs-accessor"
import type { SlashCommand } from "../slash-contract"
import { runGoalCommand } from "./goal-cmd"

// Operator-added checks get a bounded two-minute default unless a future
// command surface exposes an explicit timeout policy.
const DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS = 120_000

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
  create(goal: string): GoalControlOutcome
  replace(goal: string): GoalControlOutcome
  pause(): GoalControlOutcome
  resume(): GoalControlOutcome
  clear(): GoalControlOutcome
  addCriterion(text: string): GoalControlOutcome
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
    addCheck: (text, argv) =>
      replaceWith([
        ...criterionDeclarations(read()),
        {
          text,
          check: {
            kind: "command",
            argv: [...argv],
            timeoutMs: DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS,
            successExitCodes: [0],
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
