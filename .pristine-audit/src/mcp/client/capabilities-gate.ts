import { asRecord } from "./result-folding"

/** Server-advertised capability predicates (ADR-0431 / H19 / TICKET-20).
 *
 *  Each reads a slot of the `capabilities` record captured from the server's
 *  `initialize` response. Extracted from `McpClient` as pure functions over the
 *  captured record so the capability policy is a cohesive unit, byte-identical
 *  to the former in-class getters. Every predicate returns `false` before
 *  `start()` completes (caps === null) or when the slot is absent/ill-typed —
 *  the advertise-iff-able default that keeps unopted servers byte-identical. */

/** ADR-0431 — does the connected server advertise the `tasks/*` capability?
 *  Reads the `capabilities.tasks` slot captured from the `initialize`
 *  response. Returns `false` before `start()` completes, when the server
 *  omits the slot, or when the slot is not an object. The composition root
 *  uses this to gate the optional MCP-tasks tool surface (default-OFF). */
export function serverSupportsTasks(caps: Record<string, unknown> | null): boolean {
  if (caps === null) return false
  return asRecord(caps.tasks) !== null
}

/** H19 — does the connected server advertise `resources`? Reads the
 *  `capabilities.resources` slot from the `initialize` response. */
export function serverSupportsResources(caps: Record<string, unknown> | null): boolean {
  return caps !== null && asRecord(caps.resources) !== null
}

/** H19 — does the server advertise `resources.subscribe`? A subscribe call is
 *  refused (typed `unsupported`) unless this is true, so we never emit a
 *  `resources/subscribe` the server answers with a raw `-32601`. */
export function serverSupportsResourceSubscribe(caps: Record<string, unknown> | null): boolean {
  if (caps === null) return false
  return asRecord(caps.resources)?.subscribe === true
}

/** H19 — does the connected server advertise `prompts`? */
export function serverSupportsPrompts(caps: Record<string, unknown> | null): boolean {
  return caps !== null && asRecord(caps.prompts) !== null
}

/** RFC04-1 — does the connected server advertise `tools.listChanged`? A
 *  `notifications/tools/list_changed` is delivered to the reload observer as an
 *  invalidation signal ONLY when this is true, so a server that never
 *  negotiated the capability cannot trigger a hot-reload by emitting an
 *  unsolicited notification. Reads `capabilities.tools.listChanged === true`;
 *  `false` before `start()` completes, when the slot is absent, or when
 *  `listChanged` is not literally `true` (advertise-iff-able, fail-closed). */
export function serverSupportsToolsListChanged(caps: Record<string, unknown> | null): boolean {
  if (caps === null) return false
  return asRecord(caps.tools)?.listChanged === true
}

/** TICKET-20 — does the connected server advertise `completions`? An
 *  outbound `completion/complete` is refused locally (typed `unsupported`)
 *  unless this is true, so we never emit a request the server answers with a
 *  raw `-32601`. */
export function serverSupportsCompletions(caps: Record<string, unknown> | null): boolean {
  return caps !== null && asRecord(caps.completions) !== null
}
