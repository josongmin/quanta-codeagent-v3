/**
 * `@/ipc/event-bridge` — surface-agnostic event bridge.
 *
 * Inspired by Claude Code's CLI <-> Web bridge (deep-dive:A11:206-222 —
 * `importCliSession` + `logCliEvent`). This is the surface-AGNOSTIC base:
 * an EventBridge connects multiple surfaces (CLI / Web / Tauri / future
 * remote-control daemons) to a single logical agent session. Each surface
 * publishes events and subscribes to peer events; the transport is injected.
 *
 * Default-OFF / byte-identical invariant: if no surface constructs an
 * EventBridge the entire CLI behavior is unchanged. The slice does NOT
 * read `process.env` / `argv` — surfaces map their runtime input to typed
 * config and pass transports in.
 *
 * Closed `BridgePayload` discriminated union: a new payload kind MUST extend
 * this file (and the transport encoders) — there is no `unknown` escape.
 */

import type { AgentEvent } from "@/stream"

/* ------------------------------------------------------------------ */
/* Wire envelope — JSON-serializable, transport-agnostic.              */
/* ------------------------------------------------------------------ */

/**
 * On-the-wire frame. Every `BridgeEvent` is encoded into a `WireEnvelope`
 * before send; the transport just shuttles bytes. The version field lets a
 * future v2 transport-layer extension stay backwards compatible — peers
 * negotiate by inspecting `protocol`.
 */
export interface WireEnvelope {
  readonly protocol: "quanta.ipc.v1"
  readonly source: string
  readonly sessionId: string
  readonly payload: BridgePayload
  readonly timestamp: string
}

/* ------------------------------------------------------------------ */
/* Surface-agnostic bridge event.                                      */
/* ------------------------------------------------------------------ */

/**
 * Bridge event = wire envelope shape minus the literal `protocol` tag
 * (peers operate on the typed object; the protocol tag is added at the
 * transport encode step). Keeping the two shapes parallel makes encode /
 * decode trivial and lets a future protocol bump add fields without
 * rippling through callers.
 */
export interface BridgeEvent {
  /** Originating surface ("cli" / "web" / "tauri" / future labels). */
  readonly source: string
  /** Logical session id this event belongs to (NOT the wire/transport id). */
  readonly sessionId: string
  /** Discriminated payload. */
  readonly payload: BridgePayload
  /** ISO 8601 wall clock at the originating surface. */
  readonly timestamp: string
}

/**
 * Permission-request preview shape carried over the wire. Kept structurally
 * minimal — the host (CLI) is the authority on the *full* request shape;
 * this payload is a UI hint for peer surfaces so a Web client can render
 * "please approve this tool call" alongside the CLI prompt.
 */
export interface BridgePermissionPreview {
  readonly toolName: string
  readonly preview?: string
  readonly requestId?: string
}

/**
 * Closed discriminated union of surface-shared signals. Mirrors the Claude
 * Code A11 envelope without leaking surface-specific UI state. Add a new
 * variant by extending this union AND every consumer / encoder.
 */
export type BridgePayload =
  | { readonly type: "agent_event"; readonly event: AgentEvent }
  | { readonly type: "session_started"; readonly meta: BridgeSessionMeta }
  | { readonly type: "session_ended"; readonly outcome: BridgeOutcomeSummary }
  | { readonly type: "user_input"; readonly prompt: string }
  | { readonly type: "permission_request"; readonly request: BridgePermissionPreview }
  | {
      readonly type: "permission_response"
      readonly requestId?: string
      readonly allow: boolean
    }
  | {
      readonly type: "presence"
      readonly surface: string
      readonly status: "connected" | "idle" | "active" | "disconnected"
    }

/**
 * Structural mirror of @/session#SessionMeta — duplicated here to keep
 * `@/ipc` decoupled from session storage internals. The IPC slice does
 * NOT own the session schema; it carries the minimum fields a peer surface
 * needs to render "what session am I attached to". The shape must stay
 * compatible with `SessionMeta` so an export → wire → import round-trip
 * is loss-free for the fields that matter to a remote surface.
 */
export interface BridgeSessionMeta {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly createdAt: number
  readonly lastTouched: number
  readonly archived: boolean
}

/**
 * Tiny outcome summary for `session_ended` — only what a remote surface
 * needs to paint "the session finished, here's why". The full transcript
 * lives in storage; a peer can import it on demand.
 */
export interface BridgeOutcomeSummary {
  readonly reason: string
  readonly turns: number
}

type UnknownRecord = Record<string, unknown>

/* ------------------------------------------------------------------ */
/* Transport contract.                                                  */
/* ------------------------------------------------------------------ */

/**
 * Low-level transport — shuttles `WireEnvelope` bytes between peers. The
 * bridge layers `publish` / `subscribe` semantics on top. Implementations:
 *
 *   - in-memory   — same-process publish/subscribe (test fixture)
 *   - stdio       — line-delimited JSON over process.stdin/stdout (CLI ↔ daemon)
 *   - uds         — Unix Domain Socket frames (local daemon, multi-surface)
 *   - websocket   — Web client adapter (skeleton in this slice; real lib
 *                   integration in a follow-up PR)
 *
 * A transport is reused across many publishes — `close()` drains and
 * disconnects exactly once; subsequent calls are a no-op.
 */
export interface BridgeTransport {
  send(envelope: WireEnvelope): Promise<void>
  onMessage(handler: (envelope: WireEnvelope) => void): () => void
  close(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* High-level bridge contract.                                          */
/* ------------------------------------------------------------------ */

/**
 * Surface-agnostic event bridge. Backed by a single `BridgeTransport`; the
 * bridge layers the `BridgePayload` typing, self-loopback delivery, and
 * subscriber bookkeeping on top.
 *
 * Loopback rule: `publish` delivers to every subscriber INCLUDING those
 * registered on the same bridge. This matches Claude Code A11 (Web client
 * sees its own emit echoed back so the CLI UI and Web UI render identical
 * trajectories). A subscriber that wants to filter self can compare
 * `event.source` to its own surface label.
 */
export interface EventBridge {
  /** Surface label this bridge identifies as (passed into every envelope). */
  readonly source: string
  /** Publish a `BridgeEvent` to every subscriber (self-loopback included). */
  publish(event: BridgeEvent): Promise<void>
  /** Subscribe to incoming events; returns an unsubscribe function. */
  subscribe(handler: (event: BridgeEvent) => void): () => void
  /** Drain pending publishes and disconnect the transport. Idempotent. */
  close(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* Bridge factory.                                                      */
/* ------------------------------------------------------------------ */

export interface CreateEventBridgeOpts {
  readonly source: string
  readonly transport: BridgeTransport
  /** Clock injection — defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string
}

/**
 * Build an EventBridge over a transport. The bridge:
 *   1. Encodes outbound `BridgeEvent` → `WireEnvelope` (adds `protocol` tag).
 *   2. Decodes inbound `WireEnvelope` → `BridgeEvent` and fans out to subscribers.
 *   3. Loopback-delivers every `publish` to local subscribers BEFORE awaiting
 *      transport `send` — peer-network latency MUST NOT delay self-render.
 *
 * The factory is the only public constructor; consumers should depend on the
 * `EventBridge` interface and inject this factory in tests.
 */
export const createEventBridge = (opts: CreateEventBridgeOpts): EventBridge => {
  const subscribers = new Set<(event: BridgeEvent) => void>()
  let closed = false
  let unsubTransport: (() => void) | undefined

  const fanOut = (event: BridgeEvent): void => {
    // Snapshot to a list so a handler that unsubscribes during fan-out does
    // not perturb the iteration. Errors in one handler MUST NOT abort the
    // others — log and continue (logging is via @/shared#logger so a
    // non-CLI surface can redirect).
    for (const handler of [...subscribers]) {
      try {
        handler(event)
      } catch {
        // intentionally swallow — a misbehaving subscriber MUST NOT poison
        // peer surfaces. The logger lives in @/shared but we avoid importing
        // it here to keep this leaf module dependency-free; consumers that
        // want diagnostics should wrap their handler.
      }
    }
  }

  unsubTransport = opts.transport.onMessage((envelope) => {
    if (envelope.protocol !== "quanta.ipc.v1") return
    fanOut({
      source: envelope.source,
      sessionId: envelope.sessionId,
      payload: envelope.payload,
      timestamp: envelope.timestamp,
    })
  })

  return {
    source: opts.source,
    async publish(event) {
      if (closed) return
      // Loopback first — same-surface subscribers must see the event before
      // we await the transport.
      fanOut(event)
      const envelope: WireEnvelope = {
        protocol: "quanta.ipc.v1",
        source: event.source,
        sessionId: event.sessionId,
        payload: event.payload,
        timestamp: event.timestamp,
      }
      await opts.transport.send(envelope)
    },
    subscribe(handler) {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },
    async close() {
      if (closed) return
      closed = true
      if (unsubTransport !== undefined) {
        unsubTransport()
        unsubTransport = undefined
      }
      subscribers.clear()
      await opts.transport.close()
    },
  }
}

/* ------------------------------------------------------------------ */
/* Helpers — timestamp + decode guard.                                  */
/* ------------------------------------------------------------------ */

/** Default ISO 8601 timestamp factory (UTC). */
export const isoNow = (): string => new Date().toISOString()

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const isBridgeSessionMeta = (value: unknown): value is BridgeSessionMeta => {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    typeof value.title === "string" &&
    isNonEmptyString(value.cwd) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.lastTouched) &&
    typeof value.archived === "boolean"
  )
}

const isBridgeOutcomeSummary = (value: unknown): value is BridgeOutcomeSummary => {
  if (!isRecord(value)) return false
  return (
    typeof value.reason === "string" &&
    isFiniteNumber(value.turns) &&
    Number.isInteger(value.turns) &&
    value.turns >= 0
  )
}

const isBridgePermissionPreview = (value: unknown): value is BridgePermissionPreview => {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.toolName) &&
    (value.preview === undefined || typeof value.preview === "string") &&
    (value.requestId === undefined || isNonEmptyString(value.requestId))
  )
}

const isBridgePayload = (value: unknown): value is BridgePayload => {
  if (!isRecord(value) || typeof value.type !== "string") return false
  switch (value.type) {
    case "agent_event":
      return isRecord(value.event) && isNonEmptyString(value.event.type)
    case "session_started":
      return isBridgeSessionMeta(value.meta)
    case "session_ended":
      return isBridgeOutcomeSummary(value.outcome)
    case "user_input":
      return typeof value.prompt === "string"
    case "permission_request":
      return isBridgePermissionPreview(value.request)
    case "permission_response":
      return (
        typeof value.allow === "boolean" &&
        (value.requestId === undefined || isNonEmptyString(value.requestId))
      )
    case "presence":
      return (
        isNonEmptyString(value.surface) &&
        (value.status === "connected" ||
          value.status === "idle" ||
          value.status === "active" ||
          value.status === "disconnected")
      )
    default:
      return false
  }
}

/**
 * Narrow validator — checks that an arbitrary value matches the
 * `WireEnvelope` invariants WE control (the `protocol` tag, the required
 * fields, and the required fields for each closed `BridgePayload` variant).
 * Nested payload bodies remain intentionally shallow here: the IPC boundary
 * proves "this is structurally the right bridge message", while the owning
 * slice still owns deeper semantic validation of nested objects.
 */
export const isWireEnvelope = (value: unknown): value is WireEnvelope => {
  if (!isRecord(value)) return false
  const obj = value
  if (obj.protocol !== "quanta.ipc.v1") return false
  if (!isNonEmptyString(obj.source)) return false
  if (!isNonEmptyString(obj.sessionId)) return false
  if (!isNonEmptyString(obj.timestamp)) return false
  return isBridgePayload(obj.payload)
}
