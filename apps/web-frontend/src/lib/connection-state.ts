/**
 * WS-F move 2 — the ConnectionState machine (UUX-3-06 / 5-07 / 5-24 / 3-05).
 *
 * ONE pure transition function drives the whole connection UX. The App folds
 * three previously-improvised signal sources into it:
 *
 *   - the WS socket lifecycle (`SessionClient` ConnectionState),
 *   - the Tauri/daemon bootstrap-config resolution loop (now CAPPED at
 *     {@link BOOTSTRAP_MAX_ATTEMPTS} with backoff → `failed` + a retry CTA,
 *     instead of a silent 200ms-forever loop stuck on "Connecting…"),
 *   - transcript hydration (`GET /threads/:id/events` — a failure DEGRADES
 *     with a banner instead of silently rendering an empty transcript).
 *
 * Everything the UI needs derives from the machine state: banner text +
 * retry CTA, empty-state copy, composer enablement.
 */

import type { ConnectionState } from "../types/protocol"

export type UiConnectionPhase = "connecting" | "connected" | "degraded" | "failed"

export type UiConnectionState =
  | { readonly phase: "connecting"; readonly attempt: number }
  | { readonly phase: "connected" }
  /** Live session works, but something partial failed (e.g. history hydrate)
   *  — banner explains, composer stays enabled. Sticky across socket churn so
   *  a reconnect blip cannot silently eat the "history missing" notice. */
  | { readonly phase: "degraded"; readonly reason: string }
  /** Terminal until the user retries: bootstrap gave up. Composer disabled. */
  | { readonly phase: "failed"; readonly reason: string }

export type UiConnectionEvent =
  | { readonly type: "socket-changed"; readonly socket: ConnectionState }
  | { readonly type: "bootstrap-attempt-failed"; readonly attempt: number }
  | { readonly type: "bootstrap-gave-up"; readonly reason: string }
  | { readonly type: "hydrate-failed"; readonly reason: string }
  | { readonly type: "hydrate-recovered" }
  | { readonly type: "retry-requested" }

export const INITIAL_UI_CONNECTION: UiConnectionState = { phase: "connecting", attempt: 0 }

/** Bootstrap resolution retry cap (UUX-3-06). Each attempt already includes
 *  the Tauri `daemon_info` inner poll; ~20 outer attempts with backoff is
 *  tens of seconds of patience before an honest `failed` + retry CTA. */
export const BOOTSTRAP_MAX_ATTEMPTS = 20

/** Exponential backoff for bootstrap retries: 200ms doubling, capped at 5s. */
export const bootstrapRetryDelayMs = (attempt: number): number =>
  Math.min(200 * 2 ** Math.max(0, Math.min(attempt, 10)), 5_000)

const applySocket = (state: UiConnectionState, socket: ConnectionState): UiConnectionState => {
  switch (state.phase) {
    case "degraded":
      // Sticky: the degrade notice must survive socket churn (a reconnect
      // does NOT restore the missing history). Cleared only by
      // hydrate-recovered / retry / bootstrap-gave-up.
      return state
    case "failed":
      // Sticky except an actually-live socket (honesty beats stickiness).
      return socket.kind === "connected" ? { phase: "connected" } : state
    case "connecting":
    case "connected":
      switch (socket.kind) {
        case "connected":
          return state.phase === "connected" ? state : { phase: "connected" }
        case "connecting":
          return { phase: "connecting", attempt: socket.attempt }
        case "disconnected":
          return { phase: "connecting", attempt: socket.attempt }
        case "closed":
          // Pre-connect noise while connecting; a deliberate reconnect cycle
          // (config-ready → disconnect → connect) while connected.
          return state.phase === "connected" ? { phase: "connecting", attempt: 0 } : state
      }
  }
}

export const transitionUiConnection = (
  state: UiConnectionState,
  event: UiConnectionEvent,
): UiConnectionState => {
  switch (event.type) {
    case "retry-requested":
      return { phase: "connecting", attempt: 0 }
    case "socket-changed":
      return applySocket(state, event.socket)
    case "bootstrap-attempt-failed":
      // Meaningful only while still trying to connect; stale timers must not
      // resurrect a settled state.
      return state.phase === "connecting" ? { phase: "connecting", attempt: event.attempt } : state
    case "bootstrap-gave-up":
      // A live connection proves the gave-up signal stale.
      return state.phase === "connected" ? state : { phase: "failed", reason: event.reason }
    case "hydrate-failed":
      // `failed` dominates (no session at all beats missing history).
      return state.phase === "failed" ? state : { phase: "degraded", reason: event.reason }
    case "hydrate-recovered":
      return state.phase === "degraded" ? { phase: "connected" } : state
  }
}

/* ------------------------------------------------------------------ */
/* Derived UI facets — single source, no per-component improvisation    */
/* ------------------------------------------------------------------ */

/** Composer enablement: degraded is live (only history is missing). */
export const composerEnabled = (state: UiConnectionState): boolean =>
  state.phase === "connected" || state.phase === "degraded"

export interface EmptyStateCopy {
  readonly title: string
  readonly body: string
}

/** Empty-transcript copy per phase (UUX-5-24): never invite a conversation
 *  the daemon cannot hear. */
export const emptyStateCopyFor = (phase: UiConnectionPhase): EmptyStateCopy => {
  switch (phase) {
    case "connected":
    case "degraded":
      return {
        title: "Start a conversation",
        body: "Ask quanta to explain code, plan a change, or run a task.",
      }
    case "connecting":
      return {
        title: "Connecting to quanta…",
        body: "Waiting for the daemon. The composer unlocks as soon as the session is live.",
      }
    case "failed":
      return {
        title: "Not connected",
        body: "The daemon connection could not be established — use Retry in the banner above.",
      }
  }
}

export interface ConnectionBanner {
  readonly text: string
  /** True ⇒ render the retry CTA (re-runs the bootstrap loop). */
  readonly retry: boolean
}

/** Banner chrome (mirrors the resume-failed banner UI): degraded explains,
 *  failed explains + offers retry, healthy states render nothing. */
export const connectionBanner = (state: UiConnectionState): ConnectionBanner | null => {
  switch (state.phase) {
    case "connecting":
    case "connected":
      return null
    case "degraded":
      return {
        text: `Connected, but earlier history could not be loaded: ${state.reason}`,
        retry: false,
      }
    case "failed":
      return { text: `Could not connect to the quanta daemon: ${state.reason}`, retry: true }
  }
}
