/**
 * Fork-session adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Wraps a `ConversationCheckpointStore` + `defaultForker` (ADR-0226)
 * into the `ForkSessionSlashState` shape the `/fork-checkpoint` slash
 * reads. The composition root supplies the active session id when one
 * exists. Absent ports ⇒ slot omitted (default-OFF). All methods
 * surface contract failures through the port's typed `Result`; never
 * throws.
 */

import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { defaultForker, defaultSessionForker, type ForkSessionPort } from "@/agent/fork-session"
import type { ForkSessionSlashState } from "../../fork-checkpoint-cmd"

export interface ForkSessionAdapterArgs {
  readonly conversationStore: ConversationCheckpointStore
  readonly activeSessionId?: string
}

export interface ForkSessionAdapter extends ForkSessionSlashState {}

/** Build the fork-session adapter. Composes `defaultSessionForker` over
 *  the store with the rich `defaultForker` (no shadow-ODB tagging at
 *  this layer — the composition root may opt in by passing its own
 *  port and bypassing this helper). */
export const buildForkSessionAdapter = (args: ForkSessionAdapterArgs): ForkSessionAdapter => {
  const base = defaultSessionForker(args.conversationStore)
  const port: ForkSessionPort = defaultForker({ base })
  return args.activeSessionId !== undefined
    ? { port, activeSessionId: args.activeSessionId }
    : { port }
}
