/**
 * ADR-0192 — LLM session record/replay sub-barrel.
 *
 * Default-OFF: the parent `@/llm` barrel does NOT re-export this slice.
 * Surfaces opt in by importing `@/llm/replay` explicitly so the recorder /
 * replayer is never silently in the stream path.
 */

export type { JsonlReplayStoreOpts } from "./jsonl-store"
export { defaultHashRequest, jsonlReplayStore, stableStringify } from "./jsonl-store"
export type { RecordingLlmOpts } from "./recording-llm"
export { recordingLlmPort } from "./recording-llm"
export type { OnMissPolicy, ReplayLlmOpts } from "./replay-llm"
export { replayLlmPort } from "./replay-llm"
export type { S3ReplayStoreOpts } from "./s3-replay-store"
export { s3ReplayStore } from "./s3-replay-store"
export {
  type MatchPolicy,
  type RecordedInteraction,
  type ReplayMatchOpts,
  ReplayMissError,
  type ReplayStore,
} from "./types"
