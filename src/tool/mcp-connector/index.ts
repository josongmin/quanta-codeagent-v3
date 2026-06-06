/**
 * N2 — MCP connector discovery tools (`mcp_connector_list` / `mcp_connector_install`).
 *
 * Discover MCP servers from a catalog + install one into `.mcp.json` — vs the
 * agent hand-editing config. Pairs with H18 (OAuth = auth; this = discovery).
 *
 * Slice posture: `@/tool` may NOT import `@/connectors` / `@/mcp` (fence), so the
 * tools speak to a DUCK-TYPED {@link McpConnectorDiscoveryPort}. The HOST owns
 * the heavy lifting (the catalog source + the `toMcpServerConfig` transform +
 * the real `.mcp.json` writer); these tools are a thin model-facing surface.
 * NO-THROW: every path yields a typed `ok:false`.
 *
 * DEFAULT-OFF: registered ONLY when the host wires a discovery port
 * (`DefaultToolPorts.mcpConnectors`, gated on `QUANTA_MCP_CONNECTORS`); absent ⇒
 * not in the menu ⇒ byte-identical.
 */

import { z } from "zod"
import { errMessage } from "@/shared/errors"
import type { Tool, ToolContext, ToolEvent, ToolFailure, ToolResult } from "../types"

/** One catalog entry as the model sees it (duck-typed view). */
export interface McpConnectorEntryView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly transport: "stdio" | "http"
  readonly requiresOAuth?: boolean
}

/** Outcome of an install attempt (host performs the `.mcp.json` write). */
export type McpInstallOutcome =
  | { readonly ok: true; readonly name: string; readonly alreadyPresent?: boolean }
  | { readonly ok: false; readonly error: string }

/** Duck-typed host port: the catalog source + the install action. */
export interface McpConnectorDiscoveryPort {
  list(): readonly McpConnectorEntryView[]
  /** Install the catalogued server `id` into `.mcp.json`. Host-side: resolves
   *  the entry, transforms to the server config, writes the config. */
  install(id: string): Promise<McpInstallOutcome> | McpInstallOutcome
}

const ok = (output: string): ToolResult => ({ ok: true, output })
const err = (output: string, failure: ToolFailure): ToolResult => ({ ok: false, output, failure })

/** Canonical shared extractor — also survives a hostile throw whose stringifier
 *  itself throws (this NO-THROW boundary must not re-throw while building its
 *  own error string). Identical output for the Error / string cases. */
const errMsg = errMessage

export const mcpConnectorListInputSchema = z.object({
  transport: z
    .enum(["stdio", "http"])
    .optional()
    .describe("Filter to one transport; omit for all."),
})
export type McpConnectorListInput = z.infer<typeof mcpConnectorListInputSchema>

export const mcpConnectorInstallInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Catalog id of the MCP server to install (from mcp_connector_list)."),
})
export type McpConnectorInstallInput = z.infer<typeof mcpConnectorInstallInputSchema>

const renderEntry = (e: McpConnectorEntryView): string => {
  const oauth = e.requiresOAuth === true ? " [oauth]" : ""
  return `  ${e.id} — ${e.name} (${e.transport}${oauth}): ${e.description}`
}

/** Run the host install action and map every outcome (throw / typed failure /
 *  success) to ONE typed `ToolResult`. NO-THROW boundary (Tool contract §2):
 *  the host writer may reject — collapse it to a typed `error` result rather
 *  than reject the tool's iterator. */
const runInstall = async (port: McpConnectorDiscoveryPort, id: string): Promise<ToolResult> => {
  let outcome: McpInstallOutcome
  try {
    outcome = await port.install(id)
  } catch (e) {
    const msg = errMsg(e)
    return err(`install failed for "${id}": ${msg}`, { mode: "error", modelVisibleError: msg })
  }
  if (!outcome.ok) {
    return err(`cannot install "${id}": ${outcome.error}`, {
      mode: outcome.error === "unknown-id" ? "not_found" : "rejected",
      ...(outcome.error === "unknown-id" ? {} : { reason: outcome.error }),
    } as ToolFailure)
  }
  const note = outcome.alreadyPresent === true ? " (already present — updated)" : ""
  return ok(`Installed MCP connector "${outcome.name}"${note}.`)
}

const makeListTool = (port: McpConnectorDiscoveryPort): Tool<McpConnectorListInput> => ({
  name: "mcp_connector_list",
  description:
    "Discover installable MCP servers from the connector catalog (id, name, " +
    "transport, OAuth requirement). Optional `transport` filter. Read-only.",
  inputSchema: mcpConnectorListInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input: McpConnectorListInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = mcpConnectorListInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    if (ctx.signal.aborted) {
      yield {
        type: "result",
        result: err("aborted before start", { mode: "rejected", reason: "aborted" }),
      }
      return
    }
    // NO-THROW boundary (Tool contract §2): a misbehaving host catalog source
    // that throws must surface as a typed result, not reject the iterator.
    let all: readonly McpConnectorEntryView[]
    try {
      all = port.list()
    } catch (e) {
      const msg = errMsg(e)
      yield {
        type: "result",
        result: err(`catalog listing failed: ${msg}`, { mode: "error", modelVisibleError: msg }),
      }
      return
    }
    const items =
      parsed.data.transport !== undefined
        ? all.filter((e) => e.transport === parsed.data.transport)
        : all
    if (items.length === 0) {
      yield { type: "result", result: ok("No MCP connectors in the catalog.") }
      return
    }
    yield {
      type: "result",
      result: ok([`MCP connectors (${items.length}):`, ...items.map(renderEntry)].join("\n")),
    }
  },
})

const makeInstallTool = (port: McpConnectorDiscoveryPort): Tool<McpConnectorInstallInput> => ({
  name: "mcp_connector_install",
  description:
    "Install a catalogued MCP server into the project's MCP config by id (from " +
    "mcp_connector_list). Mutating — writes the server entry. ok:false on an " +
    "unknown id or a malformed catalog entry.",
  inputSchema: mcpConnectorInstallInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(input: McpConnectorInstallInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = mcpConnectorInstallInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    if (ctx.signal.aborted) {
      yield {
        type: "result",
        result: err("aborted before start", { mode: "rejected", reason: "aborted" }),
      }
      return
    }
    yield { type: "result", result: await runInstall(port, parsed.data.id) }
  },
})

/** Build the MCP connector discovery tools over a wired host port. */
export const mcpConnectorTools = (port: McpConnectorDiscoveryPort): Tool[] => [
  makeListTool(port) as Tool,
  makeInstallTool(port) as Tool,
]
