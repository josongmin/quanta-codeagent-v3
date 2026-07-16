/**
 * stdin-line / approval-answer → SessionCommand builders (PURE).
 *
 * Mirrors the frontend's send shape (`apps/web-frontend`): a typed line becomes
 * TWO commands — `input.append{text}` then `turn.run` — each with a distinct
 * `commandId` so the daemon's command-dedup window never collapses them. Blank
 * lines yield no commands (the daemon rejects an empty turn anyway; we avoid the
 * round-trip). Approval answers map y→approve / everything-else→deny (fail-safe
 * for a dangerous op awaiting confirmation).
 *
 * S1 (jul-16 SDK ticket 01): command ASSEMBLY is no longer hand-rolled here —
 * this module now maps attach's line/answer semantics onto the hoisted
 * protocol-slice builder SSOT (`@/protocol/session/builders`), which owns the
 * wire shape. The attach-flavored injection points (`newCommandId`/`issuedAt`
 * callables) ride the builders' explicit `meta` overrides, so the clock
 * fallback below is never consulted on these paths.
 */

import {
  type ApprovalRespondCommand,
  buildApprovalRespond,
  buildInputAppend,
  buildTurnRun,
  type CommandBuildDeps,
  type SessionCommand,
} from "@/protocol/session"

/** Fallback clock for {@link CommandBuildDeps}. Attach always supplies an
 *  explicit `issuedAt` via builder meta, so this is dormant by construction —
 *  it exists because the deps shape (rightly) demands a clock. */
const SYSTEM_CLOCK: CommandBuildDeps["clock"] = { now: () => new Date() }

const buildDeps = (sessionId: string): CommandBuildDeps => ({
  sessionId,
  clock: SYSTEM_CLOCK,
})

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
  const deps = buildDeps(args.sessionId)
  return [
    // NOTE: the UNtrimmed line rides the wire (trim is only the blank check) —
    // byte-identical to the pre-hoist assembly.
    buildInputAppend(deps, args.line, {
      commandId: args.newCommandId(),
      issuedAt: args.issuedAt(),
    }),
    buildTurnRun(deps, { commandId: args.newCommandId(), issuedAt: args.issuedAt() }),
  ]
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
): ApprovalRespondCommand =>
  buildApprovalRespond(
    buildDeps(args.sessionId),
    args.approvalId,
    isAffirmative(args.answer) ? "approve" : "deny",
    { commandId: args.commandId, issuedAt: args.issuedAt },
  )
