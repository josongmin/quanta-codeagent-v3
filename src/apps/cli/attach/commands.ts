/**
 * stdin-line / approval-answer → SessionCommand builders (PURE).
 *
 * Mirrors the frontend's send shape (`apps/web-frontend`): a typed line becomes
 * TWO commands — `input.append{text}` then `turn.run` — each with a distinct
 * `commandId` so the daemon's command-dedup window never collapses them. Blank
 * lines yield no commands (the daemon rejects an empty turn anyway; we avoid the
 * round-trip). Approval answers map y→approve / everything-else→deny (fail-safe
 * for a dangerous op awaiting confirmation).
 */

import type { ApprovalRespondCommand, SessionCommand } from "@/protocol/session"

export interface BuildLineCommandsArgs {
  readonly sessionId: string
  readonly line: string
  /** Fresh, unique command id per call — caller supplies (e.g. `crypto.randomUUID`). */
  readonly newCommandId: () => string
  /** ISO timestamp source — caller supplies (e.g. `() => new Date().toISOString()`). */
  readonly issuedAt: () => string
}

/**
 * Build the `input.append` + `turn.run` pair for a typed line, or an empty
 * array when the line is blank/whitespace-only.
 */
export const buildLineCommands = (args: BuildLineCommandsArgs): readonly SessionCommand[] => {
  const text = args.line.trim()
  if (text.length === 0) return []
  const append: SessionCommand = {
    sessionId: args.sessionId,
    commandId: args.newCommandId(),
    issuedAt: args.issuedAt(),
    type: "input.append",
    text: args.line,
  }
  const run: SessionCommand = {
    sessionId: args.sessionId,
    commandId: args.newCommandId(),
    issuedAt: args.issuedAt(),
    type: "turn.run",
  }
  return [append, run]
}

export interface BuildApprovalRespondArgs {
  readonly sessionId: string
  readonly approvalId: string
  /** Raw operator answer (`"y"` / `"yes"` ⇒ approve; anything else ⇒ deny). */
  readonly answer: string
  readonly commandId: string
  readonly issuedAt: string
}

const isAffirmative = (answer: string): boolean => {
  const a = answer.trim().toLowerCase()
  return a === "y" || a === "yes"
}

export const buildApprovalRespondCommand = (
  args: BuildApprovalRespondArgs,
): ApprovalRespondCommand => ({
  sessionId: args.sessionId,
  commandId: args.commandId,
  issuedAt: args.issuedAt,
  type: "approval.respond",
  approvalId: args.approvalId,
  decision: isAffirmative(args.answer) ? "approve" : "deny",
})
