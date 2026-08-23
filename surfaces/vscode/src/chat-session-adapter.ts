/**
 * T07 — PURE session.v1 ↔ VS Code `chatSessions` adapter.
 *
 * This module has ZERO `vscode` import. It maps the session.v1 protocol
 * (`@/protocol/session` + `@/ipc/session`) onto a structural
 * {@link ChatSessionItemView} that the thin `provider.ts` shell re-shapes into
 * a concrete `vscode.ChatSessionItem`. Keeping the projection here (a) makes it
 * unit-testable against a REAL session transport without a VS Code host, and
 * (b) enforces the core-decoupling invariant: no VS Code symbol ever reaches
 * `src/` (proved by `core-no-vscode-leak-ratchet.test.ts`).
 *
 * Status is derived from the SERVER's turn lifecycle ONLY — the adapter never
 * optimistically flips to in-progress on submit (that would be a UI-lie if the
 * turn were rejected). It listens on BOTH the fine `turn.*` events and the
 * coarse `session.state.updated` view so it works against the CLI/headless
 * (turn.*) and web/daemon (state.updated) emitters alike.
 */

import type { SessionTransportMessage } from "@/ipc/session"
import type { SessionCommand, SessionEvent, SessionStateView } from "@/protocol/session"
import { CHAT_SESSION_STATUS, type ChatSessionStatusValue, statusForStateView } from "./status"

/** Editor status for a `turn.completed`.
 *
 *  aug-23 §13: this arm used to set `Idle` unconditionally and discard
 *  `outcomeReason`, so a provider error / refusal / turn-limit stop looked
 *  exactly like a clean completion in the editor. The loop reports all of those
 *  as an ORDINARY `turn.completed` with a non-`completed` reason — `turn.failed`
 *  is a different, rarer path — so the reason has to be consulted.
 *
 *  Classified off `outcomeReason` alone so an event from a producer that
 *  predates `stopCategory` is still handled. */
export const statusForTurnCompleted = (
  event: Extract<SessionEvent, { type: "turn.completed" }>,
): ChatSessionStatusValue => {
  if (event.outcomeReason === "completed") return CHAT_SESSION_STATUS.Idle
  /* A paused-for-approval turn has NOT ended — it is resumable and the editor
     should keep the spinner, matching `statusForStateView` (status.ts:36) which
     already maps `awaiting_approval` to InProgress. The first cut of this fix
     bucketed it as Failed, turning a pause into an error badge. */
  if (event.outcomeReason === "awaiting_approval") return CHAT_SESSION_STATUS.InProgress
  return CHAT_SESSION_STATUS.Failed
}

/** The slice of a connected session.v1 client this adapter needs. The real
 *  `SessionTransportClient` from `@/ipc/session` satisfies this structurally. */
export interface SessionPort {
  readonly sessionId: string
  onMessage(handler: (message: SessionTransportMessage) => void): () => void
  sendCommand(command: SessionCommand): Promise<void>
}

/** Structural mirror of `vscode.ChatSessionItem` — the provider shell maps this
 *  to the concrete proposed-API type. `timing` is epoch-ms (VS Code's unit). */
export interface ChatSessionItemView {
  readonly id: string
  readonly label: string
  readonly status: ChatSessionStatusValue
  readonly timing?: {
    readonly startTime?: number
    readonly endTime?: number
  }
}

const DEFAULT_LABEL = "quanta thread"
const LABEL_MAX = 80

const deriveLabel = (text: string | undefined): string => {
  const trimmed = (text ?? "").trim()
  if (trimmed.length === 0) return DEFAULT_LABEL
  const firstLine = trimmed.split("\n", 1)[0] ?? trimmed
  return firstLine.length > LABEL_MAX ? `${firstLine.slice(0, LABEL_MAX - 1)}…` : firstLine
}

/** ISO-8601 → epoch ms; undefined when unparseable (never NaN — a NaN timing
 *  would render as 1970/garbage in the editor). */
const isoToMs = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

const sameItem = (a: ChatSessionItemView, b: ChatSessionItemView): boolean =>
  a.id === b.id &&
  a.label === b.label &&
  a.status === b.status &&
  a.timing?.startTime === b.timing?.startTime &&
  a.timing?.endTime === b.timing?.endTime

/**
 * Projects ONE session.v1 thread into a `ChatSessionItemView`, and translates
 * editor actions (submit / cancel) into session commands. A change listener
 * fires only when the projected item actually changes (de-duped) so the editor
 * does not re-render on no-op events.
 */
export class ChatSessionProjection {
  private label = DEFAULT_LABEL
  private status: ChatSessionStatusValue = CHAT_SESSION_STATUS.Idle
  private startTime: number | undefined
  private endTime: number | undefined
  private commandSeq = 0
  /** Set when a turn ended non-successfully, so the trailing idle state update
   *  cannot launder it back to settled. Cleared on the next turn start. */
  private failedTurnLatched = false
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private readonly now: () => string

  constructor(
    private readonly port: SessionPort,
    opts: { readonly now?: () => string } = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString())
    this.unsubscribe = port.onMessage((m) => this.ingest(m))
  }

  get id(): string {
    return this.port.sessionId
  }

  current(): ChatSessionItemView {
    const timing =
      this.startTime === undefined && this.endTime === undefined
        ? undefined
        : {
            ...(this.startTime !== undefined ? { startTime: this.startTime } : {}),
            ...(this.endTime !== undefined ? { endTime: this.endTime } : {}),
          }
    return {
      id: this.port.sessionId,
      label: this.label,
      status: this.status,
      ...(timing !== undefined ? { timing } : {}),
    }
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** UC: submit a prompt — append input, then run the turn. Status is NOT
   *  flipped here; the server's `turn.started` drives it (no UI-lie). */
  async submitMessage(text: string): Promise<void> {
    await this.port.sendCommand(this.envelope("input.append", { text }))
    await this.port.sendCommand(this.envelope("turn.run", {}))
  }

  async cancel(): Promise<void> {
    await this.port.sendCommand(this.envelope("turn.cancel", {}))
  }

  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private envelope<T extends SessionCommand["type"]>(
    type: T,
    rest: Omit<Extract<SessionCommand, { type: T }>, keyof BaseEnvelope | "type">,
  ): Extract<SessionCommand, { type: T }> {
    this.commandSeq += 1
    return {
      sessionId: this.port.sessionId,
      commandId: `${this.port.sessionId}-c${this.commandSeq}`,
      issuedAt: this.now(),
      type,
      ...rest,
    } as Extract<SessionCommand, { type: T }>
  }

  private applyStateView(state: SessionStateView): void {
    /* The kernel emits `turn.completed` and then IMMEDIATELY
       `session.state.updated` with `status:"idle"` (scheduler-turn-terminals.ts
       sets it unconditionally). Without this latch the trailing update would
       overwrite the failure the completion arm just recorded, making the whole
       fix inert — the editor would show Idle for a rate-limited or refused turn.
       Cleared on the next `turn.started`. */
    if (this.failedTurnLatched && state.status === "idle") {
      if (state.lastUserText !== undefined) this.label = deriveLabel(state.lastUserText)
      return
    }
    this.status = statusForStateView(state.status)
    if (state.lastUserText !== undefined) this.label = deriveLabel(state.lastUserText)
  }

  private ingest(message: SessionTransportMessage): void {
    const before = this.current()
    switch (message.kind) {
      case "snapshot": {
        if (message.snapshot.sessionId !== this.port.sessionId) break
        this.applyStateView(message.snapshot.state)
        break
      }
      case "event": {
        const event = message.event
        switch (event.type) {
          case "session.state.updated":
            this.applyStateView(event.state)
            break
          case "turn.started":
            this.failedTurnLatched = false
            this.status = CHAT_SESSION_STATUS.InProgress
            this.startTime = isoToMs(event.emittedAt) ?? this.startTime
            this.endTime = undefined
            if (event.prompt.trim().length > 0) this.label = deriveLabel(event.prompt)
            break
          case "turn.completed":
            this.status = statusForTurnCompleted(event)
            this.failedTurnLatched = this.status === CHAT_SESSION_STATUS.Failed
            this.endTime = isoToMs(event.emittedAt) ?? this.endTime
            break
          case "turn.failed":
            this.failedTurnLatched = true
            this.status = CHAT_SESSION_STATUS.Failed
            this.endTime = isoToMs(event.emittedAt) ?? this.endTime
            break
          case "session.closed":
            this.status = CHAT_SESSION_STATUS.Idle
            break
          default:
            break
        }
        break
      }
      default:
        // connect / command / rejected / heartbeat carry no projection state.
        break
    }
    if (!sameItem(before, this.current())) this.fire()
  }

  private fire(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A faulty editor listener must not poison sibling subscribers.
      }
    }
  }
}

type BaseEnvelope = {
  readonly sessionId: string
  readonly commandId: string
  readonly issuedAt: string
}

export interface ChatSessionRegistryOpts {
  /** UC3 — spin up a brand-new quanta thread (app-server entry point). The
   *  registry is decoupled from HOW a session is created; the host injects this
   *  (e.g. launch `quanta` app-server + open a stdio/WS session transport). */
  readonly createSession?: () => Promise<SessionPort>
  readonly now?: () => string
}

/**
 * Aggregates the live quanta threads the editor knows about into the list a
 * `vscode.ChatSessionItemProvider` returns from `provideChatSessionItems`, and
 * fires a single coalesced change event on membership OR any per-item change.
 */
export class ChatSessionRegistry {
  private readonly projections = new Map<string, ChatSessionProjection>()
  private readonly perItemUnsub = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly opts: ChatSessionRegistryOpts = {}) {}

  /** Begin projecting an already-connected session port. */
  track(port: SessionPort): ChatSessionProjection {
    const existing = this.projections.get(port.sessionId)
    if (existing !== undefined) return existing
    const projection = new ChatSessionProjection(port, {
      ...(this.opts.now ? { now: this.opts.now } : {}),
    })
    this.projections.set(port.sessionId, projection)
    this.perItemUnsub.set(
      port.sessionId,
      projection.onDidChange(() => this.fire()),
    )
    this.fire()
    return projection
  }

  /** UC3 — editor "new session" → create + track a new quanta thread. */
  async createNew(): Promise<ChatSessionProjection> {
    if (this.opts.createSession === undefined) {
      throw new Error("ChatSessionRegistry.createNew: no createSession factory was injected")
    }
    const port = await this.opts.createSession()
    return this.track(port)
  }

  get(id: string): ChatSessionProjection | undefined {
    return this.projections.get(id)
  }

  items(): ChatSessionItemView[] {
    return [...this.projections.values()].map((p) => p.current())
  }

  onDidChangeItems(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  remove(id: string): void {
    this.perItemUnsub.get(id)?.()
    this.perItemUnsub.delete(id)
    const projection = this.projections.get(id)
    if (projection === undefined) return
    projection.dispose()
    this.projections.delete(id)
    this.fire()
  }

  dispose(): void {
    for (const id of [...this.projections.keys()]) this.remove(id)
    this.listeners.clear()
  }

  private fire(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // isolate faulty listeners
      }
    }
  }
}
