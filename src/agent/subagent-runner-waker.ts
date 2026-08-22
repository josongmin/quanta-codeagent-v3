import { SubagentTurnGate } from "@/subagent"
import type { ConversationActionPort } from "./conversation-action"
import { createConversationActionSurface } from "./conversation-action-surface"
import {
  type ChildControlSurface,
  createChildControlEndpoint,
  createChildControlSurface,
} from "./subagent-control-endpoint"
import type { SubagentControlEndpoint, SubagentSteerSubmission } from "./subagent-delivery/ports"
import type { AgentConfig } from "./types"

const CHILD_STEER_QUEUE_CAPACITY = 8
const CHILD_STEER_MAX_INPUT_BYTES = 8192

export interface ChildControlWiring {
  readonly conversationActionPort?: ConversationActionPort
  readonly activeTurnRef?: NonNullable<AgentConfig["activeTurnRef"]>
  readonly steerSurface: ChildControlSurface
  readonly childSteerDrain?: NonNullable<AgentConfig["childSteerDrain"]>
  readonly steerFinalization?: NonNullable<AgentConfig["steerFinalization"]>
}

export const registerChildWaker = (
  parent: AgentConfig,
  taskId: string | undefined,
  mailboxLabel: string,
): { gate: SubagentTurnGate; control: ChildControlWiring; dispose: () => void } | undefined => {
  const wake = parent.subagentTurnWake
  if (wake === undefined || taskId === undefined) return undefined
  const gate = new SubagentTurnGate()
  const actionSurface = createConversationActionSurface()
  const steerSurface = createChildControlSurface({
    steerConfig: { maxInputBytes: CHILD_STEER_MAX_INPUT_BYTES },
    capacity: CHILD_STEER_QUEUE_CAPACITY,
  })
  const endpoint: SubagentControlEndpoint = createChildControlEndpoint({
    gate,
    surface: steerSurface,
    activeTurnRef: actionSurface.activeTurnRef,
    mailboxLabel,
    wake: (reason: string) => gate.wake(reason),
  })
  const unregister = wake.registerEndpoint(taskId, endpoint)
  const steerPlane = parent.subagent?.steerPlane
  const steerWiring =
    steerPlane !== undefined
      ? {
          childSteerDrain: {
            drainSteers: (): readonly SubagentSteerSubmission[] => steerSurface.drainSteers(),
            pendingSteers: (): number => steerSurface.pendingSteers(),
          },
          steerFinalization: steerPlane.finalization,
        }
      : {}
  return {
    gate,
    control: {
      steerSurface,
      ...(steerPlane !== undefined
        ? {
            conversationActionPort: actionSurface.port,
            activeTurnRef: actionSurface.activeTurnRef,
          }
        : {}),
      ...steerWiring,
    },
    dispose: (): void => {
      unregister()
      gate.dispose()
      if (steerPlane !== undefined) {
        for (const s of steerSurface.drainSteers()) {
          steerPlane.finalization.finalizeCancelled(s.deliveryId, "session_aborted")
        }
      }
    },
  }
}
