import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
import type { SessionHostTurnEvent } from "@/kernel/session"
import type { ContentBlock, ImageBlock, Message } from "@/llm"
import type { PendingApprovalView } from "@/protocol/session"
import { persistTurn } from "@/runner/orchestrate/persist-turn"
import type { RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"
import type { SessionMeta } from "@/session"
import type { AgentEvent } from "@/stream"
import { ItemStreamProjector } from "@/stream"
import { toSessionHostTurnEvent } from "../session-host-turn-event-bridge"
import { approvalPlaceholderOutcome, isRuntimeApprovalRequiredError } from "./approval-support"
import { buildAgentConfigFromBase, buildAgentConfigFromBaseInput, getSessionId } from "./base"
import type { RuntimeBase } from "./types"

export interface RuntimeTurnResult {
  readonly outcome: AgentOutcome
  readonly messages: Message[]
  readonly approvalRequest?: PendingApprovalView
  readonly errorMessage?: string
}

const extractTurnErrorMessage = (event: AgentEvent): string | undefined =>
  event.type === "error" && event.message.length > 0 ? event.message : undefined

export const createTurnStreamPort = (args: {
  readonly baseStream: AgentConfig["stream"]
  readonly onEvent?: (event: SessionHostTurnEvent) => void
  /** T01 — when true, a fresh per-turn item-stream projector forwards `item.*`
   *  carriers to `onEvent` alongside the 1:1 bridge. Default-OFF byte-identical. */
  readonly itemStream?: boolean
}): {
  readonly stream: AgentConfig["stream"]
  readonly getLastErrorMessage: () => string | undefined
} => {
  let lastErrorMessage: string | undefined
  // Per-turn projector instance (stateful across the turn's events). Only minted
  // when the gate is on AND a consumer (`onEvent`) exists — otherwise no work.
  const itemProjector =
    args.itemStream === true && args.onEvent !== undefined ? new ItemStreamProjector() : undefined
  return {
    stream: {
      emit(event: AgentEvent): void {
        const errorMessage = extractTurnErrorMessage(event)
        if (errorMessage !== undefined) lastErrorMessage = errorMessage
        const sessionEvent = toSessionHostTurnEvent(event)
        if (sessionEvent !== undefined) args.onEvent?.(sessionEvent)
        // T01 — fan the item cores derived from THIS event onto the session wire.
        // Emitted AFTER the 1:1 bridge event so e.g. a tool's `tool.invoked`
        // precedes its `item.started` (stable causal order).
        if (itemProjector !== undefined) {
          for (const item of itemProjector.project(event)) {
            args.onEvent?.({ type: "item.stream", item })
          }
        }
        args.baseStream.emit(event)
      },
    },
    getLastErrorMessage: () => lastErrorMessage,
  }
}

const buildRuntimeTurnArgs = (args: {
  readonly base: RuntimeBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
  readonly history: readonly Message[]
  readonly prompt: string
  readonly images?: readonly ImageBlock[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly signal?: AbortSignal
  readonly onEvent?: (event: SessionHostTurnEvent) => void
}) => ({
  base: args.base,
  ...(args.turnAssembler !== undefined ? { turnAssembler: args.turnAssembler } : {}),
  history: [...args.history],
  prompt: args.prompt,
  ...(args.images !== undefined && args.images.length > 0 ? { images: [...args.images] } : {}),
  state: args.state,
  idMeta: args.idMeta,
  ...(args.signal !== undefined ? { signal: args.signal } : {}),
  ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
})

export const toSessionHostTurnResult = (result: RuntimeTurnResult) =>
  result.approvalRequest !== undefined
    ? {
        outcome: result.outcome,
        messages: result.messages,
        approvalRequest: result.approvalRequest,
        ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      }
    : {
        outcome: result.outcome,
        messages: result.messages,
        ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      }

export const runRuntimeTurn = async (args: {
  readonly base: RuntimeBase
  readonly turnAssembler?: RuntimeAgentTurnAssembler
  readonly history: readonly Message[]
  readonly prompt: string
  readonly images?: readonly ImageBlock[]
  readonly state: string | undefined
  readonly idMeta: SessionMeta | undefined
  readonly signal?: AbortSignal
  readonly onEvent?: (event: SessionHostTurnEvent) => void
}): Promise<RuntimeTurnResult> => {
  const turnStream = createTurnStreamPort({
    baseStream: args.base.stream,
    ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
    ...(args.base.itemStream === true ? { itemStream: true } : {}),
  })
  try {
    const content: ContentBlock[] = [{ type: "text", text: args.prompt }, ...(args.images ?? [])]
    const next = [...args.history, { role: "user", content } as Message]
    const outcome = await runAgent(
      buildAgentConfigFromBase(
        buildAgentConfigFromBaseInput({
          base: {
            ...args.base,
            stream: turnStream.stream,
          },
          messages: next,
          signal: args.signal,
          turnAssembler: args.turnAssembler,
        }),
      ),
    )
    const messages = outcome.messages
    const errorMessage = turnStream.getLastErrorMessage()
    await persistTurn({
      state: args.state,
      idMeta: args.idMeta,
      sessionId: getSessionId(args.base),
      messages,
      outcome,
    })
    return {
      outcome,
      messages,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    }
  } catch (error) {
    if (isRuntimeApprovalRequiredError(error)) {
      return {
        outcome: approvalPlaceholderOutcome(args.history),
        messages: [...args.history],
        approvalRequest: error.approval,
      }
    }
    throw error
  }
}

export { buildRuntimeTurnArgs }
