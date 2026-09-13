/**
 * NW-2 (sep-14) — why an over-budget tool output was NOT persisted to disk.
 *
 * Canonically defined in `@/shared` because the refusal is carried as a field
 * past the tool slice: `ToolResult.evidence.spillRefusal` (`@/tool`) is flattened
 * onto `DispatchResult` (`@/agent`), the `tool_result` AgentEvent (`@/stream`,
 * which may only depend on `@/shared`) and the JSONL `tool_result` data
 * (`ToolResultData`, `@/shared/trajectory`). `@/tool/output-spill` re-exports
 * these next to the renderers, so its import surface is unchanged.
 */

/** Closed set of refusal kinds; each kind renders exactly one reason
 *  (`SPILL_DIR_REFUSAL_REASON` in `@/tool/output-spill`). The first three are
 *  containment refusals; `unavailable` (opening the directory) and
 *  `write-failed` (writing the spill file into the opened directory) are IO
 *  failures. Either way nothing is pruned. */
export const SPILL_DIR_REFUSAL_KINDS = [
  "not-spill-location",
  "symlink",
  "not-a-directory",
  "unavailable",
  "write-failed",
] as const
export type SpillDirRefusalKind = (typeof SPILL_DIR_REFUSAL_KINDS)[number]

/** What each refusal kind carries besides its `kind`. `path` is the component
 *  that failed its check (the whole spill dir for `not-spill-location`, the
 *  spill file for `write-failed`). Only the IO kinds have a `cause`, and they
 *  always have one. */
interface SpillDirRefusalDetail {
  readonly "not-spill-location": { readonly path: string }
  readonly symlink: { readonly path: string }
  readonly "not-a-directory": { readonly path: string }
  readonly unavailable: { readonly path: string; readonly cause: string }
  readonly "write-failed": { readonly path: string; readonly cause: string }
}

export type SpillDirRefusalOf<K extends SpillDirRefusalKind> = {
  readonly kind: K
} & SpillDirRefusalDetail[K]

export type SpillDirRefusal = {
  [K in SpillDirRefusalKind]: SpillDirRefusalOf<K>
}[SpillDirRefusalKind]
