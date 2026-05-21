/** DispatchResult shape extracted to break a circular import:
 *  `admissibility-gate.ts` returns this; `dispatch.ts` consumes it. Splitting
 *  the type out of `dispatch.ts` lets both files import it without one having
 *  to depend on the other's full implementation surface. */

import type { ToolResultBlock } from "@/llm"
import type { ToolFailure } from "@/tool"

export interface DispatchResult {
  block: ToolResultBlock
  ok: boolean
  preview: string
  /** OPTIONAL (absorb #2 — Cursor failure model): the typed failure reason
   *  surfaced verbatim from `ToolResult.failure` during normalization. Lets the
   *  loop/recorders branch on the failure KIND rather than parsing `preview`.
   *  Omitted on success and whenever the tool did not classify its failure
   *  (exactOptionalPropertyTypes: never set to `undefined`), so callers that do
   *  not read it are byte-identical. */
  failure?: ToolFailure
  /** Wall time of the tool execution in ms (RFC-0002 §5.2 evidence). Set for
   *  every executed tool; absent only on pre-execute deny short-circuits. */
  durationMs?: number
  /** Bounded tail of the tool's stderr, when the ToolResult exposes one
   *  (shell-class tools). Omitted — never null — for tools without stderr. */
  stderrTail?: string
  /** Process exit code for shell-class tools, when the ToolResult exposes it. */
  exitCode?: number
  /** Path to a persisted full log, only when the tool actually wrote one. */
  fullLogPath?: string
  /**
   * ADR-0076 Gap-4 (`deny_and_steer` — Cursor REJECT_AND_TELL). Set ONLY on a
   * deny short-circuit produced when `onConfirm` returned a structured
   * `{ decision: "deny_and_steer", steer }`: carries the non-empty corrective
   * instruction the loop injects as the NEXT-TURN user message (atomic with the
   * deny). Omitted on every other path (exactOptionalPropertyTypes: never
   * `undefined`), so callers that do not read it are byte-identical. The gate
   * only ATTACHES the steer to the deny result — the loop owns the actual
   * next-turn injection (see the ADR-0076 hand-off note in
   * `admissibility-gate.ts`).
   */
  steerInjection?: string
}
