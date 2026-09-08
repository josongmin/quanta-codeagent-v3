/**
 * Wire verb table for `createSessionHandle`. Extracted so handle.ts stays
 * under the 900-line cohort while C-F2 adds objective/posture/skill verbs.
 */

import type { SessionCommand, SessionVerbSurface } from "@/protocol/session"
import {
  buildApprovalRespond,
  buildIdentitySet,
  buildInputAppend,
  buildObjectiveMutate,
  buildPermissionSet,
  buildPostureSet,
  buildSkillSetEnabled,
  buildToolProfileSet,
  buildTranscriptReplace,
  buildTurnCancel,
  buildTurnRun,
  type CommandBuildDeps,
  type CommandReceipt,
} from "@/protocol/session"

type WireCorrelator = {
  begin(commandId: string): void
  rejectCommand(commandId: string, error: unknown): void
}

export const buildWireVerbSurface = (args: {
  readonly deps: CommandBuildDeps
  readonly submit: (command: SessionCommand) => Promise<CommandReceipt>
  readonly mintId: (meta: { readonly commandId?: string } | undefined) => string
  readonly correlator: WireCorrelator
  readonly guardOpen: () => void
}): SessionVerbSurface<CommandReceipt> => {
  const { deps, submit, mintId, correlator, guardOpen } = args
  return {
    input: {
      append: (text, meta) =>
        submit(buildInputAppend(deps, text, { ...meta, commandId: mintId(meta) })),
    },
    turn: {
      async run(meta) {
        guardOpen()
        const commandId = mintId(meta)
        correlator.begin(commandId)
        try {
          return await submit(buildTurnRun(deps, { ...meta, commandId }))
        } catch (error) {
          correlator.rejectCommand(commandId, error)
          throw error
        }
      },
      cancel: (meta) => submit(buildTurnCancel(deps, { ...meta, commandId: mintId(meta) })),
    },
    identity: {
      set: (mode, meta) =>
        submit(buildIdentitySet(deps, mode, { ...meta, commandId: mintId(meta) })),
    },
    toolProfile: {
      set: (profile, meta) =>
        submit(buildToolProfileSet(deps, profile, { ...meta, commandId: mintId(meta) })),
    },
    permission: {
      set: (mode, meta) =>
        submit(buildPermissionSet(deps, mode, { ...meta, commandId: mintId(meta) })),
    },
    objective: {
      mutate: (mutation, meta) =>
        submit(buildObjectiveMutate(deps, mutation, { ...meta, commandId: mintId(meta) })),
    },
    posture: {
      set: (patch, scope, meta) =>
        submit(buildPostureSet(deps, patch, scope, { ...meta, commandId: mintId(meta) })),
    },
    skill: {
      setEnabled: (name, enabled, meta) =>
        submit(buildSkillSetEnabled(deps, name, enabled, { ...meta, commandId: mintId(meta) })),
    },
    approval: {
      respond: (approvalId, decision, meta) =>
        submit(
          buildApprovalRespond(deps, approvalId, decision, { ...meta, commandId: mintId(meta) }),
        ),
    },
    transcript: {
      replace: (messages, meta) =>
        submit(buildTranscriptReplace(deps, messages, { ...meta, commandId: mintId(meta) })),
    },
  }
}
