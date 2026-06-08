/**
 * SessionEvent → terminal text renderer (PURE).
 *
 * Maps the daemon's broadcast SessionEvents to clean lines for the attached
 * REPL. The contract is deliberately minimal: return the EXACT string to write
 * to the terminal for a given event, or `""` for events that should produce no
 * terminal output (internal state churn). The caller writes the returned chunk
 * verbatim — no implicit newlines — so `turn.output.delta` can stream a token
 * at a time and assemble into one continuous assistant line.
 *
 * Color/markup is intentionally avoided here (a downstream wrapper can dress it
 * up); keeping the mapping pure text makes it trivially unit-testable.
 */

import type { SessionEvent } from "@/protocol/session"

const PROMPT_RULE = "──────────────────────────────────────────"

export const renderSessionEvent = (event: SessionEvent): string => {
  switch (event.type) {
    case "turn.started":
      return `\n${PROMPT_RULE}\n› ${event.prompt}\n`
    case "turn.output.delta":
      // Streamed verbatim — no leading/trailing newline so consecutive deltas
      // concatenate into the assistant's reply line.
      return event.delta
    case "turn.completed": {
      // Trailing newline so the next interactive prompt starts on a clean line.
      const reason = event.outcomeReason
      return `\n[turn ${reason}]\n`
    }
    case "turn.failed":
      return `\n[turn failed] ${event.message}\n`
    case "tool.invoked": {
      const args = event.argsPreview !== undefined ? ` ${event.argsPreview}` : ""
      return `\n  ⚙ ${event.toolName}${args}\n`
    }
    case "tool.completed": {
      const dur = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : ""
      return `  ✓ ${event.toolName} → ${event.outcome}${dur}\n`
    }
    case "approval.requested":
      return `\n[approval requested] ${event.approval.reason}\n`
    case "approval.resolved":
      return `[approval ${event.decision}d]\n`
    case "artifact.ready": {
      const name = event.artifact.name ?? event.artifact.artifactId
      return `\n[artifact ready] ${name} (${event.artifact.mimeType})\n`
    }
    case "session.created":
      return `[session ${event.model !== undefined ? `· ${event.model}` : "connected"}]\n`
    case "session.closed":
      return "\n[session closed by daemon]\n"
    // Internal churn / low-signal events render to nothing (no terminal spam).
    case "session.state.updated":
    case "turn.llm.request":
    case "turn.llm.continuation":
      return ""
    default:
      return ""
  }
}
