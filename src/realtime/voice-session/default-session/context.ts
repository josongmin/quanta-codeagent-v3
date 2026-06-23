/**
 * Realtime voice-session — shared mutable context for the default session.
 *
 * The default session is STATEFUL: `state`, `isMuted`, `mode`, `stopPump`,
 * `unsubTransport` are mutable and read/written by many helpers AND the
 * returned object's methods. To decompose the factory WITHOUT changing closure
 * semantics, those primitives live in a single `SessionBox` passed BY
 * REFERENCE; every helper mutates the SAME box object, exactly as the original
 * shared-closure locals did. `handlers` is a mutable array (reference type),
 * so it is carried as-is.
 */

import { notifyAllNoThrow } from "@/shared"
import type { DefaultSessionDeps } from "../default-session"
import type { VoiceSessionEvent, VoiceSessionState, VoiceTurnMode } from "../port"
import { reduce, type VoiceSessionAction } from "../state-machine"

/** Mutable session locals, boxed so helpers share the SAME reference. */
export interface SessionBox {
  state: VoiceSessionState
  isMuted: boolean
  mode: VoiceTurnMode
  stopPump: (() => void) | null
  unsubTransport: (() => void) | null
}

/** Bundle threaded through every extracted helper. Holds the deps, the boxed
 *  mutable state, the subscriber list, and the capture rate. */
export interface Ctx {
  readonly deps: DefaultSessionDeps
  readonly box: SessionBox
  readonly handlers: Array<(e: VoiceSessionEvent) => void>
  readonly captureRate: number
}

/** Fan-out an event to subscribers, isolating throwing subscribers (RFC §3.4;
 *  HELL-RTV-13). Same no-throw fan-out the transport uses. */
export const emit = (ctx: Ctx, e: VoiceSessionEvent): void => {
  notifyAllNoThrow(ctx.handlers.slice(), undefined, e)
}

/** Drive a reducer action; on legal transition, update state + emit. */
export const dispatch = (ctx: Ctx, action: VoiceSessionAction): boolean => {
  const r = reduce(ctx.box.state, action)
  if (!r.ok) return false
  if (r.state !== ctx.box.state) {
    ctx.box.state = r.state
    emit(ctx, { kind: "state", state: ctx.box.state, at: ctx.deps.now() })
  }
  return true
}

/** Stop the mic pump + transport subscription + playback (best-effort). */
export const teardown = (ctx: Ctx): void => {
  if (ctx.box.stopPump) {
    try {
      ctx.box.stopPump()
    } catch {
      // pump stop is best-effort
    }
    ctx.box.stopPump = null
  }
  if (ctx.box.unsubTransport) {
    ctx.box.unsubTransport()
    ctx.box.unsubTransport = null
  }
  ctx.deps.playback.stop()
}
