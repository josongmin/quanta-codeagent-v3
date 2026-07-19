import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
import type { SessionHostTurnEvent } from "@/kernel/session"
import type { ContentBlock, ImageBlock, Message } from "@/llm"
import type { ArtifactRef, PendingApprovalView } from "@/protocol/session"
import { persistTurn } from "@/runner/orchestrate/persist-turn"
import type { RuntimeAgentTurnAssembler } from "@/sdk/runtime/base"
import type { SessionMeta } from "@/session"
import type { AgentEvent } from "@/stream"
import { ItemStreamProjector } from "@/stream"
import { drainNewArtifacts } from "../../artifact-drain"
import { toSessionHostTurnEvent } from "../session-host-turn-event-bridge"
import { approvalPlaceholderOutcome, isRuntimeApprovalRequiredError } from "./approval-support"
import { buildAgentConfigFromBase, buildAgentConfigFromBaseInput, getSessionId } from "./base"
import type { RuntimeBase } from "./types"

export interface RuntimeTurnResult {
  readonly outcome: AgentOutcome
  readonly messages: Message[]
  readonly approvalRequest?: PendingApprovalView
  readonly errorMessage?: string
  /** A2 — artifacts registered during THIS turn (drained from the session
   *  `artifactRegistry` via the per-session de-dup ledger). Absent when the store
   *  is off OR no new artifact was registered. `toSessionHostTurnResult` forwards
   *  it so the kernel scheduler emits one `artifact.ready` per ref. */
  readonly artifacts?: readonly ArtifactRef[]
}

const extractTurnErrorMessage = (event: AgentEvent): string | undefined =>
  event.type === "error" && event.message.length > 0 ? event.message : undefined

export const createTurnStreamPort = (args: {
  readonly baseStream: AgentConfig["stream"]
  readonly onEvent?: (event: SessionHostTurnEvent) => void
  /** T01 — when true, a fresh per-turn item-stream projector forwards `item.*`
   *  carriers to `onEvent` alongside the 1:1 bridge. Default-OFF byte-identical. */
  readonly itemStream?: boolean
  /** Ticket 04 — when true, the 1:1 bridge ALSO carries the full model-visible
   *  tool args/result (production gate; per-peer strip happens downstream in the
   *  ipc bridge). Default-OFF byte-identical. */
  readonly fullFidelity?: boolean
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
        // Base emit FIRST + verbatim — every existing consumer is byte-identical
        // (mirrors wireAgentStateTap in src/agent/optional-ports.ts).
        args.baseStream.emit(event)
        try {
          const sessionEvent = toSessionHostTurnEvent(event, {
            ...(args.fullFidelity === true ? { fullFidelity: true } : {}),
          })
          if (sessionEvent !== undefined) args.onEvent?.(sessionEvent)
          // T01 — fan the item cores derived from THIS event onto the session wire.
          // Emitted AFTER the 1:1 bridge event so e.g. a tool's `tool.invoked`
          // precedes its `item.started` (stable causal order).
          if (itemProjector !== undefined) {
            for (const item of itemProjector.project(event)) {
              args.onEvent?.({ type: "item.stream", item })
            }
          }
        } catch {
          // A throwing observer must never break the base emit (already done above)
          // or crash the turn — session-bridge fan-out is observation-only, fail-silent.
        }
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
  readonly emittedArtifactIds?: Set<string>
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
  ...(args.emittedArtifactIds !== undefined ? { emittedArtifactIds: args.emittedArtifactIds } : {}),
})

export const toSessionHostTurnResult = (result: RuntimeTurnResult) =>
  result.approvalRequest !== undefined
    ? {
        outcome: result.outcome,
        messages: result.messages,
        approvalRequest: result.approvalRequest,
        ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
        // A2 — forward drained artifacts so the kernel emits `artifact.ready`.
        ...(result.artifacts !== undefined ? { artifacts: result.artifacts } : {}),
      }
    : {
        outcome: result.outcome,
        messages: result.messages,
        ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
        ...(result.artifacts !== undefined ? { artifacts: result.artifacts } : {}),
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
  /** A2 — per-session artifact de-dup ledger (see {@link drainNewArtifacts}).
   *  Absent ⇒ a fresh empty set per turn (still correct within a turn); the
   *  session host threads ONE shared set so cross-turn de-dup holds. */
  readonly emittedArtifactIds?: Set<string>
}): Promise<RuntimeTurnResult> => {
  const turnStream = createTurnStreamPort({
    baseStream: args.base.stream,
    ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
    ...(args.base.itemStream === true ? { itemStream: true } : {}),
    ...(args.base.fullFidelity === true ? { fullFidelity: true } : {}),
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
    // A2 — drain artifacts registered during THIS turn into protocol refs. The
    // registry is present ONLY when `QUANTA_ARTIFACT_STORE` lifted it onto the
    // base; absent ⇒ `[]` ⇒ the `artifacts` field is omitted (byte-identical
    // default-OFF). The ledger de-dups across turns (see the session host).
    //
    // GUARD: only drain on a NON-error outcome. The kernel scheduler emits
    // `artifact.ready` ONLY from its completed-turn arm (`onTurnCompleted`) —
    // its error arm (`onTurnErrored`) ignores `result.artifacts`. Draining on an
    // errored turn would mark the artifacts "seen" in the ledger yet never emit
    // them, so a later completed turn could never re-surface them. Leaving them
    // undrained keeps them pending for the next completed turn (each ready once).
    const artifacts =
      outcome.reason === "error"
        ? []
        : drainNewArtifacts(
            args.base.artifactRegistry,
            args.emittedArtifactIds ?? new Set<string>(),
          )
    return {
      outcome,
      messages,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
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
