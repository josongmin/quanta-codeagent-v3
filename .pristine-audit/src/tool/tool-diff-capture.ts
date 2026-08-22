import type { ToolContext } from "./types"

/**
 * ADR-0440 wire-finish — shared tool-diff capture helper for the file-mutating
 * tools (`write`/`edit`).
 *
 * Hands the duck-typed {@link ToolContext.toolDiff} sink the full pre/post file
 * text the tool ALREADY computed for its mutation (NO recompute, NO second read
 * — the caller passes the strings it has in hand). The web-daemon composition
 * root wires the concrete sink ONLY when `QUANTA_WEB_CANVAS=1`; the sink turns
 * the before/after into a `tool.diff` canvas frame (the line-diff math runs
 * exactly once inside the daemon's `feedToolDiff`, never here).
 *
 * DEFAULT-OFF / byte-identical: when `ctx.toolDiff` is absent (gate OFF, the
 * common path) OR `ctx.toolCallId` is absent (no call correlation) this is a
 * single `undefined` check and a no-op — zero allocation, no capture, the tool
 * is byte-identical to the pre-ADR path. NO-THROW: the sink is no-throw by
 * contract, but we belt-and-brace with a try/catch so a misbehaving sink can
 * NEVER break a successful mutation (the file is already written).
 *
 * Extracted into one function so neither tool inlines the branch (keeps their
 * `execute` cognitive-complexity flat) and the capture semantics are a single
 * source of truth.
 */
export const captureToolDiff = (
  ctx: ToolContext,
  before: string,
  after: string,
  path: string,
): void => {
  const sink = ctx.toolDiff
  const toolCallId = ctx.toolCallId
  if (sink === undefined || toolCallId === undefined) return
  try {
    sink.capture({ toolCallId, before, after, path })
  } catch {
    // The mutation already succeeded; a throwing observation sink must never
    // surface as a tool failure. Swallow (the daemon-side sink is no-throw by
    // contract — this is belt-and-braces for a hostile/buggy injection).
  }
}
