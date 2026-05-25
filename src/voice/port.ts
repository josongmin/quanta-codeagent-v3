/**
 * Voice slice — AudioRecorderPort (ADR-0208).
 *
 * Handle-based recorder primitive. Distinct from {@link
 * `@/media/voice/port`}'s `captureOnce()` shape (ADR-0202), which is a
 * one-shot fixed-duration capture. The handle model lets the surface drive
 * an interactive `/voice` flow:
 *
 *   const h = await rec.start({ rate: 16000 })
 *   if (!h.ok) renderErr(h.error)        // backend missing / spawn failed
 *   else {
 *     await sleepUntilEnterOrEsc()       // user holds the line
 *     const wav = await rec.stop(h.value) // SIGTERM + drain → Buffer
 *     if (!wav.ok) renderErr(wav.error)
 *     else transcribe(wav.value)
 *   }
 *
 * Both ports coexist by design — the leaf one-shot port is the right
 * primitive for non-interactive surfaces (CI smoke, scripted tests), the
 * handle port is the right primitive for the `/voice` slash command and
 * future hold-to-talk keyboard trigger.
 *
 * Plane-clean: imports only `@/shared`. Zero `@/agent` / `@/tool` /
 * `@/llm` / `@/permission` / `@/mcp` — voice is an input channel, not a
 * tool, not a permission, not an LLM call.
 *
 * Contract:
 *   - NO-THROW: every method returns `Result<…>`. Programmer-bug input is
 *     also encoded as `Err`.
 *   - `availability()`: synchronous probe. Returns the backend NAME (e.g.
 *     `"sox"` / `"arecord"` / `"parec"`) when the binary is on PATH, or
 *     `null` when none of the platform's recorders are installed.
 *   - `start()`: spawn the recorder. Returns a `RecorderHandle` containing
 *     the spawned child + format metadata. The handle is opaque — only
 *     `stop()` knows how to terminate it.
 *   - `stop(handle)`: SIGTERM the child, drain stdout, return the wav
 *     bytes. Idempotent — calling stop on an already-stopped handle returns
 *     the buffered bytes (or empty if never received any). MUST clean up
 *     listeners even on the second call.
 *   - The handle holds the SoxSpawnedChild-equivalent so the recorder
 *     module owns spawn/kill, but the surface decides when to stop.
 *   - `start({ signal })`: when the AbortSignal fires AFTER start, the
 *     handle's internal `stop()` is invoked (the surface still calls
 *     `rec.stop(handle)` to receive the bytes — abort just terminates
 *     the recording early without auto-draining).
 */

import type { Result } from "@/shared"
import type { AudioBytes, RecorderError, RecorderHandle, RecorderStartOpts } from "./types"

export interface AudioRecorderPort {
  /** Synchronous probe — returns the backend name (`"sox"` / `"arecord"` /
   *  `"parec"`) if a recorder is on PATH, else `null`. Surfaces use this
   *  to gate the `/voice` slash registration. */
  availability(): string | null

  /** Spawn the recorder. The returned handle is opaque — the surface
   *  passes it back to `stop()` unchanged. Operational failures
   *  (backend missing, spawn failure, invalid opts) return `Err`. */
  start(opts?: RecorderStartOpts): Promise<Result<RecorderHandle, RecorderError>>

  /** Terminate the recorder and drain stdout into a wav buffer. Idempotent:
   *  a second call on the same handle returns the already-drained bytes
   *  (or empty when nothing arrived). NEVER throws. */
  stop(handle: RecorderHandle): Promise<Result<AudioBytes, RecorderError>>
}
