import type { ImageBlock, Message } from "@/llm"

export interface SessionCommandEnvelope<TType extends string> {
  readonly sessionId: string
  readonly commandId: string
  readonly issuedAt: string
  readonly expectedRevision?: number
  readonly type: TType
}

export interface InputAppendCommand extends SessionCommandEnvelope<"input.append"> {
  readonly text: string
  readonly images?: readonly ImageBlock[]
}

export interface TurnRunCommand extends SessionCommandEnvelope<"turn.run"> {}

export interface TurnCancelCommand extends SessionCommandEnvelope<"turn.cancel"> {}

export interface SessionIdentitySetCommand extends SessionCommandEnvelope<"session.identity.set"> {
  readonly mode: string
}

export interface SessionToolProfileSetCommand
  extends SessionCommandEnvelope<"session.tool_profile.set"> {
  readonly profile: string
}

export interface SessionTranscriptReplaceCommand
  extends SessionCommandEnvelope<"session.transcript.replace"> {
  readonly messages: readonly Message[]
}

export interface ApprovalRespondCommand extends SessionCommandEnvelope<"approval.respond"> {
  readonly approvalId: string
  readonly decision: "approve" | "deny"
  /** ADR-0512 P3 — once-vs-session scope for an `approve` of a skill-scope
   *  ESCALATION approval: `once` ⇒ dispatch this call WITHOUT widening the skill
   *  scope (re-asked next time); `session`/absent ⇒ widen for the session. Only
   *  meaningful on an escalation approval (carries `scopeContext`); ignored on a
   *  normal approval ⇒ byte-identical. */
  readonly scope?: "once" | "session"
  /** ADR-0512 P3 — corrective steer for a `deny` of a skill-scope ESCALATION
   *  (the `deny_and_steer` verb): a non-empty message telling the model what to
   *  do instead. Absent ⇒ a plain decline. Ignored on a normal approval. */
  readonly steer?: string
}

export type SessionCommand =
  | InputAppendCommand
  | TurnRunCommand
  | TurnCancelCommand
  | SessionIdentitySetCommand
  | SessionTranscriptReplaceCommand
  | SessionToolProfileSetCommand
  | ApprovalRespondCommand

export const SESSION_COMMAND_TYPES = [
  "approval.respond",
  "input.append",
  "session.identity.set",
  "session.transcript.replace",
  "session.tool_profile.set",
  "turn.cancel",
  "turn.run",
] as const

export type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[number]

export const isSessionCommandType = (value: unknown): value is SessionCommandType =>
  typeof value === "string" && (SESSION_COMMAND_TYPES as readonly string[]).includes(value)
