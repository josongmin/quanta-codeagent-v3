/**
 * Realtime voice-session — connection lifecycle + mic up-pump + guards.
 *
 * Connection-drop classification (RFC §6 / HELL-RTV-07), the muted-gated mic
 * up-pump (RFC §3.4 / HELL-RTV-06), and the small Result guards/helpers the
 * returned object's methods delegate to. All mutate the shared `Ctx` box.
 */

import { err, ok, type Result } from "@/shared"
import { bridgeToRealtime } from "../pcm-bridge"
import type { VoiceSessionError, VoiceSessionStartOpts } from "../port"
import { buildSessionUpdate, DEFAULT_VOICE, REALTIME_PCM_RATE } from "../session-config"
import { type Ctx, dispatch, emit, teardown } from "./context"

/** Base64-encode raw PCM bytes for the Realtime API's text-WS frame. */
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

/** Classify a transport that went away mid-session as a connection drop
 *  (RFC §6 connection-drop row / HELL-RTV-07). Transitions to `closed`,
 *  emits ONE `error{reason:connection}`, tears down subscribers (no
 *  zombies). Idempotent — a second detection after close is a no-op. */
export const onConnectionLost = (ctx: Ctx, degradeReason: string): void => {
  if (ctx.box.state === "closed") return
  teardown(ctx)
  emit(ctx, { kind: "error", error: { kind: "connection", degradeReason }, at: ctx.deps.now() })
  dispatch(ctx, { type: "close" })
}

/** Forward a single mic chunk up. Muted ⇒ dropped BEFORE the append frame
 *  (RFC §3.4 / HELL-RTV-06). A post-open `not-connected` send result OR a
 *  closed transport means the remote dropped — detected here since the
 *  transport surfaces close only on its own WS (HELL-RTV-07). */
export const pumpChunk = (ctx: Ctx, chunk: Uint8Array): void => {
  if (ctx.box.isMuted) return
  if (ctx.box.state !== "listening" && ctx.box.state !== "responding") return
  if (ctx.deps.transport.status() === "closed") {
    onConnectionLost(ctx, "transport closed")
    return
  }
  const pcm = bridgeToRealtime(chunk, ctx.captureRate, REALTIME_PCM_RATE)
  if (pcm.byteLength === 0) return
  const sent = ctx.deps.transport.send(
    JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) }),
  )
  if (!sent.ok && sent.error.kind === "not-connected") {
    onConnectionLost(ctx, "transport not connected")
  }
}

/** Up-pump: each mic chunk → `pumpChunk`. */
export const startPump = (ctx: Ctx): void => {
  ctx.box.stopPump = ctx.deps.pump.start((chunk) => pumpChunk(ctx, chunk))
}

export const guardActive = (ctx: Ctx): Result<void, VoiceSessionError> => {
  if (ctx.box.state === "idle" || ctx.box.state === "closed") {
    return err({ kind: "not-started" })
  }
  return ok(undefined)
}

/** Fail the connect: connecting → idle + emit + return Err. */
export const failConnect = (ctx: Ctx, e: VoiceSessionError): Result<void, VoiceSessionError> => {
  dispatch(ctx, { type: "connect-failed" })
  emit(ctx, { kind: "error", error: e, at: ctx.deps.now() })
  return err(e)
}

/** Open the transport, mapping its typed error to ours. */
export const openTransport = async (
  ctx: Ctx,
  opts: VoiceSessionStartOpts,
): Promise<Result<void, VoiceSessionError>> => {
  const c = await ctx.deps.transport.connect({
    endpoint: opts.endpoint,
    auth: opts.auth,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
  if (c.ok) return ok(undefined)
  if (c.error.kind === "auth-failed") {
    return err({ kind: "auth-failed", degradeReason: c.error.degradeReason })
  }
  const degradeReason = "degradeReason" in c.error ? c.error.degradeReason : c.error.kind
  return err({ kind: "connect-failed", degradeReason })
}

/** Send the §4.2 session.update + audio.start marker. */
export const sendSessionUpdate = (ctx: Ctx, opts: VoiceSessionStartOpts): void => {
  const cfg = buildSessionUpdate({
    model: opts.model,
    mode: ctx.box.mode,
    voice: opts.voice ?? DEFAULT_VOICE,
    ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
    ...(opts.vad !== undefined ? { vad: opts.vad } : {}),
  })
  ctx.deps.transport.send(JSON.stringify(cfg))
  ctx.deps.transport.audioStart("pcm")
}
