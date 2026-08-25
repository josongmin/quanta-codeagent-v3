/**
 * GOAL-05A — `buildGoalControl`: the ONE CLI adapter over the objective
 * authority (user capability), its read port, and the optional verifier.
 *
 * Contract:
 *   - every command is exactly ONE authority commit (or none: show / verify /
 *     work); a criterion / check edit builds one full replacement definition
 *     and commits it once (fresh generation, evidence reset);
 *   - the control never decides a transition or predicts a status: every
 *     verdict is the authority's typed {@link CommitRejection}, and every
 *     result carries a FRESH re-read {@link GoalReport};
 *   - `/goal edit` clears the stopping contract by default (the new
 *     generation is wake-ineligible until a criterion / check is added);
 *     `--keep-contract` carries the DECLARATIONS forward (ids re-minted,
 *     evidence from zero);
 *   - `/goal verify` runs the verifier port (no agent turn, verifier-metered);
 *   - `/goal work` enqueues ONE foreground prompt with host-minted
 *     `user-requested-goal-work` provenance bound to the live revision.
 *
 * `/objective` (deprecated alias) and `/goal` drive the SAME control instance.
 */

import {
  type CommitRejection,
  type CriterionDeclaration,
  createObjectiveCapabilities,
  type GoalDefinition,
  type Objective,
  type ObjectiveBudgetLimit,
  type ObjectiveCapabilities,
  type ObjectivePort,
  type ObjectiveVerificationPort,
  type UserObjectiveMutation,
  type VerificationOutcome,
} from "@/objective"
import type { CliPromptInput } from "../repl/prompt-types"
import type { GoalCommand } from "./goal-args"
import { buildGoalReport, type GoalReport } from "./goal-render"

export type GoalCommandResult =
  | { readonly kind: "ok"; readonly report: GoalReport | null }
  | {
      readonly kind: "rejected"
      readonly reason: CommitRejection
      readonly report: GoalReport | null
    }
  | { readonly kind: "no-objective" }
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "verified"
      readonly outcome: VerificationOutcome
      readonly report: GoalReport | null
    }
  | { readonly kind: "work-queued"; readonly report: GoalReport | null }

export interface GoalControl {
  /** Fresh read-port report (`null` when no objective is live). */
  read(): GoalReport | null
  run(command: GoalCommand): Promise<GoalCommandResult>
}

export interface GoalControlDeps {
  readonly port: ObjectivePort
  readonly threadId: string
  readonly verifier?: ObjectiveVerificationPort | undefined
  /** Surface event hook after a SUCCESSFUL commit (never mutates the objective). */
  readonly onMutation?: (() => void) | undefined
  /** `/goal work` sink — the session's external prompt queue. Absent ⇒ not wired. */
  readonly enqueueWork?: ((input: CliPromptInput) => void) | undefined
  readonly workAttemptId?: (() => string) | undefined
  readonly now?: (() => number) | undefined
}

/** The declarations of a live generation (what `--keep-contract` carries). */
const declarationsOf = (o: Objective): CriterionDeclaration[] =>
  o.successCriteria.map((c) => ({
    text: c.text,
    ...(c.kind === "checked"
      ? {
          check: {
            kind: "command" as const,
            argv: [...c.check.argv],
            timeoutMs: c.check.timeoutMs,
            successExitCodes: [...c.check.successExitCodes],
          },
        }
      : {}),
  }))

const capsOf = (o: Objective): ObjectiveBudgetLimit => ({
  ...(o.budget.maxTokens !== undefined ? { maxTokens: o.budget.maxTokens } : {}),
  ...(o.budget.maxTurns !== undefined ? { maxTurns: o.budget.maxTurns } : {}),
})

/** One full replacement definition: same goal + caps, edited criteria. */
const replacement = (o: Objective, criteria: readonly CriterionDeclaration[]): GoalDefinition => ({
  goal: o.goal,
  criteria: [...criteria],
  budget: capsOf(o),
})

type Edit =
  | { readonly ok: true; readonly criteria: CriterionDeclaration[] }
  | { readonly ok: false; readonly message: string }

/** Apply a criterion / check edit to the declaration list (pure). */
const editCriteria = (o: Objective, command: GoalCommand): Edit => {
  const decls = declarationsOf(o)
  const indexOfCriterion = (id: string): number => o.successCriteria.findIndex((c) => c.id === id)
  const indexOfCheck = (id: string): number =>
    o.successCriteria.findIndex((c) => c.kind === "checked" && c.check.id === id)
  switch (command.kind) {
    case "criterion-add":
      return { ok: true, criteria: [...decls, { text: command.text }] }
    case "criterion-edit": {
      const i = indexOfCriterion(command.criterionId)
      if (i === -1) return { ok: false, message: `unknown criterion '${command.criterionId}'` }
      return {
        ok: true,
        criteria: decls.map((d, j) => (j === i ? { ...d, text: command.text } : d)),
      }
    }
    case "criterion-remove": {
      const i = indexOfCriterion(command.criterionId)
      if (i === -1) return { ok: false, message: `unknown criterion '${command.criterionId}'` }
      return { ok: true, criteria: decls.filter((_, j) => j !== i) }
    }
    case "check-add":
      return { ok: true, criteria: [...decls, { text: command.text, check: command.check }] }
    case "check-edit": {
      const i = indexOfCheck(command.checkId)
      if (i === -1) return { ok: false, message: `unknown check '${command.checkId}'` }
      return {
        ok: true,
        criteria: decls.map((d, j) => (j === i ? { text: command.text, check: command.check } : d)),
      }
    }
    case "check-remove": {
      const i = indexOfCheck(command.checkId)
      if (i === -1) return { ok: false, message: `unknown check '${command.checkId}'` }
      return { ok: true, criteria: decls.filter((_, j) => j !== i) }
    }
    default:
      return { ok: false, message: `not a definition edit: ${command.kind}` }
  }
}

const isDefinitionEdit = (kind: GoalCommand["kind"]): boolean =>
  kind === "criterion-add" ||
  kind === "criterion-edit" ||
  kind === "criterion-remove" ||
  kind === "check-add" ||
  kind === "check-edit" ||
  kind === "check-remove"

export const buildGoalControl = (deps: GoalControlDeps): GoalControl => {
  const caps: ObjectiveCapabilities = createObjectiveCapabilities(deps.port)
  const now = deps.now ?? Date.now
  const { threadId } = deps
  const read = (): GoalReport | null => buildGoalReport(caps.read.readDomain(threadId), now())
  const live = (): Objective | null => caps.read.get(threadId)

  /** The single commit of a command, always followed by a FRESH re-read. */
  const commit = (mutation: UserObjectiveMutation): GoalCommandResult => {
    const res = caps.user.commit(threadId, mutation)
    if (res.ok) {
      deps.onMutation?.()
      return { kind: "ok", report: read() }
    }
    return { kind: "rejected", reason: res.reason, report: read() }
  }

  const mintWorkAttemptId = deps.workAttemptId ?? (() => `user-work:${crypto.randomUUID()}`)

  const runWork = (instruction: string): GoalCommandResult => {
    const o = live()
    if (o === null) return { kind: "no-objective" }
    if (deps.enqueueWork === undefined) {
      return {
        kind: "invalid",
        message:
          "/goal work: not wired in this surface (goal pursuit is composed under QUANTA_GOAL_ENFORCE=1)",
      }
    }
    if (o.status !== "active") {
      return {
        kind: "invalid",
        message: `/goal work: the goal is ${o.status}, not active — resume it first`,
      }
    }
    deps.enqueueWork({
      text: instruction,
      goalContinuation: {
        threadId,
        objectiveRevision: caps.read.readDomain(threadId).revision,
        attemptKey: mintWorkAttemptId(),
        provenance: "user-requested-goal-work",
      },
    })
    return { kind: "work-queued", report: read() }
  }

  const runVerify = async (): Promise<GoalCommandResult> => {
    if (live() === null) return { kind: "no-objective" }
    if (deps.verifier === undefined) {
      return { kind: "invalid", message: "/goal verify: no verifier is wired in this surface" }
    }
    const outcome = await deps.verifier.verify(threadId)
    return { kind: "verified", outcome, report: read() }
  }

  const runDefinitionEdit = (command: GoalCommand): GoalCommandResult => {
    const o = live()
    if (o === null) return { kind: "no-objective" }
    const edit = editCriteria(o, command)
    if (!edit.ok)
      return {
        kind: "invalid",
        message: `/goal ${command.kind.replace("-", " ")}: ${edit.message}`,
      }
    return commit({ kind: "replace", definition: replacement(o, edit.criteria) })
  }

  /** The single user mutation of a command that needs a LIVE objective. */
  const liveMutationOf = (
    command: GoalCommand,
    o: Objective,
  ): UserObjectiveMutation | undefined => {
    switch (command.kind) {
      case "edit":
        return {
          kind: "replace",
          definition: {
            goal: command.text,
            ...(command.keepContract ? { criteria: declarationsOf(o) } : {}),
            budget: capsOf(o),
          },
        }
      case "pause":
        return { kind: "setExplicitStatus", status: "paused" }
      case "resume":
        return { kind: "setExplicitStatus", status: "active" }
      case "clear":
        return { kind: "clear" }
      case "criterion-complete":
        return { kind: "markCriterion", criterionId: command.criterionId, met: true }
      case "criterion-reopen":
        return { kind: "markCriterion", criterionId: command.criterionId, met: false }
      case "budget":
        return { kind: "amendBudget", budget: command.budget }
      default:
        return undefined
    }
  }

  const run = async (command: GoalCommand): Promise<GoalCommandResult> => {
    if (isDefinitionEdit(command.kind)) return runDefinitionEdit(command)
    switch (command.kind) {
      case "show":
        return live() === null ? { kind: "no-objective" } : { kind: "ok", report: read() }
      case "create":
        return commit({ kind: "create", definition: { goal: command.text } })
      case "verify":
        return runVerify()
      case "work":
        return runWork(command.instruction)
      default:
        break
    }
    const o = live()
    if (o === null) return { kind: "no-objective" }
    const mutation = liveMutationOf(command, o)
    return mutation === undefined
      ? { kind: "invalid", message: `unsupported command ${command.kind}` }
      : commit(mutation)
  }

  return { read, run }
}
