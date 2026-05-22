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

/** ADR-0048: render the `in_progress` heartbeat one-liner, appending the
 *  optional percentage + status when the provider carried them. Extracted from
 *  `emit` so the switch case stays a single statement. */
const renderInProgress = (event: Extract<AgentEvent, { type: "in_progress" }>): string => {
  const pct = event.progress !== undefined ? ` ${Math.round(event.progress * 100)}%` : ""
  const msg =
    event.message !== undefined && event.message !== "" ? `: ${oneLine(event.message)}` : ""
  return `${DIM}… thinking${pct}${msg}${RESET}\n`
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
