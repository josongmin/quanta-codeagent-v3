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
/** UUX-2-19 — consecutive unusable answers (garbage / empty from a released
 *  channel) before the plan-exit prompt fail-closes to REJECTED. Bounded so a
 *  dead input source can never spin the prompt forever. */
const PLAN_EXIT_MAX_UNUSABLE = 5
/** Audit R3 — consecutive blank multiline replies before the prompt settles
 *  (dead-source guard; real pasted text never has this many in a row). */
const MULTILINE_MAX_CONSECUTIVE_EMPTY = 50
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
  // Audit R3 sibling-class fix — bounded like the plan-exit prompt: a dead
  // input source (released channel feeding "") or endless garbage must never
  // spin the ask forever; fail-closed to cancelled.
  let unusable = 0
  while (true) {
    const raw = await ask(renderUserInputPrompt(req))
    if (isCancel(raw)) return { decision: "cancelled" }
    const choice = choiceFromReply(raw, req.choices)
    if (choice !== null) return { decision: "answer", text: choice }
    unusable += 1
    if (unusable >= PLAN_EXIT_MAX_UNUSABLE) return { decision: "cancelled" }
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
  // Audit R3 sibling-class fix — a dead source feeding endless "" must not
  // accumulate unbounded blank lines: cap CONSECUTIVE empties generously
  // (legit multiline text has blank lines, never dozens in a row) and settle
  // with whatever was typed (fail-soft; empty ⇒ cancelled downstream).
  let consecutiveEmpty = 0
  let prompt = renderUserInputPrompt({ prompt: req.prompt, multiline: true })
  while (true) {
    const raw = await ask(prompt)
    if (lines.length === 0 && isCancel(raw)) return { decision: "cancelled" }
    if (raw.trim() === MULTILINE_DONE_TOKEN) {
      return { decision: "answer", text: lines.join("\n") }
    }
    consecutiveEmpty = raw.trim().length === 0 ? consecutiveEmpty + 1 : 0
    if (consecutiveEmpty >= MULTILINE_MAX_CONSECUTIVE_EMPTY) {
      const text = lines.join("\n").trim()
      return text.length === 0 ? { decision: "cancelled" } : { decision: "answer", text }
    }
    lines.push(raw)
    prompt = "> "
  }
}

export const createCliPlanExitPort = (
  opts: CliPromptPortOptions,
): NonNullable<AgentConfig["planExitPort"]> => ({
  request: async (plan) => {
    // UUX-2-19 (jul-10 W4) — the prompt loop is BOUNDED and cancellable:
    // /cancel (or repeated unusable input — e.g. a released mid-turn channel
    // feeding "") fail-closes to REJECTED instead of re-prompting forever.
    let unusable = 0
    while (true) {
      const raw = await opts.ask(renderPlanExitPrompt(plan))
      if (isCancel(raw)) return buildPlanExit({ decision: "rejected" })
      const choice = normalizePlanExitChoice(raw)
      if (choice === "approved" || choice === "rejected") {
        return buildPlanExit({ decision: choice })
      }
      if (choice === "changes_requested") {
        while (true) {
          const feedback = await opts.ask(renderPlanExitFeedbackPrompt())
          if (isCancel(feedback)) return buildPlanExit({ decision: "rejected" })
          if (feedback.trim().toLowerCase() === BACK_TOKEN) break
          if (feedback.trim().length === 0) {
            unusable += 1
            if (unusable >= PLAN_EXIT_MAX_UNUSABLE) {
              return buildPlanExit({ decision: "rejected" })
            }
            continue
          }
          return buildPlanExit({ decision: "changes_requested", feedback })
        }
      }
      if (choice === null) {
        unusable += 1
        if (unusable >= PLAN_EXIT_MAX_UNUSABLE) return buildPlanExit({ decision: "rejected" })
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
