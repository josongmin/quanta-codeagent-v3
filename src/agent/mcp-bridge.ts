import { z } from "zod"
import {
  type ElicitationPrompter,
  McpClient,
  McpError,
  type McpServerConfig,
  type McpToolDef,
} from "@/mcp"
import { errMessage, logger } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

/**
 * MCP → Tool bridge (RFC §13 Q5 → DECISION: bridge at the agent layer, Phase-3).
 *
 * Rationale: @/tool may not import @/mcp (slice isolation, RFC §3.1 — enforced
 * by biome). The agent slice is the assembler and is allowed to reach every
 * slice, so the adapter that turns an MCP tool into our `Tool` interface lives
 * here. One MCP tool ⇒ one `Tool`; the CLI merges these alongside defaultTools.
 *
 * Conservative defaults: an MCP tool has unknown side effects, so it is neither
 * read-only nor concurrency-safe (it serializes and goes through the normal
 * permission path). McpError is mapped to an error result — it never throws out
 * of the loop (the model recovers, same contract as every other tool).
 *
 * Behavior-preserving: nothing here runs unless the CLI is given an MCP config.
 */

/** `mcp__<server>__<tool>`, sanitized so the name is a safe identifier. */
export const mcpToolName = (server: string, tool: string): string => {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_]+/g, "_")
  return `mcp__${clean(server)}__${clean(tool)}`
}

/**
 * Build a minimal passthrough zod schema for an MCP tool. We do not attempt to
 * faithfully reproduce arbitrary JSON Schema (over-engineering, RFC §1.2); we
 * accept any object and require the schema's declared top-level `required`
 * keys when present so obviously-wrong calls are rejected before dispatch.
 */
const passthroughSchema = (jsonSchema: Record<string, unknown>): z.ZodType<unknown> => {
  const required = Array.isArray(jsonSchema.required)
    ? (jsonSchema.required as unknown[]).filter((k): k is string => typeof k === "string")
    : []
  const base = z.record(z.unknown())
  if (required.length === 0) return base
  // z.unknown() also matches `undefined`, so an object schema would not truly
  // enforce presence. Refine instead: every declared required key must exist.
  return base.refine(
    (obj) => required.every((k) => obj[k] !== undefined),
    (obj) => ({
      message: `missing required field(s): ${required.filter((k) => obj[k] === undefined).join(", ")}`,
    }),
  )
}

const isMcpError = (e: unknown): e is McpError => e instanceof McpError

/** Adapt one MCP tool definition (on a started client) to our Tool interface. */
export const mcpToolToTool = (client: McpClient, def: McpToolDef, serverName: string): Tool => {
  const name = mcpToolName(serverName, def.name)
  const schema = passthroughSchema(def.inputSchema)
  return {
    name,
    description: def.description,
    inputSchema: schema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield { type: "progress", message: `calling ${serverName} tool ${def.name}` }
      try {
        const res = await client.callTool(def.name, input)
        yield { type: "result", result: { ok: res.ok, output: res.content } }
      } catch (e) {
        const message = isMcpError(e) ? e.message : errMessage(e)
        yield { type: "result", result: { ok: false, output: message } }
      }
    },
  }
}

/** Track C — optional per-server elicitation prompter factory. Given the
 *  server's stable id (`config.name`), returns the {@link ElicitationPrompter}
 *  the `McpClient` routes inbound `elicitation/create` requests through. The
 *  factory shape (rather than a single shared prompter) is what lets the CLI
 *  bind the lease key per server (`leasePool.forContext({ serverId })`) so a
 *  coalesced prompt is scoped to ONE server. Absent ⇒ the client keeps its
 *  `headlessRejecter` default (byte-identical to the legacy load path). */
export type ElicitationPrompterFactory = (serverId: string) => ElicitationPrompter

/**
 * Start every configured MCP server, list its tools, and bridge them all.
 * Returns the bridged tools plus the live clients (the CLI stops them on exit).
 * A server that fails to start/list is logged and skipped — the others still
 * load, the CLI never crashes.
 *
 * Track C — `elicitationPrompterFor` is an OPTIONAL per-server prompter
 * factory. When supplied, each server's `McpClient` is constructed with the
 * prompter `elicitationPrompterFor(config.name)` returns, so an inbound
 * `elicitation/create` reaches the user instead of being auto-declined. Absent
 * ⇒ `new McpClient(config)` keeps its `headlessRejecter` default (the load is
 * byte-identical to before this param existed).
 */
export const loadMcpTools = async (
  servers: McpServerConfig[],
  elicitationPrompterFor?: ElicitationPrompterFactory,
): Promise<{ tools: Tool[]; clients: McpClient[] }> => {
  const tools: Tool[] = []
  const clients: McpClient[] = []
  for (const config of servers) {
    const client =
      elicitationPrompterFor !== undefined
        ? new McpClient(config, { elicitationPrompter: elicitationPrompterFor(config.name) })
        : new McpClient(config)
    try {
      await client.start()
      const defs = await client.listTools()
      for (const def of defs) tools.push(mcpToolToTool(client, def, config.name))
      clients.push(client)
    } catch (e) {
      logger.warn(`mcp: skipping server "${config.name}": ${errMessage(e)}`)
      await client.stop().catch(() => undefined)
    }
  }
  return { tools, clients }
}
