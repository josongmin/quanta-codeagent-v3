import type { KernelDispatchContext } from "@/kernel/session"
import type { ImageBlock, Message } from "@/llm"
import type {
  ApprovalRespondCommand,
  InputAppendCommand,
  SessionIdentitySetCommand,
  SessionPermissionSetCommand,
  SessionToolProfileSetCommand,
  SessionTranscriptReplaceCommand,
  TurnRunCommand,
} from "@/protocol/session"

/**
 * Pure command-builder deps: the immutable identity of the session plus the
 * clock used to stamp `issuedAt`. None of these builders touch the session's
 * mutable runtime state, so they live as module-level helpers.
 */
export interface CommandBuildDeps {
  readonly sessionId: string
  readonly clock: KernelDispatchContext["clock"]
}

export const commandMeta = <
  T extends { commandId: string; issuedAt: string; expectedRevision?: number },
>(
  deps: CommandBuildDeps,
  meta: Partial<T> | undefined,
): T =>
  ({
    commandId: meta?.commandId ?? crypto.randomUUID(),
    issuedAt: meta?.issuedAt ?? deps.clock.now().toISOString(),
    ...(meta?.expectedRevision !== undefined ? { expectedRevision: meta.expectedRevision } : {}),
  }) as T

export const buildInputAppend = (
  deps: CommandBuildDeps,
  text: string,
  meta:
    | (Partial<Omit<InputAppendCommand, "sessionId" | "type" | "text" | "images">> & {
        readonly images?: readonly ImageBlock[]
      })
    | undefined,
): InputAppendCommand => ({
  sessionId: deps.sessionId,
  type: "input.append",
  text,
  ...commandMeta(deps, meta),
  ...(meta?.images !== undefined && meta.images.length > 0 ? { images: meta.images } : {}),
})

export const buildTurnRun = (
  deps: CommandBuildDeps,
  meta: Partial<Omit<TurnRunCommand, "sessionId" | "type">> | undefined,
): TurnRunCommand => ({
  sessionId: deps.sessionId,
  type: "turn.run",
  ...commandMeta(deps, meta),
})

export const buildIdentitySet = (
  deps: CommandBuildDeps,
  mode: string,
  meta: Partial<Omit<SessionIdentitySetCommand, "sessionId" | "type" | "mode">> | undefined,
): SessionIdentitySetCommand => ({
  sessionId: deps.sessionId,
  type: "session.identity.set",
  mode,
  ...commandMeta(deps, meta),
})

export const buildToolProfileSet = (
  deps: CommandBuildDeps,
  profile: string,
  meta: Partial<Omit<SessionToolProfileSetCommand, "sessionId" | "type" | "profile">> | undefined,
): SessionToolProfileSetCommand => ({
  sessionId: deps.sessionId,
  type: "session.tool_profile.set",
  profile,
  ...commandMeta(deps, meta),
})

export const buildPermissionSet = (
  deps: CommandBuildDeps,
  mode: string,
  meta: Partial<Omit<SessionPermissionSetCommand, "sessionId" | "type" | "mode">> | undefined,
): SessionPermissionSetCommand => ({
  sessionId: deps.sessionId,
  type: "session.permission.set",
  mode,
  ...commandMeta(deps, meta),
})

export const buildApprovalRespond = (
  deps: CommandBuildDeps,
  approvalId: string,
  decision: "approve" | "deny",
  meta:
    | Partial<Omit<ApprovalRespondCommand, "sessionId" | "type" | "approvalId" | "decision">>
    | undefined,
): ApprovalRespondCommand => ({
  sessionId: deps.sessionId,
  type: "approval.respond",
  approvalId,
  decision,
  // ADR-0512 P3 — `commandMeta` only forwards envelope fields (commandId /
  // issuedAt / expectedRevision); the escalation's scope/steer must be
  // forwarded explicitly so the once/session + steer verbs reach the host.
  ...(meta?.scope !== undefined ? { scope: meta.scope } : {}),
  ...(meta?.steer !== undefined ? { steer: meta.steer } : {}),
  ...commandMeta(deps, meta),
})

export const buildTranscriptReplace = (
  deps: CommandBuildDeps,
  messages: readonly Message[],
  meta:
    | Partial<Omit<SessionTranscriptReplaceCommand, "sessionId" | "type" | "messages">>
    | undefined,
): SessionTranscriptReplaceCommand => ({
  sessionId: deps.sessionId,
  type: "session.transcript.replace",
  messages: [...messages],
  ...commandMeta(deps, meta),
})
