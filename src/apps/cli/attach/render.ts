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

import type { SessionEvent, SessionEventType } from "@/protocol/session"

const PROMPT_RULE = "──────────────────────────────────────────"

type AttachRendererRegistry = {
  [K in SessionEventType]?: (event: Extract<SessionEvent, { type: K }>) => string
}

export const ATTACH_RENDERED_SESSION_EVENT_TYPES = [
  "turn.started",
  "turn.output.delta",
  "turn.completed",
  "turn.failed",
  "tool.invoked",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "artifact.ready",
  "session.created",
  "session.closed",
] as const satisfies readonly SessionEventType[]

export const ATTACH_IGNORED_SESSION_EVENT_TYPES = [
  "session.state.updated",
  "skill.scope.decision",
  "turn.llm.continuation",
  "turn.llm.request",
] as const satisfies readonly SessionEventType[]

const ATTACH_SESSION_EVENT_RENDERERS: AttachRendererRegistry = {
  "turn.started": (event) => `\n${PROMPT_RULE}\n› ${event.prompt}\n`,
  "turn.output.delta": (event) =>
    // Streamed verbatim — no leading/trailing newline so consecutive deltas
    // concatenate into the assistant's reply line.
    event.delta,
  "turn.completed": (event) => `\n[turn ${event.outcomeReason}]\n`,
  "turn.failed": (event) => `\n[turn failed] ${event.message}\n`,
  "tool.invoked": (event) => {
    const args = event.argsPreview !== undefined ? ` ${event.argsPreview}` : ""
    return `\n  ⚙ ${event.toolName}${args}\n`
  },
  "tool.completed": (event) => {
    const dur = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : ""
    return `  ✓ ${event.toolName} → ${event.outcome}${dur}\n`
  },
  "approval.requested": (event) => `\n[approval requested] ${event.approval.reason}\n`,
  "approval.resolved": (event) => `[approval ${event.decision}d]\n`,
  "artifact.ready": (event) => {
    const name = event.artifact.name ?? event.artifact.artifactId
    return `\n[artifact ready] ${name} (${event.artifact.mimeType})\n`
  },
  "session.created": (event) =>
    `[session ${event.model !== undefined ? `· ${event.model}` : "connected"}]\n`,
  "session.closed": () => "\n[session closed by daemon]\n",
}

export const renderSessionEvent = (event: SessionEvent): string => {
  const renderer = ATTACH_SESSION_EVENT_RENDERERS[event.type] as
    | ((event: SessionEvent) => string)
    | undefined
  return renderer?.(event) ?? ""
}
