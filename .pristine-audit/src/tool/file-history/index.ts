/**
 * file_history_rewind slice barrel (@/tool/file-history).
 *
 * Per-file session-snapshot store + the `file_history_rewind` list/restore tool
 * + the write/edit capture sink. Default-OFF behind `QUANTA_FILE_HISTORY`:
 * unset ⇒ no store constructed, no sink wired (no capture), the tool not
 * registered ⇒ byte-identical. See `store.ts` for the bounded-ring rationale.
 */

export { captureFileHistory } from "./capture"
export { createFileHistorySink } from "./sink"
export {
  createFileHistoryStore,
  DEFAULT_FILE_HISTORY_BOUNDS,
  type FileHistoryBounds,
  type FileHistoryStore,
  type FileHistoryStoreOptions,
  type FileVersion,
} from "./store"
export { makeFileHistoryRewindTool } from "./tool"
