/**
 * Realtime voice-session — default `AudioPlaybackPort` adapter
 * (ADR-0442, RFC §5.2/§6.4). Spawns a platform player and pipes the
 * server-encoded PCM16 frames to its stdin. NO DSP / NO codec — the bytes are
 * already encoded by the Realtime API; we only hand them to a player process.
 *
 * Backend cascade mirrors the recorder (`default-recorder.ts`):
 * `afplay` (macOS) → `ffplay` (cross-platform) → `paplay` (Linux PulseAudio).
 * When none is on PATH, `availability()` returns `null` ⇒ the session degrades
 * to TRANSCRIPT-ONLY (HELL-RTV-08). The spawner is INJECTED so tests drive
 * every path with zero real I/O / no globals.
 *
 * Plane-clean: imports only `@/shared` + sibling types.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import type { AudioPlaybackPort, PlaybackError } from "./playback-port"

/** Minimal spawned-player surface — write PCM to stdin, kill on stop. */
export interface PlaybackChild {
  write(chunk: Uint8Array): void
  end(): void
  kill(signal?: string): void
}

/** Injected spawner — `which` returns the resolved bin path or `null`;
 *  `spawn` launches a player reading PCM16 from stdin. Tests pass a fake. */
export interface PlaybackSpawner {
  which(cmd: string): string | null
  spawn(argv: readonly string[]): PlaybackChild
}

/** A player backend that consumes raw PCM16 mono @ the given rate from stdin. */
export interface PlaybackBackend {
  readonly name: string
  readonly bin: string
  buildArgv(opts: { rate: number }): readonly string[]
}

/** macOS afplay does NOT read raw PCM from stdin; ffplay/paplay do. afplay is
 *  kept for availability parity but the cascade prefers a raw-PCM player. */
export const FFPLAY_BACKEND: PlaybackBackend = {
  name: "ffplay",
  bin: "ffplay",
  buildArgv: ({ rate }) => [
    "ffplay",
    "-nodisp",
    "-autoexit",
    "-loglevel",
    "quiet",
    "-f",
    "s16le",
    "-ar",
    String(rate),
    "-ch_layout",
    "mono",
    "-i",
    "pipe:0",
  ],
}

/** Linux PulseAudio raw-PCM player. */
export const PAPLAY_BACKEND: PlaybackBackend = {
  name: "paplay",
  bin: "paplay",
  buildArgv: ({ rate }) => ["paplay", "--format=s16le", `--rate=${rate}`, "--channels=1"],
}

/** Default cascade — ffplay first (most portable raw-PCM player), paplay
 *  second (Linux). afplay is intentionally NOT in the raw-PCM cascade because
 *  it requires a container file, not a stdin PCM stream. */
export const DEFAULT_PLAYBACK_BACKENDS: ReadonlyArray<PlaybackBackend> = [
  FFPLAY_BACKEND,
  PAPLAY_BACKEND,
]

export interface DefaultPlaybackOpts {
  readonly spawner: PlaybackSpawner
  readonly rate?: number
  readonly backends?: ReadonlyArray<PlaybackBackend>
}

const DEFAULT_RATE = 24_000

/** Resolve the first backend whose bin is on PATH. Pure given the spawner. */
const resolveBackend = (
  spawner: PlaybackSpawner,
  backends: ReadonlyArray<PlaybackBackend>,
): PlaybackBackend | null => {
  for (const b of backends) {
    if (spawner.which(b.bin) !== null) return b
  }
  return null
}

export const createDefaultPlayback = (opts: DefaultPlaybackOpts): AudioPlaybackPort => {
  const backends = opts.backends ?? DEFAULT_PLAYBACK_BACKENDS
  const rate = opts.rate ?? DEFAULT_RATE
  let child: PlaybackChild | null = null

  const ensureChild = (): Result<PlaybackChild, PlaybackError> => {
    if (child) return ok(child)
    const backend = resolveBackend(opts.spawner, backends)
    if (!backend) return err({ kind: "no-player" })
    try {
      child = opts.spawner.spawn(backend.buildArgv({ rate }))
      return ok(child)
    } catch (e) {
      child = null
      return err({ kind: "spawn-failed", degradeReason: errMessage(e) })
    }
  }

  return {
    availability(): string | null {
      return resolveBackend(opts.spawner, backends)?.name ?? null
    },

    play(pcm: Uint8Array): Result<void, PlaybackError> {
      const c = ensureChild()
      if (!c.ok) return c
      try {
        c.value.write(pcm)
        return ok(undefined)
      } catch (e) {
        return err({ kind: "io-error", degradeReason: errMessage(e) })
      }
    },

    async flush(): Promise<void> {
      // The player drains its own stdin buffer; nothing to force here. Kept
      // async so a future buffering impl can await a drain.
      return
    },

    stop(): void {
      if (!child) return
      try {
        child.end()
        child.kill("SIGTERM")
      } catch {
        // best-effort teardown
      }
      child = null
    },
  }
}
