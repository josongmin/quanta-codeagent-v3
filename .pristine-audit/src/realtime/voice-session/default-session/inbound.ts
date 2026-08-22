/**
 * Realtime voice-session — inbound text-frame routing (RFC §3.4).
 *
 * Parses each server text frame and routes it to a small per-type effect.
 * session.updated / item.added / unknown ⇒ no state effect (no route).
 * All effects go THROUGH the shared `Ctx` (emit/dispatch) so state stays
 * single-sourced.
 */

import { type Ctx, dispatch, emit } from "./context"

/** Decode a base64 audio-delta from the server back to PCM bytes. */
const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"))

type InboundMsg = { type?: unknown; delta?: unknown; transcript?: unknown; error?: unknown }

/** Route an audio-delta: play (unless transcript-only) + always emit. */
const onAudioDelta = (ctx: Ctx, msg: InboundMsg): void => {
  if (typeof msg.delta !== "string") return
  const pcm = fromBase64(msg.delta)
  // transcript-only fallback: drop audio when no player (RFC §6.3).
  if (ctx.deps.playback.availability() !== null) ctx.deps.playback.play(pcm)
  emit(ctx, { kind: "audio-delta", pcm, at: ctx.deps.now() })
}

/** Inbound type → effect table. Each handler is small; the router below just
 *  dispatches. Keeps cognitive complexity bounded. */
const onError = (ctx: Ctx, msg: InboundMsg): void => {
  const reason =
    msg.error && typeof msg.error === "object" && "message" in msg.error
      ? String((msg.error as { message: unknown }).message)
      : "realtime error"
  emit(ctx, {
    kind: "error",
    error: { kind: "io-error", degradeReason: reason },
    at: ctx.deps.now(),
  })
}

const buildRoutes = (ctx: Ctx): Readonly<Record<string, (msg: InboundMsg) => void>> => ({
  "response.created": () => {
    dispatch(ctx, { type: "turn-start" })
  },
  "response.audio.delta": (msg) => {
    dispatch(ctx, { type: "turn-start" })
    onAudioDelta(ctx, msg)
  },
  "response.output_audio.delta": (msg) => {
    dispatch(ctx, { type: "turn-start" })
    onAudioDelta(ctx, msg)
  },
  "response.audio_transcript.delta": (msg) => {
    dispatch(ctx, { type: "turn-start" })
    if (typeof msg.delta === "string") {
      emit(ctx, { kind: "transcript-delta", text: msg.delta, at: ctx.deps.now() })
    }
  },
  "response.audio_transcript.done": (msg) => {
    emit(ctx, {
      kind: "transcript-done",
      text: typeof msg.transcript === "string" ? msg.transcript : "",
      at: ctx.deps.now(),
    })
  },
  "response.output_audio_transcript.done": (msg) => {
    emit(ctx, {
      kind: "transcript-done",
      text: typeof msg.transcript === "string" ? msg.transcript : "",
      at: ctx.deps.now(),
    })
  },
  "response.done": () => {
    void ctx.deps.playback.flush()
    dispatch(ctx, { type: "turn-done" })
  },
  error: (msg) => onError(ctx, msg),
})

/** Parse an inbound text frame from the server and route it (RFC §3.4).
 *  session.updated / item.added / unknown ⇒ no state effect (no route). */
const onInbound = (
  routes: Readonly<Record<string, (msg: InboundMsg) => void>>,
  raw: string,
): void => {
  let msg: InboundMsg
  try {
    msg = JSON.parse(raw) as InboundMsg
  } catch {
    return // non-JSON frame — ignore (spec emits JSON)
  }
  const type = typeof msg.type === "string" ? msg.type : ""
  routes[type]?.(msg)
}

/** Wire the transport's onMessage; classify a remote close as connection
 *  loss (RFC §6 connection-drop row). */
export const wireTransport = (ctx: Ctx): void => {
  const routes = buildRoutes(ctx)
  ctx.box.unsubTransport = ctx.deps.transport.onMessage((m) => {
    if (m.kind === "text") onInbound(routes, m.data)
    // binary frames are not used by the Realtime text-WS protocol; ignore.
  })
}
