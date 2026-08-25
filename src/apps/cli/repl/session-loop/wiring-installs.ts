import type { Message } from "@/llm"
import type { ObjectivePort } from "@/objective"
import { loadSessionById, type SessionMeta } from "@/session"
import { errMessage, logger } from "@/shared"
import type { PlaybookPlanQueueSink } from "@/skill/playbook"
import type { ConvCheckpointWire } from "../conv-checkpoint-wire"
import type { ExternalPromptQueue } from "../external-prompt-queue"
import type { GoalWakeSignalSlot } from "../goal-wake-signal"
import type { PlaybookTriggerSurfaceSeam } from "../playbook-trigger-surface-seam"
import {
  maybeStartPlaybookTriggerWire,
  type PlaybookTriggerWireHandle,
} from "../playbook-trigger-wire"
import { performSessionSwitch, type SessionSwitchReceipt } from "./session-switch"

/** ADR-0292 — install the `/rewind-conv` swap closure so the slash can mutate
 *  the live history binding the loop reads each turn. No-throw on the swap;
 *  a failure surfaces via logger.warn (already wrapped in the surface-compose
 *  adapter — this is the inner closure the adapter delegates to). The caller
 *  threads its live `session.transcript.replace` as `replaceTranscript` (kept
 *  a callback so the helper never couples to the full facade session type). */
export const installHistoryReplaceWire = (args: {
  readonly registerReplaceMessages:
    | ((fn: (msgs: ReadonlyArray<Message>) => Promise<void>) => void)
    | undefined
  readonly replaceTranscript: (msgs: ReadonlyArray<Message>) => Promise<readonly Message[]>
  readonly commitHistory: (history: readonly Message[]) => void
}): void => {
  const { registerReplaceMessages, replaceTranscript, commitHistory } = args
  if (registerReplaceMessages === undefined) return
  registerReplaceMessages(async (msgs: ReadonlyArray<Message>): Promise<void> => {
    const nextHistory = await replaceTranscript(msgs)
    commitHistory(nextHistory)
  })
}

/** UUX-4-07 — install the `/fork` switch closure. THROWS propagate to `/fork`
 *  (fail-loud): the kernel reducer's `transcript_replace_unavailable` guard
 *  refuses a mid-turn switch, and any earlier failure leaves surface state +
 *  the persist identity untouched (ordering pinned in session-switch tests).
 *  `idMeta` is the SAME object reference the facade persists through
 *  (`createRuntimeFacade` above) — `performSessionSwitch` repoints it in
 *  place so the NEXT persist writes under the fork id, never clobbering the
 *  parent transcript with the fork's truncated history. */
export const installSessionSwitchWire = (args: {
  readonly registerSessionSwitch:
    | ((fn: (sessionId: string) => Promise<SessionSwitchReceipt>) => void)
    | undefined
  readonly replaceTranscript: (msgs: readonly Message[]) => Promise<readonly Message[]>
  readonly idMeta: SessionMeta | undefined
  readonly commitSwitch: (next: { sessionId: string; history: readonly Message[] }) => void
  readonly currentSessionId?: (() => string | undefined) | undefined
  readonly objectiveStore?: ObjectivePort | undefined
  readonly goalWakeSlot?: GoalWakeSignalSlot | undefined
}): void => {
  const { registerSessionSwitch, replaceTranscript, idMeta, commitSwitch } = args
  if (registerSessionSwitch === undefined) return
  registerSessionSwitch(
    async (newSessionId: string): Promise<SessionSwitchReceipt> =>
      await performSessionSwitch(
        {
          loadSession: loadSessionById,
          replaceTranscript,
          idMeta,
          currentSessionId: args.currentSessionId ?? (() => idMeta?.id),
          objectiveStore: args.objectiveStore,
          goalWakeSlot: args.goalWakeSlot,
          commit: ({ sessionId, history }) => {
            commitSwitch({ sessionId, history })
          },
        },
        newSessionId,
      ),
  )
}

/** ADR-0292 — turn-end record helper. No-op when the wire is null/absent so
 *  the legacy code path is byte-identical (RFC §1.2). Defensive try/catch so
 *  a misbehaving store NEVER bubbles into the loop. */
export const recordTurnSnapshot = (
  convCheckpointWire: ConvCheckpointWire | null | undefined,
  msgs: readonly Message[],
): void => {
  if (convCheckpointWire === undefined || convCheckpointWire === null) return
  try {
    convCheckpointWire.recordTurn(msgs)
  } catch (e) {
    logger.warn(`conv-checkpoint recordTurn threw: ${errMessage(e)}`)
  }
}

/** ADR-0293 — playbook trigger lifecycle attach. The wire helper itself
 *  implements the env/flag precedence + NOOP-handle short-circuit, so we
 *  can call it unconditionally; only an active opt-in actually allocates
 *  a watcher. Attach to the seam so /session finalize → seam.detach()
 *  stops the handle even on abnormal shutdown. */
export const attachPlaybookHandle = (args: {
  readonly playbookSeam: PlaybookTriggerSurfaceSeam | undefined
  readonly playbookCliFlag: boolean | undefined
  readonly threadId: string
  readonly externalPromptQueue: ExternalPromptQueue
}): PlaybookTriggerWireHandle | undefined => {
  const { playbookSeam, playbookCliFlag, threadId, externalPromptQueue } = args
  if (playbookSeam === undefined) return undefined
  const playbookSink: PlaybookPlanQueueSink = {
    enqueue: (input) => {
      try {
        externalPromptQueue.push(input.text)
        return { ok: true }
      } catch (e) {
        return {
          ok: false,
          reason: errMessage(e),
        }
      }
    },
  }
  const handle = maybeStartPlaybookTriggerWire({
    env: process.env,
    ...(playbookCliFlag !== undefined ? { cliFlag: playbookCliFlag } : {}),
    threadId,
    planQueueSink: playbookSink,
  })
  playbookSeam.attach(handle)
  return handle
}
