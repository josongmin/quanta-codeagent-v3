/**
 * `/voice-live` composition-root wire (ADR-0442 limitation closure).
 *
 * Assembles the `RealtimeVoiceSessionPort` + the `/voice-live` slash deps at
 * the REPL composition root, behind an opt-in gate, then hands the slash
 * surface (`voice-live-cmd.ts`) a ready `VoiceLiveCtx`. This is the ONLY
 * plane-crossing point: it composes `@/realtime` (transport) + `@/voice`
 * (recorder) + `@/realtime/voice-session` (session + playback) + `@/auth`
 * (bearer resolution) into the live session. The realtime slice stays fenced
 * (it never imports `@/llm` / `@/auth` — auth is an injected resolved bearer).
 *
 * Gate (DEFAULT-OFF):
 *   - `QUANTA_VOICE_LIVE=1` (opt-in) AND a TTY ⇒ the handle is built and
 *     `/voice-live` constructs a real session.
 *   - Absent the knob OR non-TTY ⇒ `build*` returns `undefined`; the slash is
 *     never routed to a session (the dispatcher omits the fast-path) so the
 *     REPL is byte-identical to the pre-wire path.
 *
 * Determinism: NO `Date.now`/`Math.random`/real-timer in this file. The clock
 * (`now`), the recorder/playback spawners, the transport factory, and the key
 * reader are all injected with production defaults so the hellgate drives the
 * full construction path with zero real I/O and zero wall-clock.
 */

import { readResolvedToken } from "@/auth/chatgpt-oauth"
import type { RealtimePort } from "@/realtime"
import {
  createDefaultPlayback,
  createDefaultVoiceSession,
  createOpenAIRealtimeAdapter,
  type MicPump,
  type PlaybackChild,
  type PlaybackSpawner,
} from "@/realtime/voice-session"
import { errMessage, logger } from "@/shared"
import {
  createPlatformRecorder,
  DEFAULT_BACKENDS,
  defaultRecorderSpawner,
  type RecorderBackend,
  type RecorderSpawner,
} from "@/voice"
import type { VoiceLiveControl, VoiceLiveCtx, VoiceLiveKeyReader } from "../voice-live-cmd"

/** Realtime WS endpoint default (overridable via `QUANTA_VOICE_LIVE_ENDPOINT`). */
const DEFAULT_ENDPOINT = "wss://api.openai.com/v1/realtime"
/** Realtime model default (overridable via `QUANTA_VOICE_LIVE_MODEL`). */
const DEFAULT_MODEL = "gpt-realtime"
/** Capture sample rate the recorder backends emit (sox/arecord default). */
const CAPTURE_RATE = 16_000

/**
 * Resolve the OpenAI bearer for the Realtime API at the composition root —
 * the realtime slice NEVER reads env or `@/auth` itself (it takes `auth` as a
 * resolved value). Mirrors the llm factory key seam:
 *   1. `OPENAI_API_KEY` (BYOK) wins,
 *   2. else the on-disk ChatGPT-OAuth access token (the `/login` path),
 *   3. else `null` ⇒ the session start() fails cleanly with a typed
 *      `connect-failed`/`auth-failed` (the slash renders the error).
 */
export const resolveRealtimeBearer = async (
  env: Record<string, string | undefined>,
): Promise<string | null> => {
  const direct = env.OPENAI_API_KEY
  if (direct !== undefined && direct.length > 0) return direct
  try {
    const resolved = await readResolvedToken(env)
    const token = resolved?.record.access_token
    return token !== undefined && token.length > 0 ? token : null
  } catch (e) {
    logger.warn(`voice-live: bearer resolution failed: ${errMessage(e)}`)
    return null
  }
}

/** Build a production `PlaybackSpawner` (Bun.which + Bun.spawn). Injected in
 *  tests so playback construction is driven with zero real I/O. */
export const defaultPlaybackSpawner = (): PlaybackSpawner => ({
  which(cmd) {
    return Bun.which(cmd) ?? null
  },
  spawn(argv): PlaybackChild {
    const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    const stdin = proc.stdin as { write: (c: Uint8Array) => void; end: () => void } | null
    return {
      write(chunk) {
        stdin?.write(chunk)
      },
      end() {
        stdin?.end()
      },
      kill(signal) {
        try {
          proc.kill(signal as number | undefined)
        } catch {
          // best-effort teardown
        }
      },
    }
  },
})

/** Best-effort child teardown — never throws (a kill on an exited child can). */
const killChildQuietly = (child: { kill(sig: string): void } | null): void => {
  try {
    child?.kill("SIGTERM")
  } catch {
    // best-effort teardown
  }
}

/** Minimal structural reader — matches BOTH the DOM and node `stream/web`
 *  `ReadableStreamDefaultReader` shapes so the helper accepts whatever
 *  `child.stdout.getReader()` returns regardless of lib resolution. */
interface MicStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
  cancel(): Promise<void>
}

/** Drain a recorder stdout reader frame-by-frame into `onChunk` until the
 *  stream ends or `isStopped()` flips. Swallows tear-down errors (stop() /
 *  recorder exit). Owns NO timer — purely event-driven off the stream. */
const drainMicStream = async (
  reader: MicStreamReader,
  onChunk: (chunk: Uint8Array) => void,
  isStopped: () => boolean,
): Promise<void> => {
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || isStopped()) break
      if (value !== undefined && value.byteLength > 0) onChunk(value)
    }
  } catch {
    // stream torn down — stop() already requested or recorder exited.
  }
}

/**
 * Build a streaming `MicPump` over a recorder spawner + backend. The session's
 * recorder dep is the availability probe ONLY; the up-stream is driven by this
 * pump, which reads the recorder child's stdout chunk-by-chunk and forwards
 * each frame. `stop()` is idempotent and kills the child + cancels the reader.
 *
 * NO timer is owned here — the pump is purely event-driven off the stream.
 */
export const buildMicPump = (
  spawner: RecorderSpawner,
  backend: RecorderBackend,
  rate: number,
): MicPump => ({
  start(onChunk: (chunk: Uint8Array) => void): () => void {
    let stopped = false
    let child: ReturnType<RecorderSpawner["spawn"]> | null = null
    try {
      child = spawner.spawn(backend.buildArgv({ rate, channels: 1, format: "wav" }))
    } catch (e) {
      logger.warn(`voice-live: mic pump spawn failed: ${errMessage(e)}`)
      return () => {}
    }
    const stream = child.stdout
    if (stream === null) {
      killChildQuietly(child)
      return () => {}
    }
    const reader = stream.getReader()
    const liveChild = child
    void drainMicStream(reader, onChunk, () => stopped)
    return () => {
      if (stopped) return
      stopped = true
      try {
        reader.cancel().catch(() => {})
      } catch {
        // best-effort
      }
      killChildQuietly(liveChild)
    }
  },
})

/** A raw-mode keypress reader that maps the live-voice control keys to the
 *  session ops the slash drives:
 *    - `m` ⇒ mute toggle
 *    - space / enter ⇒ push-to-talk commit
 *    - `i` ⇒ interrupt (barge-in)
 *    - `q` / Esc / Ctrl+C ⇒ end
 *  Returns `null` when stdin closes. Injected in tests (a scripted reader). */
export interface KeypressStdin {
  readonly isTTY?: boolean
  setRawMode?(mode: boolean): void
  resume(): void
  pause(): void
  on(event: "keypress", cb: (str: string | undefined, key: KeypressKey) => void): void
  off(event: "keypress", cb: (str: string | undefined, key: KeypressKey) => void): void
}

export interface KeypressKey {
  readonly name?: string
  readonly ctrl?: boolean
}

/** Map a single keypress to a control, or `undefined` to ignore it. */
const keyToControl = (str: string | undefined, key: KeypressKey): VoiceLiveControl | undefined => {
  if (key.ctrl && key.name === "c") return "end"
  switch (key.name) {
    case "escape":
    case "q":
      return "end"
    case "m":
      return "mute"
    case "i":
      return "interrupt"
    case "space":
    case "return":
      return "push"
    default:
      return str === " " ? "push" : undefined
  }
}

/** Build a `VoiceLiveKeyReader` over a raw-mode keypress stdin. Each `next()`
 *  resolves with the NEXT mapped control, `null` when input closes or the
 *  caller's AbortSignal fires. */
export const buildKeypressReader = (stdin: KeypressStdin): VoiceLiveKeyReader => ({
  next(signal: AbortSignal): Promise<VoiceLiveControl | null> {
    return new Promise<VoiceLiveControl | null>((resolve) => {
      let settled = false
      const onKey = (str: string | undefined, key: KeypressKey): void => {
        const ctrl = keyToControl(str, key)
        if (ctrl === undefined) return
        finish(ctrl)
      }
      const onAbort = (): void => finish(null)
      const finish = (v: VoiceLiveControl | null): void => {
        if (settled) return
        settled = true
        stdin.off("keypress", onKey)
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      }
      if (signal.aborted) {
        resolve(null)
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
      stdin.on("keypress", onKey)
    })
  },
})

export interface VoiceLiveWireDeps {
  /** Env source (the host's already-loaded env). Used for the opt-in gate +
   *  endpoint/model/voice overrides + bearer resolution — NOT read by the
   *  realtime slice. */
  readonly env: Record<string, string | undefined>
  /** TTY probe. Non-TTY ⇒ no key reader is built (the slash declines). */
  readonly isTty: boolean
  /** Injected clock — event timestamps only (no `Date.now` in src). */
  readonly now: () => number
  /** Resolved bearer override (test seam). When omitted, resolved from env. */
  readonly resolveBearer?: (env: Record<string, string | undefined>) => Promise<string | null>
  /** Transport factory (test seam). Defaults to the OpenAI Realtime adapter. */
  readonly transportFactory?: () => RealtimePort
  /** Recorder spawner (test seam). Defaults to the platform recorder spawner. */
  readonly recorderSpawner?: RecorderSpawner
  /** Playback spawner (test seam). Defaults to the Bun spawn-cascade. */
  readonly playbackSpawner?: PlaybackSpawner
  /** Keypress stdin (test seam). Defaults to `process.stdin`. Absent reader on
   *  non-TTY ⇒ the slash declines cleanly. */
  readonly keypressStdin?: KeypressStdin
}

/** Whether the opt-in knob is set. Default-OFF: any value other than `"1"` /
 *  `"on"` / `"true"` keeps the feature dark. */
export const voiceLiveEnabled = (env: Record<string, string | undefined>): boolean => {
  const raw = env.QUANTA_VOICE_LIVE?.trim().toLowerCase()
  return raw === "1" || raw === "on" || raw === "true"
}

/**
 * Build the `/voice-live` slash ctx WHEN the opt-in gate is satisfied; else
 * `undefined` (default-OFF — the dispatcher then never routes `/voice-live`
 * to a session, byte-identical REPL).
 *
 * The returned ctx carries a CONSTRUCTED `RealtimeVoiceSessionPort` (real
 * transport + recorder probe + playback + streaming mic pump + injected clock)
 * plus the resolved endpoint/model/voice + a raw-mode key reader (TTY only).
 * The bearer is resolved here (composition root) and threaded in as `auth`.
 */
export const buildVoiceLiveCtx = async (
  deps: VoiceLiveWireDeps,
): Promise<VoiceLiveCtx | undefined> => {
  if (!voiceLiveEnabled(deps.env)) return undefined

  const recorderSpawner = deps.recorderSpawner ?? defaultRecorderSpawner()
  const playbackSpawner = deps.playbackSpawner ?? defaultPlaybackSpawner()
  const transport = (deps.transportFactory ?? (() => createOpenAIRealtimeAdapter()))()
  const recorder = createPlatformRecorder(recorderSpawner, DEFAULT_BACKENDS)
  const playback = createDefaultPlayback({ spawner: playbackSpawner })

  // Resolve the recorder backend now so the pump uses the SAME binary the
  // availability probe will report. Absent backend ⇒ the recorder probe in
  // `session.start()` returns mic-permission and the slash renders it cleanly.
  const backend = DEFAULT_BACKENDS.find((b) => recorderSpawner.which(b.bin) !== null)
  const pump: MicPump =
    backend !== undefined
      ? buildMicPump(recorderSpawner, backend, CAPTURE_RATE)
      : { start: () => () => {} }

  const session = createDefaultVoiceSession({
    transport,
    recorder,
    playback,
    pump,
    now: deps.now,
    captureRate: CAPTURE_RATE,
  })

  const bearer = await (deps.resolveBearer ?? resolveRealtimeBearer)(deps.env)

  // TTY-only key reader. Non-TTY ⇒ omit it; the slash declines cleanly
  // ("requires an interactive terminal", exit 0) and never auto-runs a mic.
  const keys: VoiceLiveKeyReader | undefined =
    deps.isTty && deps.keypressStdin !== undefined
      ? buildKeypressReader(deps.keypressStdin)
      : undefined

  const endpoint = deps.env.QUANTA_VOICE_LIVE_ENDPOINT ?? DEFAULT_ENDPOINT
  const model = deps.env.QUANTA_VOICE_LIVE_MODEL ?? DEFAULT_MODEL
  const voice = deps.env.QUANTA_VOICE_LIVE_VOICE

  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    session,
    ...(keys !== undefined ? { keys } : {}),
    endpoint,
    model,
    ...(bearer !== null ? { auth: bearer } : {}),
    ...(voice !== undefined ? { voice } : {}),
  }
}
