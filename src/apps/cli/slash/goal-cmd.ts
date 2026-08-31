import type { BudgetLimitSource } from "@/objective"
import type { SlashCommand, SlashContext } from "../slash-contract"
import { renderGoalDomain } from "./goal-render"
import { buildGoalControl } from "./objective"

const MAX_GOAL_CHARS = 4000

const fail = (ctx: SlashContext, message: string): number => {
  ctx.err(`${message}\n`)
  return 1
}

type MutationOutcome = ReturnType<NonNullable<SlashContext["objectiveEditor"]>["pause"]>
type GoalControl = NonNullable<SlashContext["objectiveEditor"]>
type GoalName = "/goal" | "/objective"

const reportMutation = (ctx: SlashContext, label: string, outcome: MutationOutcome): number => {
  if (outcome.kind === "ok") {
    ctx.out(`${label}\n`)
    return 0
  }
  return fail(
    ctx,
    outcome.kind === "stale"
      ? `/goal: changed concurrently (rev ${outcome.domain.revision}); retry`
      : `/goal: ${outcome.reason}`,
  )
}

const parseBudget = (args: readonly string[]): { maxTokens?: number; maxTurns?: number } | null => {
  const result: { maxTokens?: number; maxTurns?: number } = {}
  for (const arg of args) {
    const match = /^--max-(tokens|turns)=(\d+)$/.exec(arg)
    if (match === null) return null
    const value = Number(match[2])
    if (!Number.isSafeInteger(value) || value < 0) return null
    if (match[1] === "tokens") result.maxTokens = value
    else result.maxTurns = value
  }
  return Object.keys(result).length === 0 ? null : result
}

/** GOAL P1-D — a `budget_limited` goal has THREE possible bounds and only one
 *  of them is recoverable by an amendment. Telling an operator to raise a
 *  budget that the product caps anyway sends them to do the one thing
 *  guaranteed not to work. */
const budgetLimitLabel = (limitedBy: BudgetLimitSource | undefined): string => {
  if (limitedBy === "product-hard-cap") {
    return "Cannot resume: the product autonomous attempt cap is exhausted; raising the budget will not help. Start fresh goal work, or edit the goal."
  }
  if (limitedBy === "product-budget-ceiling") {
    return "Cannot resume: this goal reached the product ceiling on a single goal's spend; raising the budget will not help. Edit the goal or start a new one."
  }
  return "Cannot resume: increase budget or edit the goal."
}

const resumeLabel = (status: string, limitedBy: BudgetLimitSource | undefined): string => {
  if (status === "active") return "Goal resumed."
  if (status === "blocked") return "Cannot resume: clear blocker first."
  if (status === "budget_limited") return budgetLimitLabel(limitedBy)
  if (status === "usage_limited") return "Cannot resume until the usage limit expires."
  if (status === "completed") return "Cannot resume a completed goal; edit or create a new goal."
  return "Goal remains paused."
}

const handleResume = (ctx: SlashContext, control: GoalControl): number => {
  const outcome = control.resume()
  const objective = outcome.domain.state?.objective
  const label = resumeLabel(objective?.status ?? "paused", objective?.budget.limitedBy)
  if (outcome.kind !== "ok") return fail(ctx, label)
  ctx.out(`${label}\n`)
  return 0
}

const validateGoalText = (ctx: SlashContext, name: GoalName, text: string): number | null => {
  if (text.length === 0) return fail(ctx, `${name} edit: requires <text>`)
  return text.length > MAX_GOAL_CHARS
    ? fail(ctx, `${name}: objective too long (${text.length} > ${MAX_GOAL_CHARS} chars)`)
    : null
}

const handleEdit = (
  args: readonly string[],
  ctx: SlashContext,
  name: GoalName,
  control: GoalControl,
): number => {
  const text = args.slice(1).join(" ").trim()
  const invalid = validateGoalText(ctx, name, text)
  return invalid ?? reportMutation(ctx, "Goal replaced.", control.replace(text))
}

const handleCriterion = (
  args: readonly string[],
  ctx: SlashContext,
  name: GoalName,
  control: GoalControl,
): number => {
  const text = args.slice(2).join(" ").trim()
  // GOAL P0-2 — `done` is the operator's manual attestation; without it a
  // manual-only stopping contract is unsatisfiable (the model may not attest).
  if (args[1] === "done") {
    return text === ""
      ? fail(ctx, `${name} criterion done: requires <index|id>`)
      : reportMutation(ctx, "Criterion attested.", control.attestCriterion(text))
  }
  return args[1] !== "add" || text === ""
    ? fail(ctx, `${name} criterion add|done: requires <description|index>`)
    : reportMutation(ctx, "Criterion added.", control.addCriterion(text))
}

/** GOAL-08 rail 15 — `/goal work <instruction>`: ONE foreground turn with
 *  host-minted user-requested provenance (charges the user turn budget, never
 *  the autonomous hard cap). Plain chat never receives this provenance. */
/** GOAL P0-3 — free a stuck attributed attempt so the goal is editable again.
 *  Says plainly when there was nothing to free (a success line over a no-op
 *  would be the "inert write" shape this repo treats as a defect). */
const handleAbandon = (ctx: SlashContext, control: GoalControl): number => {
  const outcome = control.abandonAttempt()
  if (outcome.kind === "ok" && !outcome.hadAttempt) {
    ctx.out("Goal: no attempt was in flight.\n")
    return 0
  }
  return reportMutation(ctx, "Attempt abandoned (the reserved turn is not refunded).", outcome)
}

const handleUnblock = (ctx: SlashContext, control: GoalControl): number => {
  const outcome = control.clearBlockers()
  if (outcome.kind === "ok" && outcome.cleared === 0) {
    ctx.out("Goal: no blocker to clear.\n")
    return 0
  }
  return reportMutation(
    ctx,
    `Cleared ${outcome.cleared} blocker${outcome.cleared === 1 ? "" : "s"}.`,
    outcome,
  )
}

const handleWork = (args: readonly string[], ctx: SlashContext, name: GoalName): number => {
  const instruction = args.slice(1).join(" ").trim()
  if (instruction === "") return fail(ctx, `${name} work: requires <instruction>`)
  const enqueue = ctx.goal?.enqueueWork
  if (enqueue === undefined) {
    return fail(ctx, `${name} work: not wired in this surface (goal pursuit is not composed)`)
  }
  const enqueued = enqueue(instruction)
  if (!enqueued.ok) return fail(ctx, `${name} work: ${enqueued.reason}`)
  ctx.out("Goal work queued — one foreground turn with user-requested goal provenance.\n")
  return 0
}

const handleCheck = (
  args: readonly string[],
  ctx: SlashContext,
  name: GoalName,
  control: GoalControl,
): number => {
  const separator = args.indexOf("--")
  if (args[1] !== "add" || separator < 3 || separator === args.length - 1)
    return fail(ctx, `${name} check add: expected <description> -- <argv...>`)
  return reportMutation(
    ctx,
    "Check added.",
    control.addCheck(args.slice(2, separator).join(" ").trim(), args.slice(separator + 1)),
  )
}

const handleBudget = (
  args: readonly string[],
  ctx: SlashContext,
  name: GoalName,
  control: GoalControl,
): number => {
  const budget = parseBudget(args.slice(1))
  return budget === null
    ? fail(ctx, `${name} budget: expected --max-turns=N and/or --max-tokens=N`)
    : reportMutation(ctx, "Goal budget updated.", control.setBudget(budget))
}

const handleCreate = (
  args: readonly string[],
  ctx: SlashContext,
  name: GoalName,
  control: GoalControl,
): number => {
  const text = args.join(" ").trim()
  const invalid = validateGoalText(ctx, name, text)
  if (invalid !== null) return invalid
  if (control.read().state !== null)
    return fail(ctx, `${name}: a goal already exists; use '${name} edit <text>'`)
  return reportMutation(ctx, "Goal created.", control.create(text))
}

export const runGoalCommand = async (
  args: readonly string[],
  ctx: SlashContext,
  invokedAs: GoalName = "/goal",
): Promise<number> => {
  const control =
    ctx.objectiveEditor ??
    (ctx.goal === undefined
      ? undefined
      : buildGoalControl(ctx.goal.port, ctx.goal.threadId, ctx.goal.onMutation))
  if (control === undefined) return fail(ctx, `${invokedAs}: goal control unavailable`)
  switch (args[0]) {
    case undefined:
    case "show":
      {
        const current = await control.reconcileAndRead()
        ctx.out(
          renderGoalDomain(
            current.domain,
            ctx.now?.() ?? Date.now(),
            ctx.goal?.wakeStatus?.(),
            current.freshness,
          ),
        )
      }
      return 0
    case "pause":
    case "stop":
      return reportMutation(ctx, "Goal paused.", control.pause())
    case "resume":
      return handleResume(ctx, control)
    case "clear":
      return reportMutation(ctx, "Goal cleared.", control.clear())
    case "edit":
      return handleEdit(args, ctx, invokedAs, control)
    case "criterion":
      return handleCriterion(args, ctx, invokedAs, control)
    case "check":
      return handleCheck(args, ctx, invokedAs, control)
    case "budget":
      return handleBudget(args, ctx, invokedAs, control)
    case "verify":
      return reportMutation(ctx, "Goal verification applied.", await control.verify())
    case "work":
      return handleWork(args, ctx, invokedAs)
    case "abandon":
      return handleAbandon(ctx, control)
    case "unblock":
      return handleUnblock(ctx, control)
    default:
      return handleCreate(args, ctx, invokedAs, control)
  }
}

export const goalCmd: SlashCommand = {
  name: "/goal",
  describe:
    "Create or control the durable goal (show | edit | pause | resume | unblock | clear | criterion add|done | check | budget | verify | work | abandon)",
  category: "session",
  run: (args, ctx) => runGoalCommand(args, ctx),
}
