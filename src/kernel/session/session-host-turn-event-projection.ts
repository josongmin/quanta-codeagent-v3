import type { SessionEvent, SessionEventType } from "@/protocol/session"
import type { SessionHostTurnEvent, SessionHostTurnEventType } from "./ports"
import type { KernelSessionState } from "./state"
import { toSessionStateView } from "./state"

export const SESSION_HOST_TURN_EVENT_PROJECTION_SOURCE_TYPES = [
  "assistant_text.delta",
  "llm.request",
  "llm.continuation",
  "tool.invoked",
  "tool.progress",
  "tool.completed",
  "usage",
  "skill.scope.decision",
  "item.stream",
  "recovery",
  "context.compacted",
  "budget.breach",
] as const satisfies readonly SessionHostTurnEventType[]

export const SESSION_HOST_TURN_EVENT_PROJECTION_TARGET_TYPES = [
  "session.state.updated",
  "skill.scope.decision",
  "tool.completed",
  "tool.invoked",
  "tool.progress",
  "turn.llm.continuation",
  "turn.llm.request",
  "turn.output.delta",
  "turn.recovery",
  "item.started",
  "item.delta",
  "item.completed",
  "context.compacted",
  "budget.breach",
] as const satisfies readonly SessionEventType[]

interface ProjectionContext {
  readonly state: KernelSessionState
  readonly commandId: string
  readonly emittedAt: string
  readonly eventId?: string
}

type ProjectionArgs<K extends SessionHostTurnEventType> = ProjectionContext & {
  readonly event: Extract<SessionHostTurnEvent, { type: K }>
}

export interface SessionHostTurnEventProjectionResult {
  readonly state: KernelSessionState
  readonly emitted: SessionEvent
}

export type SessionHostTurnEventProjectionRegistry = {
  [K in SessionHostTurnEventType]: (args: ProjectionArgs<K>) => SessionHostTurnEventProjectionResult
}

const bumpSessionState = (
  state: KernelSessionState,
  patch: Omit<Partial<KernelSessionState>, "revision" | "seq">,
): KernelSessionState => ({
  ...state,
  ...patch,
  revision: state.revision + 1,
  seq: state.seq + 1,
})

const createEventBase = (args: ProjectionContext, nextState: KernelSessionState) => ({
  eventId: args.eventId ?? crypto.randomUUID(),
  seq: nextState.seq,
  revision: nextState.revision,
  emittedAt: args.emittedAt,
  causedByCommandId: args.commandId,
})

export const SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY = {
  "assistant_text.delta": (args) => {
    const nextText = `${args.state.transcript.streamingAssistantText ?? ""}${args.event.delta}`
    const nextState = bumpSessionState(args.state, {
      transcript: {
        ...args.state.transcript,
        streamingAssistantText: nextText,
      },
    })
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "turn.output.delta",
        delta: args.event.delta,
      },
    }
  },
  "llm.request": (args) => {
    const nextState = bumpSessionState(args.state, {
      lastLlmRequest: {
        model: args.event.model,
        ...(args.event.provider !== undefined ? { provider: args.event.provider } : {}),
        ...(args.event.surfaceId !== undefined ? { surfaceId: args.event.surfaceId } : {}),
        ...(args.event.transportId !== undefined ? { transportId: args.event.transportId } : {}),
        ...(args.event.authMode !== undefined ? { authMode: args.event.authMode } : {}),
        ...(args.event.policy !== undefined ? { policy: args.event.policy } : {}),
      },
    })
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "turn.llm.request",
        model: args.event.model,
        ...(args.event.provider !== undefined ? { provider: args.event.provider } : {}),
        ...(args.event.surfaceId !== undefined ? { surfaceId: args.event.surfaceId } : {}),
        ...(args.event.transportId !== undefined ? { transportId: args.event.transportId } : {}),
        ...(args.event.authMode !== undefined ? { authMode: args.event.authMode } : {}),
        ...(args.event.policy !== undefined ? { policy: args.event.policy } : {}),
      },
    }
  },
  "llm.continuation": (args) => {
    const nextState = bumpSessionState(args.state, {
      lastLlmContinuation: {
        ...(args.event.provider !== undefined ? { provider: args.event.provider } : {}),
        surfaceId: args.event.surfaceId,
        transportId: args.event.transportId,
        phase: args.event.phase,
        mode: args.event.mode,
        reason: args.event.reason,
        ...(args.event.statusCode !== undefined ? { statusCode: args.event.statusCode } : {}),
      },
    })
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "turn.llm.continuation",
        ...(args.event.provider !== undefined ? { provider: args.event.provider } : {}),
        surfaceId: args.event.surfaceId,
        transportId: args.event.transportId,
        phase: args.event.phase,
        mode: args.event.mode,
        reason: args.event.reason,
        ...(args.event.statusCode !== undefined ? { statusCode: args.event.statusCode } : {}),
      },
    }
  },
  "tool.invoked": (args) => {
    const nextState = bumpSessionState(args.state, {})
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "tool.invoked",
        toolCallId: args.event.toolCallId,
        toolName: args.event.toolName,
        ...(args.event.argsPreview !== undefined ? { argsPreview: args.event.argsPreview } : {}),
      },
    }
  },
  "tool.completed": (args) => {
    const nextState = bumpSessionState(args.state, {})
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "tool.completed",
        toolCallId: args.event.toolCallId,
        toolName: args.event.toolName,
        outcome: args.event.outcome,
        ...(args.event.resultPreview !== undefined
          ? { resultPreview: args.event.resultPreview }
          : {}),
        ...(args.event.durationMs !== undefined ? { durationMs: args.event.durationMs } : {}),
      },
    }
  },
  usage: (args) => {
    const nextState = bumpSessionState(args.state, {
      lastTokenUsage: {
        ...(args.event.promptTokens !== undefined ? { promptTokens: args.event.promptTokens } : {}),
        ...(args.event.completionTokens !== undefined
          ? { completionTokens: args.event.completionTokens }
          : {}),
        ...(args.event.totalTokens !== undefined ? { totalTokens: args.event.totalTokens } : {}),
        ...(args.event.costMicroUsd !== undefined ? { costMicroUsd: args.event.costMicroUsd } : {}),
      },
    })
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "session.state.updated",
        state: toSessionStateView(nextState),
      },
    }
  },
  "skill.scope.decision": (args) => {
    const nextState = bumpSessionState(args.state, {})
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "skill.scope.decision",
        tool: args.event.tool,
        activeSkill: args.event.activeSkill,
        decision: args.event.decision,
        isReadOnly: args.event.isReadOnly,
      },
    }
  },
  // T01 — project the item-stream carrier onto a phase-routed wire event. Pure
  // observation: bump seq/revision (monotonic) like `tool.invoked`, no state
  // patch. The discriminating `item.phase` selects started / delta / completed.
  "item.stream": (args) => {
    const nextState = bumpSessionState(args.state, {})
    const base = createEventBase(args, nextState)
    const { item } = args.event
    if (item.phase === "started") {
      return {
        state: nextState,
        emitted: {
          ...base,
          type: "item.started",
          itemId: item.itemId,
          itemType: item.itemType,
          itemIndex: item.index,
        },
      }
    }
    if (item.phase === "delta") {
      return {
        state: nextState,
        emitted: {
          ...base,
          type: "item.delta",
          itemId: item.itemId,
          itemType: item.itemType,
          deltaKind: item.deltaKind,
          delta: item.delta,
        },
      }
    }
    return {
      state: nextState,
      emitted: {
        ...base,
        type: "item.completed",
        itemId: item.itemId,
        itemType: item.itemType,
        ...(item.text !== undefined ? { text: item.text } : {}),
      },
    }
  },
  // UUX-1-12 — the four additive observability events. All are PURE observation
  // arms: bump seq/revision (monotonic, like `tool.invoked`) and NEVER patch the
  // transcript — the ALBB-18 corruption vector was exactly a status payload
  // reaching `streamingAssistantText` via the prose arm.
  "tool.progress": (args) => {
    const nextState = bumpSessionState(args.state, {})
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "tool.progress",
        toolCallId: args.event.toolCallId,
        toolName: args.event.toolName,
        message: args.event.message,
      },
    }
  },
  recovery: (args) => {
    const nextState = bumpSessionState(args.state, {})
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "turn.recovery",
        reason: args.event.reason,
        ...(args.event.detail !== undefined ? { detail: args.event.detail } : {}),
      },
    }
  },
  "context.compacted": (args) => {
    const nextState = bumpSessionState(args.state, {})
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "context.compacted",
        fromTurnId: args.event.fromTurnId,
        toTurnId: args.event.toTurnId,
        summary: args.event.summary,
        ts: args.event.ts,
        tokens: args.event.tokens,
      },
    }
  },
  "budget.breach": (args) => {
    const nextState = bumpSessionState(args.state, {})
    return {
      state: nextState,
      emitted: {
        ...createEventBase(args, nextState),
        type: "budget.breach",
        severity: args.event.severity,
        scope: args.event.scope,
        observed: args.event.observed,
        limit: args.event.limit,
      },
    }
  },
} satisfies SessionHostTurnEventProjectionRegistry

export const projectSessionHostTurnEvent = (
  args: ProjectionContext & { readonly event: SessionHostTurnEvent },
): SessionHostTurnEventProjectionResult => {
  const context: ProjectionContext = {
    state: args.state,
    commandId: args.commandId,
    emittedAt: args.emittedAt,
    ...(args.eventId !== undefined ? { eventId: args.eventId } : {}),
  }
  const { event } = args
  switch (event.type) {
    case "assistant_text.delta":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["assistant_text.delta"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"assistant_text.delta">)
    case "llm.request":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["llm.request"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"llm.request">)
    case "llm.continuation":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["llm.continuation"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"llm.continuation">)
    case "tool.invoked":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["tool.invoked"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"tool.invoked">)
    case "tool.completed":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["tool.completed"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"tool.completed">)
    case "usage":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY.usage({
        ...context,
        event,
      } satisfies ProjectionArgs<"usage">)
    case "skill.scope.decision":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["skill.scope.decision"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"skill.scope.decision">)
    case "item.stream":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["item.stream"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"item.stream">)
    case "tool.progress":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["tool.progress"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"tool.progress">)
    case "recovery":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY.recovery({
        ...context,
        event,
      } satisfies ProjectionArgs<"recovery">)
    case "context.compacted":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["context.compacted"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"context.compacted">)
    case "budget.breach":
      return SESSION_HOST_TURN_EVENT_PROJECTION_REGISTRY["budget.breach"]({
        ...context,
        event,
      } satisfies ProjectionArgs<"budget.breach">)
  }
}
