/**
 * jun-6 exfil-rails (a)+(b) — the shared `ToolResult` guard builders consumed by
 * BOTH the `write` and `edit` tools. Lives in `_shared` so neither tool imports
 * the other (no write↔edit coupling). Pure mapping from the ctx seams to a typed
 * `rejected` `ToolResult` (or `null` to proceed). NO-THROW; default-OFF (both
 * return `null` when their seam is unwired ⇒ byte-identical legacy path).
 */

import type { ToolContext, ToolEvent, ToolResult } from "../types"
import { GLOB_IN_WRITE_MESSAGE, GLOB_IN_WRITE_REASON, pathLooksLikeGlob } from "./glob-in-path"
import { WRITE_BUDGET_REASON, writeBudgetMessage } from "./write-budget"

/** Wrap a `ToolResult | null` deny into the terminal `ToolEvent | null` the
 *  tools yield (uniform with `gitWriteGuardDeny`, lets the guards compose via
 *  `??` without an extra branch per guard — keeps `execute` complexity flat). */
const asEvent = (result: ToolResult | null): ToolEvent | null =>
  result === null ? null : { type: "result", result }

/** (b) glob-in-write guard. Returns a typed `rejected` result (verbatim cc-cli
 *  message) when the guard is ENABLED (`ctx.globWriteGuard === true`) AND `path`
 *  is a glob pattern, else `null`. Default-OFF: flag absent/false ⇒ `null`. */
export const globWriteGuardDeny = (path: string, ctx: ToolContext): ToolResult | null => {
  if (ctx.globWriteGuard !== true || !pathLooksLikeGlob(path)) return null
  return {
    ok: false,
    output: GLOB_IN_WRITE_MESSAGE,
    failure: { mode: "rejected", reason: GLOB_IN_WRITE_REASON },
  }
}

/** (a) per-turn write-budget check. Calls the optional budget port's
 *  `recordWrite()` and maps a non-`ok` verdict to a typed `rejected` result, or
 *  `null` to proceed. Default-OFF: `ctx.writeBudget` absent ⇒ `null` (no counter
 *  touched). The port is INERT in a trusted turn, so this only fires past the cap
 *  in an untrusted-input turn. Shared so `write` + `edit` tally against the SAME
 *  per-turn counter and emit identical text. */
export const writeBudgetDeny = (ctx: ToolContext): ToolResult | null => {
  const port = ctx.writeBudget
  if (port === undefined) return null
  const verdict = port.recordWrite()
  if (verdict === "ok") return null
  return {
    ok: false,
    output: writeBudgetMessage(port.maxWritesPerTurn),
    failure: { mode: "rejected", reason: WRITE_BUDGET_REASON },
  }
}

/** Event-returning wrappers of the two deny builders, for composition via `??`
 *  at the tool's `execute` yield site (uniform with `gitWriteGuardDeny`). */
export const globWriteGuardEvent = (path: string, ctx: ToolContext): ToolEvent | null =>
  asEvent(globWriteGuardDeny(path, ctx))
export const writeBudgetEvent = (ctx: ToolContext): ToolEvent | null =>
  asEvent(writeBudgetDeny(ctx))
