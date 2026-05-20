/** DispatchResult shape extracted to break a circular import:
 *  `admissibility-gate.ts` returns this; `dispatch.ts` consumes it. Splitting
 *  the type out of `dispatch.ts` lets both files import it without one having
 *  to depend on the other's full implementation surface. */

import type { ToolResultBlock } from "@/llm"

export interface DispatchResult {
  block: ToolResultBlock
  ok: boolean
  preview: string
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
}
