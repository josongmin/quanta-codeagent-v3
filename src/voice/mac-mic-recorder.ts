/**
 * macOS-pinned recorder (ADR-0208).
 *
 * Thin convenience constructor that pins the backend cascade to `[sox]`
 * — on macOS the user installs sox via `brew install sox` and we never
 * want to silently fall back to `arecord` / `parec` (those are
 * Linux-only PulseAudio/ALSA tools that won't run on Darwin).
 *
 * On macOS without sox installed, `availability()` returns `null` and
 * `start()` returns `Err({kind:"backend-missing"})` with a brew-specific
 * degrade message.
 */

import {
  createPlatformRecorder,
  defaultRecorderSpawner,
  type RecorderBackend,
  type RecorderSpawner,
  SOX_BACKEND,
} from "./default-recorder"
import type { AudioRecorderPort } from "./port"

/** macOS cascade — sox only. Linux backends are silently filtered out. */
export const MAC_BACKENDS: ReadonlyArray<RecorderBackend> = [SOX_BACKEND]

/** macOS recorder — sox-only. */
export const createMacMicRecorder = (
  spawner: RecorderSpawner = defaultRecorderSpawner(),
): AudioRecorderPort => createPlatformRecorder(spawner, MAC_BACKENDS)
