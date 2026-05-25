import { type AgentConfig, buildPlanExit } from "@/agent"
import type { StreamPort } from "@/stream"
import type { UserInputOutcome, UserInputRequester } from "@/tool"

export interface CliPromptPortOptions {
  ask(prompt: string): Promise<string>
}

export interface CliUserInputPortOptions extends CliPromptPortOptions {
  stream: StreamPort
}

const CANCEL_TOKEN = "/cancel"
const BACK_TOKEN = "/back"
const MULTILINE_DONE_TOKEN = "."

const renderPlanExitPrompt = (plan: string): string =>
  [
    "Plan ready for review:",
    plan,
    "",
    "Approve [a], reject [r], or request changes [c].",
    "> ",
  ].join("\n")

const renderPlanExitFeedbackPrompt = (): string =>
  ["Requested changes selected.", `Enter feedback (${BACK_TOKEN} to go back):`, "> "].join("\n")

const normalizePlanExitChoice = (
  raw: string,
): "approved" | "rejected" | "changes_requested" | null => {
  switch (raw.trim().toLowerCase()) {
    case "a":
    case "approve":
    case "approved":
      return "approved"
    case "r":
    case "reject":
    case "rejected":
      return "rejected"
    case "c":
    case "change":
    case "changes":
    case "changes_requested":
      return "changes_requested"
    default:
      return null
  }
}

const renderChoices = (choices: readonly string[]): string =>
  choices.map((choice, idx) => `  ${idx + 1}. ${choice}`).join("\n")

const renderUserInputPrompt = (req: {
  prompt: string
  choices?: readonly string[]
  multiline?: boolean
}): string => {
  const lines = ["Question from agent:", req.prompt, ""]
  if (req.choices !== undefined && req.choices.length > 0) {
    lines.push("Choices:")
    lines.push(renderChoices(req.choices))
    lines.push("")
    lines.push(`Reply with the number or exact text, or ${CANCEL_TOKEN}.`)
  } else if (req.multiline === true) {
    lines.push(
      `Reply below. End with a line containing only "${MULTILINE_DONE_TOKEN}". ` +
        `Type ${CANCEL_TOKEN} on the first line to cancel.`,
    )
  } else {
    lines.push(`Reply below. Type ${CANCEL_TOKEN} to cancel.`)
  }
  lines.push("> ")
  return lines.join("\n")
}

const isCancel = (raw: string): boolean => raw.trim().toLowerCase() === CANCEL_TOKEN

const choiceFromReply = (raw: string, choices: readonly string[]): string | null => {
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10) - 1
    return idx >= 0 && idx < choices.length ? (choices[idx] ?? null) : null
  }
  return choices.find((choice) => choice === trimmed) ?? null
}

const emitUserInputRequested = (
  stream: StreamPort,
  req: {
    promptId: string
    prompt: string
    choices?: readonly string[]
  },
): void => {
  const event: {
    type: "plan_user_input_requested"
    promptId: string
    prompt: string
    choices?: readonly string[]
  } = {
    type: "plan_user_input_requested",
    promptId: req.promptId,
    prompt: req.prompt,
  }
  if (req.choices !== undefined) event.choices = req.choices
  stream.emit(event)
}

const emitUserInputResolved = (
  stream: StreamPort,
  promptId: string,
  outcome: UserInputOutcome,
): void => {
  if (outcome.decision === "answer") {
    stream.emit({
      type: "plan_user_input_resolved",
      promptId,
      decision: "answer",
      text: outcome.text,
    })
    return
  }
  stream.emit({
    type: "plan_user_input_resolved",
    promptId,
    decision: "cancelled",
  })
}

const promptChoiceInput = async (
  ask: CliPromptPortOptions["ask"],
  req: {
    prompt: string
    promptId: string
    choices: readonly string[]
  },
): Promise<UserInputOutcome> => {
  while (true) {
    const raw = await ask(renderUserInputPrompt(req))
    if (isCancel(raw)) return { decision: "cancelled" }
    const choice = choiceFromReply(raw, req.choices)
    if (choice !== null) return { decision: "answer", text: choice }
  }
}

const promptFreeformInput = async (
  ask: CliPromptPortOptions["ask"],
  req: {
    prompt: string
    promptId: string
  },
): Promise<UserInputOutcome> => {
  const raw = await ask(renderUserInputPrompt(req))
  if (isCancel(raw)) return { decision: "cancelled" }
  return { decision: "answer", text: raw }
}

const promptMultilineInput = async (
  ask: CliPromptPortOptions["ask"],
  req: {
    prompt: string
    promptId: string
  },
): Promise<UserInputOutcome> => {
  const lines: string[] = []
  let prompt = renderUserInputPrompt({ prompt: req.prompt, multiline: true })
  while (true) {
    const raw = await ask(prompt)
    if (lines.length === 0 && isCancel(raw)) return { decision: "cancelled" }
    if (raw.trim() === MULTILINE_DONE_TOKEN) {
      return { decision: "answer", text: lines.join("\n") }
    }
    lines.push(raw)
    prompt = "> "
  }
}

export const createCliPlanExitPort = (
  opts: CliPromptPortOptions,
): NonNullable<AgentConfig["planExitPort"]> => ({
  request: async (plan) => {
    while (true) {
      const choice = normalizePlanExitChoice(await opts.ask(renderPlanExitPrompt(plan)))
      if (choice === "approved" || choice === "rejected") {
        return buildPlanExit({ decision: choice })
      }
      if (choice === "changes_requested") {
        while (true) {
          const feedback = await opts.ask(renderPlanExitFeedbackPrompt())
          if (feedback.trim().toLowerCase() === BACK_TOKEN) break
          if (feedback.trim().length === 0) continue
          return buildPlanExit({ decision: "changes_requested", feedback })
        }
      }
    }
  },
})

export const createCliUserInputPort =
  (opts: CliUserInputPortOptions): UserInputRequester =>
  async (req) => {
    emitUserInputRequested(opts.stream, req)
    const outcome =
      req.choices !== undefined && req.choices.length > 0
        ? await promptChoiceInput(opts.ask, {
            prompt: req.prompt,
            promptId: req.promptId,
            choices: req.choices,
          })
        : req.multiline === true
          ? await promptMultilineInput(opts.ask, { prompt: req.prompt, promptId: req.promptId })
          : await promptFreeformInput(opts.ask, { prompt: req.prompt, promptId: req.promptId })
    emitUserInputResolved(opts.stream, req.promptId, outcome)
    return outcome
  }
