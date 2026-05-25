/**
 * Voice slice barrel (ADR-0208).
 *
 * Sibling to `@/media/voice` (ADR-0202). That slice ships the leaf
 * one-shot `captureOnce()` port; this slice ships the handle-based
 * `start()/stop()` port + transcriber port + CLI `/voice` slash. Both
 * coexist; nothing forces a consumer to pick one over the other.
 *
 * Plane-clean: only `@/shared` is imported from this barrel's
 * dependencies. Zero @/agent / @/tool / @/llm / @/mcp / @/permission.
 *
 * Default-OFF: no apps/agent or apps/cli wire imports from this barrel
 * today. The slash command (`voice-cmd.ts`) lives in `apps/cli` and is
 * registered by a surface-level wiring step the user adds later.
 */

export {
  ARECORD_BACKEND,
  createDefaultRecorder,
  createPlatformRecorder,
  DEFAULT_BACKENDS,
  defaultRecorderSpawner,
  PAREC_BACKEND,
  type RecorderBackend,
  type RecorderSpawnedChild,
  type RecorderSpawner,
  SOX_BACKEND,
} from "./default-recorder"
export { createMacMicRecorder, MAC_BACKENDS } from "./mac-mic-recorder"
export type { AudioRecorderPort } from "./port"
export * from "./transcriber"
export type {
  AudioBytes,
  RecorderError,
  RecorderFormat,
  RecorderHandle,
  RecorderInternalResult,
  RecorderStartOpts,
} from "./types"
