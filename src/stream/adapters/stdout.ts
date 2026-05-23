import { redactValue } from "@/shared"
import type { StreamPort } from "../ports"
import type { AgentEvent } from "../types"

const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const RESET = "\x1b[0m"

/** Human-readable stdout renderer. Assistant text streams inline; tool
 *  activity and lifecycle render as dim status lines. */
export class StdoutStream implements StreamPort {
  private inText = false

  emit(event: AgentEvent): void {
    if (event.type !== "assistant_text" && this.inText) {
      process.stdout.write("\n")
      this.inText = false
    }

    switch (event.type) {
      case "session_start":
        process.stdout.write(`${DIM}— session start —${RESET}\n`)
        break
      case "turn_start":
        process.stdout.write(`${DIM}— turn ${event.turn} —${RESET}\n`)
        break
      case "assistant_text":
        // S4: a secret pasted into model output must not hit the terminal.
        process.stdout.write(redactStr(event.delta))
        this.inText = true
        break
      case "tool_call":
        process.stdout.write(
          `${CYAN}⚙ ${event.name}${RESET} ${DIM}${compact(event.input)}${RESET}\n`,
        )
        break
      case "tool_progress":
        process.stdout.write(`${DIM}  ↳ ${event.name}: ${oneLine(event.message)}${RESET}\n`)
        break
      case "tool_result": {
        const mark = event.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
        const tail =
          event.stderrTail !== undefined && event.stderrTail !== ""
            ? ` ${DIM}stderr: ${oneLine(redactStr(event.stderrTail))}${RESET}`
            : ""
        process.stdout.write(
          `${mark} ${DIM}${event.name}: ${oneLine(redactStr(event.preview))}${RESET}${tail}\n`,
        )
        break
      }
      case "recovery": {
        const detail =
          event.detail !== undefined && event.detail !== ""
            ? `: ${oneLine(redactStr(event.detail))}`
            : ""
        process.stdout.write(`${DIM}↺ recovery (${event.reason})${detail}${RESET}\n`)
        break
      }
      case "context_compacted":
        // ADR-0075: one-line proactive-compaction marker — `from..to` lets a
        // grep distinguish the new emit from the legacy `↺ recovery (compact)`
        // line that fires immediately before it.
        process.stdout.write(
          `${DIM}↺ context_compacted (${event.fromTurnId}..${event.toTurnId}, ${event.tokens}t)${RESET}\n`,
        )
        break
      case "error":
        process.stdout.write(`${RED}error: ${redactStr(event.message)}${RESET}\n`)
        break
      case "llm_request":
        process.stdout.write(`${DIM}— llm request (${event.model}) —${RESET}\n`)
        break
      case "in_progress":
        // ADR-0048: provider "thinking…" heartbeat. The two optional-field
        // branches live in `renderInProgress` so this case stays a single
        // statement (keeps `emit`'s cognitive complexity under the budget).
        process.stdout.write(renderInProgress(event))
        break
      case "response_queued":
        process.stdout.write(renderResponseQueued(event))
        break
      case "interrupted":
        process.stdout.write(renderInterrupted(event))
        break
      case "subagent_cancel":
        process.stdout.write(renderSubagentCancel(event))
        break
      case "plan_created":
        process.stdout.write(renderPlanCreated(event))
        break
      case "plan_updated":
        process.stdout.write(renderPlanUpdated(event))
        break
      case "plan_snapshot":
        process.stdout.write(renderPlanSnapshot(event))
        break
      case "plan_user_input_requested":
        process.stdout.write(renderPlanUserInputRequested(event))
        break
      case "plan_user_input_resolved":
        process.stdout.write(renderPlanUserInputResolved(event))
        break
      case "mode_changed":
        process.stdout.write(renderModeChanged(event))
        break
      case "usage":
        process.stdout.write(
          `${DIM}— usage ${event.inputTokens}/${event.outputTokens} (${event.model}) —${RESET}\n`,
        )
        break
      case "done":
        process.stdout.write(`${DIM}— done (${event.reason}, ${event.turns} turns) —${RESET}\n`)
        break
      default: {
        // Exhaustiveness guard: a new AgentEvent variant must be handled
        // explicitly rather than silently rendered (or crashing) here.
        const _exhaustive: never = event
        void _exhaustive
        break
      }
    }
  }
}

/** ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure
 *  one-line dim status. PausedReason taxonomy (model_streaming /
 *  awaiting_approval / network_retry / ...) + control_op_pending. Extracted
 *  from `emit` so the switch case stays a single statement (keeps `emit`'s
 *  cognitive complexity under the budget). */
const renderResponseQueued = (event: Extract<AgentEvent, { type: "response_queued" }>): string => {
  const hint = event.hint !== undefined && event.hint !== "" ? `: ${oneLine(event.hint)}` : ""
  return `${DIM}⏸ queued (${event.reason})${hint}${RESET}\n`
}

/** ADR control-op cluster: typed-interrupt observation. `reason` is the
 *  verbatim cancel reason from `conversation_action_cancel` (redacted). */
const renderInterrupted = (event: Extract<AgentEvent, { type: "interrupted" }>): string => {
  const reason =
    event.reason !== undefined && event.reason !== "" ? `: ${oneLine(redactStr(event.reason))}` : ""
  return `${DIM}⛔ interrupted (${event.source})${reason}${RESET}\n`
}

/** ADR control-op cluster: subagent cancel routing observation. Parent KEEPS
 *  running — this is not a finish trigger. */
const renderSubagentCancel = (event: Extract<AgentEvent, { type: "subagent_cancel" }>): string =>
  `${DIM}✂ subagent ${event.subagentId} (${event.outcome}, via ${event.source})${RESET}\n`

/** ADR-0048: render the `in_progress` heartbeat one-liner, appending the
 *  optional percentage + status when the provider carried them. Extracted from
 *  `emit` so the switch case stays a single statement. */
const renderInProgress = (event: Extract<AgentEvent, { type: "in_progress" }>): string => {
  const pct = event.progress !== undefined ? ` ${Math.round(event.progress * 100)}%` : ""
  const msg =
    event.message !== undefined && event.message !== "" ? `: ${oneLine(event.message)}` : ""
  return `${DIM}… thinking${pct}${msg}${RESET}\n`
}

/** Plan-mode cluster (P3): plan_created one-liner. Format pin —
 *  `plan_created` discriminant token is greppable; `name` is quoted; todo
 *  count rendered last. */
const renderPlanCreated = (event: Extract<AgentEvent, { type: "plan_created" }>): string => {
  const count = event.plan.todos.length
  return `${DIM}📋 plan_created "${oneLine(redactStr(event.plan.name))}" (${count} todos)${RESET}\n`
}

/** Plan-mode cluster (P3): plan_updated one-liner. Format pin —
 *  `plan_updated` discriminant token + version + delta kind. */
const renderPlanUpdated = (event: Extract<AgentEvent, { type: "plan_updated" }>): string => {
  const title =
    event.delta.todoTitle !== undefined && event.delta.todoTitle !== ""
      ? ` "${oneLine(redactStr(event.delta.todoTitle))}"`
      : ""
  return `${DIM}📋 plan_updated v${event.version} ${event.delta.kind}${title}${RESET}\n`
}

/** Plan-mode cluster (P3): plan_snapshot one-liner. Format pin —
 *  `plan_snapshot` discriminant token + name + todo count. */
const renderPlanSnapshot = (event: Extract<AgentEvent, { type: "plan_snapshot" }>): string => {
  const count = event.plan.todos.length
  return `${DIM}📋 plan_snapshot "${oneLine(redactStr(event.plan.name))}" (${count} todos)${RESET}\n`
}

/** Plan-mode cluster (P3): plan_user_input_requested one-liner. The
 *  `plan_user_input_requested` discriminant token is greppable. Choices
 *  rendered as a small `[a|b|c]` suffix when present. */
const renderPlanUserInputRequested = (
  event: Extract<AgentEvent, { type: "plan_user_input_requested" }>,
): string => {
  const choices =
    event.choices !== undefined && event.choices.length > 0
      ? ` [${event.choices.map((c) => oneLine(redactStr(c))).join("|")}]`
      : ""
  return `${DIM}❓ plan_user_input_requested "${oneLine(redactStr(event.prompt))}"${choices}${RESET}\n`
}

/** Plan-mode cluster (P3): plan_user_input_resolved one-liner. */
const renderPlanUserInputResolved = (
  event: Extract<AgentEvent, { type: "plan_user_input_resolved" }>,
): string => {
  const text =
    event.text !== undefined && event.text !== "" ? `: "${oneLine(redactStr(event.text))}"` : ""
  return `${DIM}✓ plan_user_input_resolved (${event.decision})${text}${RESET}\n`
}

/** Plan-mode cluster (P3): mode_changed one-liner. */
const renderModeChanged = (event: Extract<AgentEvent, { type: "mode_changed" }>): string => {
  const reason =
    event.reason !== undefined && event.reason !== "" ? `: ${oneLine(redactStr(event.reason))}` : ""
  return `${DIM}↻ mode_changed ${event.from} → ${event.to}${reason}${RESET}\n`
}

/** Mask secrets in a free-text string via the single-source @/shared scrub.
 *  redactValue returns the input unchanged for benign strings. */
const redactStr = (s: string): string => {
  const r = redactValue(s)
  return typeof r === "string" ? r : s
}

const compact = (input: unknown): string => oneLine(JSON.stringify(redactValue(input)) ?? "")

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
