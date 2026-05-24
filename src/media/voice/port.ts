import type { Result } from "@/shared"
import type { AudioBlob, CaptureError } from "./types"

/** Capture-once knobs. `secs` must be > 0; `signal` aborts mid-capture and
 *  resolves with `Err({kind:"aborted"})` after SIGTERM clean-up. */
export interface CaptureOpts {
  readonly secs?: number
  readonly signal?: AbortSignal
}

/**
 * Single-mic capture primitive (ADR-0202). `captureOnce` is one-shot —
 * spawn recorder, accumulate stdout, return on natural exit OR abort.
 * `stop()` is a side-channel cancellation lever for surfaces that hold a
 * UI button instead of an AbortSignal; calling it while no capture is
 * in flight is a no-op.
 *
 * Operational failures (sox missing, abort, spawn failure) return Err.
 * Programmer-bug input (secs ≤ 0) also returns Err — the call site is
 * expected to validate before reaching the port, but we Err defensively
 * to keep the contract pure.
 */
export interface VoiceInputPort {
  captureOnce(opts?: CaptureOpts): Promise<Result<AudioBlob, CaptureError>>
  stop(): void
}
