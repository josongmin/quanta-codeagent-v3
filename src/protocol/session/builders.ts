/**
 * SessionCommand builders — the protocol-slice SSOT (S1, jul-16 SDK ticket 01).
 *
 * MOVED (not copied) from `src/sdk/runtime/session/commands.ts`, where these
 * were already a pure leaf; the second hand-rolled copy in
 * `src/apps/cli/attach` now consumes THESE builders too, so a command's wire
 * shape (id minting, `issuedAt` stamping, optional-field spreading) has exactly
 * one definition. Living in `@/protocol/session` keeps them importable by every
 * layer (sdk runtime, ipc clients, app surfaces) without an up-import.
 */

import type { ImageBlock, Message } from "@/llm/types"
import type { ObjectiveMutation } from "@/objective"
import type { PosturePatch } from "@/permission/posture/types"
import type {
  ApprovalRespondCommand,
  InputAppendCommand,
  PostureCommandScope,
  SessionIdentitySetCommand,
  SessionObjectiveMutateCommand,
  SessionPermissionSetCommand,
  SessionPostureSetCommand,
  SessionToolProfileSetCommand,
  SessionTranscriptReplaceCommand,
  TurnCancelCommand,
  TurnRunCommand,
} from "./commands"

/** Structural clock the builders stamp `issuedAt` from. Deliberately defined
 *  HERE (protocol is a leaf slice): the kernel's `KernelClock` satisfies it
 *  structurally, but the protocol slice must not reach into `@/kernel`. */
export interface CommandBuilderClock {
  now(): Date
}

/**
 * Pure command-builder deps: the immutable identity of the session plus the
 * clock used to stamp `issuedAt`. None of these builders touch any mutable
 * runtime state, so they live as module-level helpers.
 */
export interface CommandBuildDeps {
  readonly sessionId: string
  readonly clock: CommandBuilderClock
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

/**
 * B-MED-7 — SSOT derivation of the daemon-owned post-approval CONTINUATION's
 * `commandId` from the originating `approvalId`. DETERMINISTIC so a marker-aware
 * wire client can PREDICT the continuation's `commandId` from the
 * `approval.resolved` event alone (it never observes the daemon's outbound
 * command; the kernel echoes only `commandId` onto the `turn.started`). Both
 * the daemon (which mints the id) and the correlator (which arms the expected
 * id) call THIS one function, so the prediction can never drift.
 */
export const continuationCommandIdForApproval = (approvalId: string): string =>
  `approval-continuation:${approvalId}`

export const buildTurnRun = (
  deps: CommandBuildDeps,
  meta: Partial<Omit<TurnRunCommand, "sessionId" | "type">> | undefined,
): TurnRunCommand => ({
  sessionId: deps.sessionId,
  type: "turn.run",
  ...commandMeta(deps, meta),
  // B-MED-7 — forward the daemon continuation's originating approvalId
  // (additive; a bare turn.run omits it ⇒ byte-identical).
  ...(meta?.causedByApprovalId !== undefined
    ? { causedByApprovalId: meta.causedByApprovalId }
    : {}),
})

/** S1 — `turn.cancel` builder. The command has existed in the protocol's
 *  8-command union all along (commands.ts) and attach was hand-assembling it;
 *  this gives it the same SSOT treatment as its siblings. */
export const buildTurnCancel = (
  deps: CommandBuildDeps,
  meta: Partial<Omit<TurnCancelCommand, "sessionId" | "type">> | undefined,
): TurnCancelCommand => ({
  sessionId: deps.sessionId,
  type: "turn.cancel",
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

/**
 * RFC-03 C3 — build a `session.objective.mutate` command carrying ONE closed
 * {@link ObjectiveMutation}. `meta.expectedObjectiveRevision` is the OBJECTIVE-
 * domain CAS target (distinct from the envelope's session-level
 * `expectedRevision`); a stale multi-surface edit is rejected by the host
 * authority. The actor + objective thread are bound by the HOST, never carried
 * on the wire.
 */
export const buildObjectiveMutate = (
  deps: CommandBuildDeps,
  mutation: ObjectiveMutation,
  meta: Partial<Omit<SessionObjectiveMutateCommand, "sessionId" | "type" | "mutation">> | undefined,
): SessionObjectiveMutateCommand => ({
  sessionId: deps.sessionId,
  type: "session.objective.mutate",
  mutation,
  ...(meta?.expectedObjectiveRevision !== undefined
    ? { expectedObjectiveRevision: meta.expectedObjectiveRevision }
    : {}),
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

/**
 * RFC-05 E4 — build a `session.posture.set` command carrying ONE lossless
 * {@link PosturePatch}, the target {@link PostureCommandScope} (current-thread
 * vs future-thread default), and (optionally)
 * `meta.expectedPostureRevision` — the POSTURE-domain CAS target, DISTINCT from
 * the envelope's session-level `expectedRevision`. A stale multi-surface edit is
 * rejected by the host authority. The actor is bound by the HOST to `user`
 * (a surface-issued command is an operator action, never trusted from the wire).
 */
export const buildPostureSet = (
  deps: CommandBuildDeps,
  patch: PosturePatch,
  scope: PostureCommandScope,
  meta:
    | Partial<Omit<SessionPostureSetCommand, "sessionId" | "type" | "patch" | "scope">>
    | undefined,
): SessionPostureSetCommand => ({
  sessionId: deps.sessionId,
  type: "session.posture.set",
  patch,
  scope,
  ...(meta?.expectedPostureRevision !== undefined
    ? { expectedPostureRevision: meta.expectedPostureRevision }
    : {}),
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
