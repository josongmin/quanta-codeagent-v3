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
  "turn.aborted",
  "tool.invoked",
  "tool.completed",
  "item.started",
  "item.delta",
  "item.completed",
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
  // UUX-1-12 (jul-10) — additive observability events. The attach surface
  // already renders progress/recovery via its own turn channel (the local
  // stream adapter), so these wire mirrors are explicitly ignored here for now;
  // promoting any of them to a rendered line is a deliberate future decision.
  "tool.progress",
  "turn.recovery",
  "context.compacted",
  "budget.breach",
] as const satisfies readonly SessionEventType[]

const ATTACH_SESSION_EVENT_RENDERERS: AttachRendererRegistry = {
  "turn.started": (event) => `\n${PROMPT_RULE}\n› ${event.prompt}\n`,
  "turn.output.delta": (event) =>
    // Streamed verbatim — no leading/trailing newline so consecutive deltas
    // concatenate into the assistant's reply line.
    event.delta,
  "turn.completed": (event) => `\n[turn ${event.outcomeReason}]\n`,
  "turn.failed": (event) => `\n[turn failed] ${event.message}\n`,
  "turn.aborted": (event) => `\n[turn aborted] ${event.message}\n`,
  "tool.invoked": (event) => {
    const args = event.argsPreview !== undefined ? ` ${event.argsPreview}` : ""
    return `\n  ⚙ ${event.toolName}${args}\n`
  },
  "tool.completed": (event) => {
    const dur = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : ""
    return `  ✓ ${event.toolName} → ${event.outcome}${dur}\n`
  },
  // T01 — item/* fine-grained stream (QUANTA_ITEM_STREAM). The `started` opens a
  // labelled line; `delta`s append verbatim so reasoning / command output / patch
  // text streams in place; `completed` closes the line. This is the wire-driven
  // observation the attach CLI gets that the raw turn events do NOT carry.
  "item.started": (event) => `\n  ⟢ ${event.itemType}: `,
  "item.delta": (event) => event.delta,
  "item.completed": () => "\n",
  "approval.requested": (event) => `\n[approval requested] ${event.approval.reason}\n`,
  "approval.resolved": (event) => `[approval ${event.decision}d]\n`,
  "artifact.ready": (event) => {
    const name = event.artifact.name ?? event.artifact.artifactId
    return `\n[artifact ready] ${name} (${event.artifact.mimeType})\n`
  },
  "session.created": (event) => renderAttachModelPill(event.model),
  "session.closed": () => "\n[session closed by daemon]\n",
}

/**
 * AUDIT-γ H2 — the `[session · <model>]` connection pill.
 *
 * SHARED by two producers: the wire `session.created` event renderer above, and
 * the SNAPSHOT-driven path the attach client now uses. The engine stopped
 * fanning `session.created` to the transport bridge ("snapshot is the source of
 * truth"), so a wire attach that settles its handshake purely on the snapshot
 * frame gets the model from `snapshot.state.modelSlug` and renders it HERE —
 * otherwise the pill (which model am I attached to?) is dead for `quanta
 * attach` and bot `connect()`.
 */
export const renderAttachModelPill = (modelSlug: string | undefined): string =>
  `[session ${modelSlug !== undefined && modelSlug !== "" ? `· ${modelSlug}` : "connected"}]\n`

export const renderSessionEvent = (event: SessionEvent): string => {
  const renderer = ATTACH_SESSION_EVENT_RENDERERS[event.type] as
    | ((event: SessionEvent) => string)
    | undefined
  return renderer?.(event) ?? ""
}
