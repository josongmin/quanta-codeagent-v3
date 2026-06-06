/**
 * file_history_rewind — shared capture helper for the file-mutating tools
 * (`write` / `edit`).
 *
 * Hands the duck-typed {@link ToolContext.fileHistory} sink the file's NEW
 * bytes the tool ALREADY has in hand (NO recompute, NO extra read). The host
 * composition root wires the concrete sink ONLY when `QUANTA_FILE_HISTORY` is
 * on; the sink resolves + jails the path internally and records a per-path
 * version in the session {@link FileHistoryStore} the `file_history_rewind`
 * tool reads.
 *
 * DEFAULT-OFF / byte-identical: when `ctx.fileHistory` is absent (gate OFF, the
 * common path) this is a single `undefined` check and a no-op — zero
 * allocation, no capture, the tool is byte-identical to the pre-feature path.
 * NO-THROW: the sink is no-throw by contract, but we belt-and-brace with a
 * try/catch so a misbehaving sink can NEVER break a successful mutation (the
 * file is already written).
 *
 * Extracted into one function so neither tool inlines the branch (keeps their
 * `execute` cognitive-complexity flat) and the capture semantics are a single
 * source of truth.
 */

import type { ToolContext } from "../types"

export const captureFileHistory = (ctx: ToolContext, path: string, content: string): void => {
  const sink = ctx.fileHistory
  if (sink === undefined) return
  try {
    sink.record({ path, cwd: ctx.cwd, content })
  } catch {
    // The mutation already succeeded; a throwing observation sink must never
    // surface as a tool failure. Swallow (the wired adapter is no-throw by
    // contract — this is belt-and-braces for a hostile/buggy injection).
  }
}
