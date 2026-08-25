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

const resumeLabel = (status: string): string => {
  if (status === "active") return "Goal resumed."
  if (status === "blocked") return "Cannot resume: clear blocker first."
  if (status === "budget_limited") return "Cannot resume: increase budget or edit the goal."
  if (status === "usage_limited") return "Cannot resume until the usage limit expires."
  if (status === "completed") return "Cannot resume a completed goal; edit or create a new goal."
  return "Goal remains paused."
}

const handleResume = (ctx: SlashContext, control: GoalControl): number => {
  const outcome = control.resume()
  const label = resumeLabel(outcome.domain.state?.objective.status ?? "paused")
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
  return args[1] !== "add" || text === ""
    ? fail(ctx, `${name} criterion add: requires <description>`)
    : reportMutation(ctx, "Criterion added.", control.addCriterion(text))
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
      ctx.out(renderGoalDomain(control.read(), ctx.now?.() ?? Date.now()))
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
    default:
      return handleCreate(args, ctx, invokedAs, control)
  }
}

export const goalCmd: SlashCommand = {
  name: "/goal",
  describe:
    "Create or control the durable goal (show | edit | pause | resume | clear | criterion | check | budget | verify)",
  category: "session",
  run: (args, ctx) => runGoalCommand(args, ctx),
}
