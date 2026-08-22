import type { AgentOutcome } from "@/agent"
import type { ImageBlock, Message } from "@/llm"
import type {
  ArtifactRef,
  CapabilityManifest,
  PendingApprovalView,
  PostureCommandOutcome,
  PostureCommandScope,
  PostureProjectionView,
  SessionEvent,
} from "@/protocol/session"
import type { ItemStreamCore } from "@/shared/item-stream"
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
  /** RFC-05 E4 — the resolved posture echo (requested / effective incl
   *  `effectiveMode` / admitted locks) at the host's CURRENT posture revision.
   *  Present ONLY when the host wired a posture control; the scheduler copies it
   *  onto the `session.state.updated` echo after a posture mutation reconcile.
   *  Absent ⇒ byte-identical for a host without a posture projection source. */
  readonly posture?: PostureProjectionView
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
export const SESSION_HOST_TURN_EVENT_TYPES = [
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
] as const

export type SessionHostTurnEventType = (typeof SESSION_HOST_TURN_EVENT_TYPES)[number]

export const isSessionHostTurnEventType = (value: unknown): value is SessionHostTurnEventType =>
  typeof value === "string" && (SESSION_HOST_TURN_EVENT_TYPES as readonly string[]).includes(value)

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
      /** Ticket 04 — the FULL (model-visible, redaction-applied) tool args, set
       *  ONLY when the production fidelity gate is ON. Additive-optional: absent
       *  ⇒ byte-identical default-OFF. The ipc bridge strips it for non-negotiated
       *  wire peers (S3). */
      readonly argsFull?: string
      /** Ticket 04 — set when the full payload exceeded the size cap and was
       *  DROPPED (not truncated); the consumer must fall back to the preview. */
      readonly fidelityDegraded?: true
    }
  | {
      readonly type: "tool.completed"
      readonly toolCallId: string
      readonly toolName: string
      readonly outcome: "ok" | "error" | "denied" | "timeout"
      readonly resultPreview?: string
      readonly durationMs?: number
      /** Ticket 04 — the FULL (model-visible, redaction-applied) tool result,
       *  gate-ON only (see `tool.invoked.argsFull`). */
      readonly resultFull?: string
      /** Ticket 04 — full result exceeded the cap and was dropped (see
       *  `tool.invoked.fidelityDegraded`). */
      readonly fidelityDegraded?: true
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
  // T01 — item/* fine-grained stream carrier. The host's per-turn
  // {@link ItemStreamProjector} produces 0..N {@link ItemStreamCore}s per source
  // AgentEvent; each is forwarded as ONE `item.stream` and the scheduler projects
  // it onto an `item.started` / `item.delta` / `item.completed` wire event by
  // `item.phase`. Carried ONLY when `QUANTA_ITEM_STREAM` is on (absent ⇒ never
  // produced, byte-identical). Pure observation: no token / state mutation.
  | { readonly type: "item.stream"; readonly item: ItemStreamCore }
  // UUX-1-12 (jul-10) — HIGH-VALUE observability events, additive. Each is a
  // DEDICATED NON-PROSE variant (the ALBB-18 lesson: mid-turn status must never
  // ride `assistant_text.delta`, which the projection appends to the streaming
  // transcript). Pure observation: no token / transcript mutation.
  //
  // Keyed mid-tool progress notice (free-text, clamped at the bridge).
  | {
      readonly type: "tool.progress"
      readonly toolCallId: string
      readonly toolName: string
      readonly message: string
    }
  // Loop recovery trace (backoff / compact / nudge / empty / malformed).
  | { readonly type: "recovery"; readonly reason: string; readonly detail?: string }
  // ADR-0075 proactive-compaction marker (summary clamped at the bridge).
  | {
      readonly type: "context.compacted"
      readonly fromTurnId: string
      readonly toTurnId: string
      readonly summary: string
      readonly ts: number
      readonly tokens: number
    }
  // ALBB-21 advisory budget-cap crossing (soft/hard, never a stop by itself).
  | {
      readonly type: "budget.breach"
      readonly severity: "soft" | "hard"
      readonly scope: string
      readonly observed: number
      readonly limit: number
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
    /** T05 — the web/SDK operator's per-hunk choice (`h1`, `h2`, …) on an
     *  `approve` of a previewable mutation. A PROPER SUBSET applies only those
     *  hunks (atomic, staleness-guarded) + suppresses the whole-call tool via a
     *  deny_and_steer lease. Absent / covers-all ⇒ whole-call, byte-identical. */
    readonly selectedHunks?: readonly string[]
  }): Promise<void> | void
  setIdentityMode?(mode: string): Promise<void> | void
  setToolProfile?(profile: string): Promise<void> | void
  /** RFC-03 C3 — apply an out-of-band OBJECTIVE mutation (the CLI-edit / web
   *  composer front door). The host binds the ACTOR to `user` (a surface-issued
   *  command is an operator action, never trusted from the wire) and the
   *  objective THREAD to the session's own thread, then routes it through the
   *  objective authority's `prepare`/`commit` under CAS on `expectedRevision`. A
   *  stale revision is a no-op (the authority rejects it without clobbering a
   *  newer commit). Absent ⇒ the surface wired no objective authority (the
   *  reducer still echoes the session revision). Duck-typed `unknown` mutation so
   *  `@/kernel` needs no `@/objective` value import; the host casts it back. */
  mutateObjective?(args: {
    readonly mutation: unknown
    readonly expectedRevision?: number
  }): Promise<void> | void
  /**
   * RFC-05 E4 — apply a POSTURE mutation (the CLI selector / web composer front
   * door). The single posture host projection: `session.posture.set` routes here
   * directly, and the legacy `session.permission.set` routes here too via its
   * compatibility adapter (a `{ mode }` patch at `scope: "current"`) — ONE host
   * method, no both-old-and-new arm. The host binds the ACTOR to `user` and the
   * THREAD to its own session, applies the lossless `patch` under CAS on
   * `expectedRevision` (E2 authority), and returns a TYPED outcome. `ok` ⇒ the
   * scheduler reconciles the fresh posture from `describe()`; a `stale_revision`
   * / `persist_failed` arm is a typed negative (no live mutation). The method
   * being ABSENT is the distinct unsupported-host negative — the scheduler MUST
   * raise it rather than report a silent success. Duck-typed `unknown` patch so
   * `@/kernel` needs no `@/permission` value import; the host casts it back. */
  setPosture?(args: {
    readonly patch: unknown
    readonly scope: PostureCommandScope
    readonly expectedRevision?: number
  }): Promise<PostureCommandOutcome> | PostureCommandOutcome
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
