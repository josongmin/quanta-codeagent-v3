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
      case "turn_start":
        process.stdout.write(`${DIM}— turn ${event.turn} —${RESET}\n`)
        break
      case "assistant_text":
        process.stdout.write(event.delta)
        this.inText = true
        break
      case "tool_call":
        process.stdout.write(
          `${CYAN}⚙ ${event.name}${RESET} ${DIM}${compact(event.input)}${RESET}\n`,
        )
        break
      case "tool_result": {
        const mark = event.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
        process.stdout.write(`${mark} ${DIM}${event.name}: ${oneLine(event.preview)}${RESET}\n`)
        break
      }
      case "error":
        process.stdout.write(`${RED}error: ${event.message}${RESET}\n`)
        break
      case "done":
        process.stdout.write(`${DIM}— done (${event.reason}, ${event.turns} turns) —${RESET}\n`)
        break
    }
  }
}

const compact = (input: unknown): string => oneLine(JSON.stringify(input) ?? "")

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
