/**
 * `mcp/server-builder.ts` — TICKET-19 reverse-MCP: the SECURITY boundary.
 *
 * quanta-as-an-MCP-server lets an EXTERNAL client (Claude Desktop, Cursor, any
 * MCP host) call quanta's tools over stdio JSON-RPC. That makes the tool
 * whitelist an RCE fence: an unguarded `bash`/`write` exposed to an external
 * client is remote code execution. {@link buildMcpServer} is that fence, and it
 * is deliberately a TINY PURE function so it is 100% unit-testable in isolation:
 *
 *     exposed = { tools where readOnly(name) === true } ∪ explicitOptIn
 *
 * Default-OFF for danger: with no `explicitOptIn`, ONLY read-only tools are
 * reachable. A mutating tool appears IFF the operator named it via
 * `QUANTA_MCP_SERVER_EXPOSE` (resolved at the composition root, validated
 * against the registry there). An unknown name in `explicitOptIn` can NEVER
 * widen the surface — the intersection with the registry's actual tool set is
 * the only thing that counts.
 *
 * Slice posture: this file (and {@link file://./server.ts}) take DUCK-TYPED
 * injected ports ({@link ToolListSource}, {@link ToolCallPort}) and import
 * NEITHER `@/agent` NOR `@/tool` — the `@/mcp` slice fence forbids it. The real
 * `dispatchTool` + `ToolRegistry` are bound by the adapter at the composition
 * root (`src/apps/cli/mcp-server-setup.ts`), the ONLY place `@/agent` + `@/mcp`
 * meet.
 */

import { McpServer, type McpServerCtorOptions } from "./server"

/** A model-facing tool spec (duck-typed mirror of `@/tool`'s `ToolSpec`, kept
 *  LOCAL so the `@/mcp` slice never imports `@/tool`). */
export interface ServerToolSpec {
  readonly name: string
  readonly description: string
  readonly input_schema: unknown
}

/** The read-only side of the registry, injected. `specs()` enumerates the tool
 *  surface; `readOnly(name)` is the WHITELIST SSOT (mirrors
 *  `ToolRegistry.isReadOnly` + `ToolRisk==='read-only'`). Duck-typed so the
 *  slice never imports `@/tool`. */
export interface ToolListSource {
  readonly specs: () => ReadonlyArray<ServerToolSpec>
  readonly readOnly: (name: string) => boolean
}

/** A folded tool dispatch, injected. The composition-root adapter wraps the
 *  REAL `dispatchTool(...)` (full permission / HARD_DENY / HITL / jail /
 *  redactSecrets pipeline) and folds its `DispatchResult` to `{ text, isError }`.
 *  No-throw by contract is NOT assumed here — {@link McpServer} maps a thrown
 *  port to `-32603` so a buggy adapter never wedges the pump. */
export type ToolCallPort = (
  name: string,
  args: unknown,
) => Promise<{ text: string; isError: boolean }>

/** Options for {@link buildMcpServer}. `write` + `toolList` are required; the
 *  `toolCall` port is OPTIONAL because a list-only server (negotiation /
 *  introspection harness, or a test that never calls a tool) is valid — an
 *  absent port surfaces every `tools/call` as `-32603` rather than a hard
 *  dependency. */
export interface McpServerOptions {
  readonly toolList: ToolListSource
  readonly write: (line: string) => void
  /** REAL folded dispatch. Absent ⇒ every `tools/call` is `-32603`. */
  readonly toolCall?: ToolCallPort
  /** Per-tool opt-in (operator `QUANTA_MCP_SERVER_EXPOSE`). Default empty ⇒
   *  read-only-only. An unknown name here NEVER widens the surface. */
  readonly explicitOptIn?: readonly string[]
  /** Page size for `tools/list` pagination (default {@link DEFAULT_PAGE_SIZE}). */
  readonly pageSize?: number
}

/** Default `tools/list` page size. Mirrors a conservative MCP host default; the
 *  cursor round-trips regardless, so this only bounds per-frame size. */
export const DEFAULT_PAGE_SIZE = 50

/**
 * Build the {@link McpServer} over the security whitelist.
 *
 * PURE: no IO, no env reads, no clock. The whitelist is computed ONCE here from
 * `readOnly(name) ∪ explicitOptIn`, intersected with the registry's actual tool
 * set, so an unknown opt-in name is silently dropped (never widens). The
 * resulting server's `tools/list` and `tools/call` both consult this single
 * frozen set — there is no second code path that could disagree.
 */
export const buildMcpServer = (opts: McpServerOptions): McpServer => {
  const optIn = new Set(opts.explicitOptIn ?? [])
  // The whitelist: a registry tool is exposed iff it is read-only OR explicitly
  // opted in. Computed from `specs()` so an opt-in name absent from the registry
  // is dropped (the `.filter` only ever sees real tools).
  const exposed = new Set(
    opts.toolList
      .specs()
      .map((s) => s.name)
      .filter((name) => opts.toolList.readOnly(name) || optIn.has(name)),
  )

  const ctor: McpServerCtorOptions = {
    toolList: opts.toolList,
    write: opts.write,
    // The whitelist predicate IS the fence — both `tools/list` projection and
    // the `tools/call` admit-check read this one frozen set.
    readOnlyPolicy: (name) => exposed.has(name),
    ...(opts.toolCall !== undefined ? { toolCall: opts.toolCall } : {}),
    ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
  }
  return new McpServer(ctor)
}

export type { McpServer } from "./server"
