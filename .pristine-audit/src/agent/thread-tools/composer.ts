/**
 * Tool composer (ADR-0206).
 *
 * PURE function — merges a `global` and `perThread` `Tool[]` into one
 * `Tool[]`. When a name appears in BOTH arrays the per-thread entry
 * WINS (Codex MCP-server-override semantic — a thread can shadow a
 * global tool with a thread-local variant carrying the same name).
 *
 * The composer does NOT call the registry: callers do
 * `registry.list(tid).map(spec => registry.resolve(tid, spec.name))`
 * (filtering out `Err`s) and pass the resulting `Tool[]` here.
 *
 * Plane-clean: imports only `@/tool` (the duck-typed `Tool` shape).
 */

import type { Tool } from "@/tool"

/** Merge `global` + `perThread`. Per-thread entries override globals
 *  with the same `name`. The returned array preserves the input order
 *  (globals first, then per-thread additions; overridden globals are
 *  REPLACED in-place — not appended). Returned array is frozen so
 *  downstream consumers cannot mutate it. */
export const composeTools = (
  global: readonly Tool[],
  perThread: readonly Tool[],
): readonly Tool[] => {
  if (perThread.length === 0) return global
  const overrides = new Map<string, Tool>()
  for (const t of perThread) overrides.set(t.name, t)

  const out: Tool[] = []
  const seen = new Set<string>()
  for (const g of global) {
    const override = overrides.get(g.name)
    if (override !== undefined) {
      out.push(override)
      seen.add(g.name)
    } else {
      out.push(g)
      seen.add(g.name)
    }
  }
  // Per-thread tools not present in `global` are appended in their
  // original order (Map iteration is insertion-order).
  for (const t of perThread) {
    if (!seen.has(t.name)) {
      out.push(t)
      seen.add(t.name)
    }
  }
  return Object.freeze(out)
}
