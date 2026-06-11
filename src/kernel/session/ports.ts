import type { AgentOutcome } from "@/agent"
import type { ImageBlock, Message } from "@/llm"
import type {
  ArtifactRef,
  CapabilityManifest,
  PendingApprovalView,
  SessionEvent,
} from "@/protocol/session"
import type {
  LlmSurfaceId,
  LlmTransportId,
  ResponsesContinuationMode,
  ResponsesContinuationPhase,
  ResponsesContinuationReason,
} from "@/shared/llm-route-types"
import type { TurnPolicySnapshot } from "@/shared/turn-policy-types"
import type { KernelSessionState } from "./state"

export interface KernelClock {
  now(): Date
}

export const systemClock: KernelClock = {
  now: (): Date => new Date(),
}

export interface SessionHostDescription {
  readonly sessionId: string
  readonly permissionMode: string
  readonly capabilityManifest: CapabilityManifest
  readonly identityMode?: string
  readonly toolProfile?: string
  readonly messages?: readonly Message[]
  /** Active LLM model slug if the host can introspect its port. Surfaces
   *  on `session.created` (one-shot) and `session.state.updated` (every
   *  state echo) so any subscriber can show a model pill without an
   *  out-of-band lookup. Optional — test doubles may omit. */
  readonly modelSlug?: string
}

/** Per-turn token accounting reported by an LLM adapter (provider stream
 *  usually emits this on its terminal frame). Mirrors `TokenUsage` in
 *  `@/protocol/session` so the kernel can hand it through without an
 *  upstream-vs-downstream type rename. */
export interface SessionHostTurnUsage {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  readonly costMicroUsd?: number
}

export interface SessionHostTurnResult {
  readonly outcome: AgentOutcome
  readonly messages: readonly Message[]
  readonly artifacts?: readonly ArtifactRef[]
  readonly approvalRequest?: PendingApprovalView
  readonly errorMessage?: string
  /** Token usage for THIS turn (not cumulative). When absent the
   *  scheduler omits the field on `turn.completed`. */
  readonly tokenUsage?: SessionHostTurnUsage
}

/**
 * Streaming event variants the SessionHost can yield through `runTurn`'s
 * `onEvent` callback. The scheduler maps these 1-to-1 onto wire events
 * (`turn.output.delta` / `turn.llm.request` / `turn.llm.continuation` /
 * `tool.invoked` / `tool.completed`) and the `usage` variant feeds
 * `KernelSessionState.lastTokenUsage` so the next `turn.completed` carries it.
 */
export type SessionHostTurnEvent =
  | { readonly type: "assistant_text.delta"; readonly delta: string }
  | {
      readonly type: "llm.request"
      readonly model: string
      readonly provider?: string
      readonly surfaceId?: LlmSurfaceId
      readonly transportId?: LlmTransportId
      readonly authMode?: string
      readonly policy?: TurnPolicySnapshot
    }
  | {
      readonly type: "llm.continuation"
      readonly provider?: string
      readonly surfaceId: "openai-responses"
      readonly transportId: LlmTransportId
      readonly phase: ResponsesContinuationPhase
      readonly mode: ResponsesContinuationMode
      readonly reason: ResponsesContinuationReason
      readonly statusCode?: number
    }
  | {
      readonly type: "tool.invoked"
      readonly toolCallId: string
      readonly toolName: string
      readonly argsPreview?: string
    }
  | {
      readonly type: "tool.completed"
      readonly toolCallId: string
      readonly toolName: string
      readonly outcome: "ok" | "error" | "denied" | "timeout"
      readonly resultPreview?: string
      readonly durationMs?: number
    }
  | {
      readonly type: "usage"
      readonly promptTokens?: number
      readonly completionTokens?: number
      readonly totalTokens?: number
      readonly costMicroUsd?: number
    }
  // ADR-0512 — skill-scope decision SUMMARY. The scheduler maps this 1-to-1 onto
  // the `skill.scope.decision` wire event so a hard-`blocked` / silently-declined
  // out-of-scope tool produces UI feedback on the web surface (it never reaches
  // the interactive `approval.requested` card). Distinct from the `usage` /
  // `tool.*` variants above; it carries no token / state mutation.
  | {
      readonly type: "skill.scope.decision"
      readonly tool: string
      readonly activeSkill: string
      readonly decision: "allowed" | "declined" | "steered" | "blocked"
      readonly isReadOnly: boolean
    }

export type SessionHostSideConversationInheritance = "none" | "system" | "last-turn"

export interface SessionHostSideConversationArgs {
  readonly question: string
  readonly inherit?: SessionHostSideConversationInheritance
  readonly tools?: readonly string[]
  readonly maxTurns?: number
  readonly signal: AbortSignal
  readonly messages: readonly Message[]
}

export interface SessionHostSideConversationResult {
  readonly outcome: AgentOutcome
  readonly answerText: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolsAvailable: number
}

export interface SessionHost {
  describe(): SessionHostDescription
  runTurn(args: {
    readonly history: readonly Message[]
    readonly prompt: string
    readonly images?: readonly ImageBlock[]
    readonly signal?: AbortSignal
    readonly onEvent?: (event: SessionHostTurnEvent) => void
  }): Promise<SessionHostTurnResult>
  resolveApproval?(args: {
    readonly approvalId: string
    readonly decision: "approve" | "deny"
    /** ADR-0512 P3 — once-vs-session scope for an `approve` of a skill-scope
     *  escalation (`once` ⇒ dispatch WITHOUT widening). Absent ⇒ session/widen
     *  (or N/A for a normal approval). #20 — `session_prefix` additionally mints
     *  a standing program-token prefix grant on a NORMAL approval. */
    readonly scope?: "once" | "session" | "session_prefix"
    /** ADR-0512 P3 — corrective steer for a `deny` of a skill-scope escalation
     *  (`deny_and_steer`). Absent ⇒ a plain decline. */
    readonly steer?: string
  }): Promise<void> | void
  setIdentityMode?(mode: string): Promise<void> | void
  setToolProfile?(profile: string): Promise<void> | void
  /** Switch the session permission mode mid-session. Honored live by the next
   *  turn's gate when the surface wired a getter/setter `permission.mode`. */
  setPermissionMode?(mode: string): Promise<void> | void
  startSideConversation?(
    args: SessionHostSideConversationArgs,
  ): Promise<SessionHostSideConversationResult>
  close(): Promise<void>
}

export interface KernelEventLogPort {
  append(event: SessionEvent): Promise<void> | void
  list(): readonly SessionEvent[]
}

export interface KernelCommittedEvents {
  readonly state: KernelSessionState
  readonly events: readonly SessionEvent[]
}

export interface KernelDispatchContext {
  readonly clock: KernelClock
  readonly eventLog: KernelEventLogPort
  readonly host: SessionHost
  readonly signal?: AbortSignal
  readonly onCommitted?: (args: KernelCommittedEvents) => Promise<void> | void
}
