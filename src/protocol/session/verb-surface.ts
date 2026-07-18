/**
 * `SessionVerbSurface<R>` — the ONE generic verb surface of session.v1
 * (S2a, jul-16 transport-unified SDK ticket 01; design SSOT: MASTER §3.1).
 *
 * WHY generic instead of `extends`: the wire cannot reproduce
 * `SessionDispatchResult` synchronously (there is no completion frame), so
 * "the interfaces are the same" is proven by parameterizing the RESULT GRADE:
 *
 *   - in-process `RuntimeSession`  satisfies SessionVerbSurface<SessionDispatchResult>
 *   - wire `SessionHandle`         implements SessionVerbSurface<CommandReceipt>
 *
 * Every verb name + argument shape below is derived from the PROTOCOL command
 * types (`./commands`) — deliberately NOT from `RuntimeSession` (which lives
 * in `@/sdk/runtime`, an up-import this leaf slice must never take, and whose
 * trailing `options?: SessionDispatchOptions` parameters are absorbed by
 * standard function-assignability; S0 spike ruling #1, 2026-07-16).
 *
 * The compile-time pins proving both directions live in
 * `src/sdk/runtime/handle-adapter.ts` (the one src location that may see both
 * `RuntimeSession` and this type) — placed in src/ because `bun test` does not
 * typecheck test files, so a pin in tests/ would be locally inert (only CI's
 * `typecheck:all` would see it); `tsconfig.typecheck.src.json` covers src/.
 */

import type { ImageBlock, Message } from "@/llm/types"
import type {
  ApprovalRespondCommand,
  InputAppendCommand,
  SessionIdentitySetCommand,
  SessionPermissionSetCommand,
  SessionToolProfileSetCommand,
  SessionTranscriptReplaceCommand,
  TurnCancelCommand,
  TurnRunCommand,
} from "./commands"

/**
 * The wire verb receipt (MASTER §3.2 — "submitted", nothing more). A verb
 * resolving `{commandId, submitted: true}` promises ONLY that the command was
 * handed to the transport; there is no success-ack frame in session.v1, so
 * server-side rejection arrives asynchronously (`onCommandRejected` /
 * a correlated `awaitTurnEnd` rejection). `submitted` is the literal `true` —
 * a receipt is never minted for a command that failed to leave the client.
 */
export interface CommandReceipt {
  readonly commandId: string
  readonly submitted: true
}

/**
 * The verb surface. `R` is the result grade: `SessionDispatchResult` for the
 * in-process runtime (full events/revision/turn payload), `CommandReceipt`
 * for wire handles (submission-only truth).
 */
export interface SessionVerbSurface<R> {
  readonly input: {
    append(
      text: string,
      meta?: Partial<Omit<InputAppendCommand, "sessionId" | "type" | "text" | "images">> & {
        readonly images?: readonly ImageBlock[]
      },
    ): Promise<R>
  }
  readonly turn: {
    run(meta?: Partial<Omit<TurnRunCommand, "sessionId" | "type">>): Promise<R>
    cancel(meta?: Partial<Omit<TurnCancelCommand, "sessionId" | "type">>): Promise<R>
  }
  readonly identity: {
    set(
      mode: string,
      meta?: Partial<Omit<SessionIdentitySetCommand, "sessionId" | "type" | "mode">>,
    ): Promise<R>
  }
  readonly toolProfile: {
    set(
      profile: string,
      meta?: Partial<Omit<SessionToolProfileSetCommand, "sessionId" | "type" | "profile">>,
    ): Promise<R>
  }
  readonly permission: {
    set(
      mode: string,
      meta?: Partial<Omit<SessionPermissionSetCommand, "sessionId" | "type" | "mode">>,
    ): Promise<R>
  }
  readonly approval: {
    respond(
      approvalId: string,
      decision: "approve" | "deny",
      meta?: Partial<
        Omit<ApprovalRespondCommand, "sessionId" | "type" | "approvalId" | "decision">
      >,
    ): Promise<R>
  }
  readonly transcript: {
    replace(
      messages: readonly Message[],
      meta?: Partial<Omit<SessionTranscriptReplaceCommand, "sessionId" | "type" | "messages">>,
    ): Promise<R>
  }
}
