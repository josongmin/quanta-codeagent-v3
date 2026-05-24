/**
 * ADR-0192 — LLM session record/replay sub-barrel.
 *
 * Default-OFF: the parent `@/llm` barrel does NOT re-export this slice.
 * Surfaces opt in by importing `@/llm/replay` explicitly so the recorder /
 * replayer is never silently in the stream path.
 */

export { defaultHashRequest, jsonlReplayStore, stableStringify } from "./jsonl-store"
export type { JsonlReplayStoreOpts } from "./jsonl-store"
export { recordingLlmPort } from "./recording-llm"
export type { RecordingLlmOpts } from "./recording-llm"
export { replayLlmPort } from "./replay-llm"
export type { OnMissPolicy, ReplayLlmOpts } from "./replay-llm"
export {
  type MatchPolicy,
  type RecordedInteraction,
  type ReplayMatchOpts,
  ReplayMissError,
  type ReplayStore,
} from "./types"
