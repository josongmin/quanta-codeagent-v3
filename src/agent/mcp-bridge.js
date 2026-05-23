import { z } from "zod";
import { McpClient, McpError } from "@/mcp";
import { logger } from "@/shared";
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
export const mcpToolName = (server, tool) => {
    const clean = (s) => s.replace(/[^A-Za-z0-9_]+/g, "_");
    return `mcp__${clean(server)}__${clean(tool)}`;
};
/**
 * Build a minimal passthrough zod schema for an MCP tool. We do not attempt to
 * faithfully reproduce arbitrary JSON Schema (over-engineering, RFC §1.2); we
 * accept any object and require the schema's declared top-level `required`
 * keys when present so obviously-wrong calls are rejected before dispatch.
 */
const passthroughSchema = (jsonSchema) => {
    const required = Array.isArray(jsonSchema.required)
        ? jsonSchema.required.filter((k) => typeof k === "string")
        : [];
    const base = z.record(z.unknown());
    if (required.length === 0)
        return base;
    // z.unknown() also matches `undefined`, so an object schema would not truly
    // enforce presence. Refine instead: every declared required key must exist.
    return base.refine((obj) => required.every((k) => obj[k] !== undefined), (obj) => ({
        message: `missing required field(s): ${required.filter((k) => obj[k] === undefined).join(", ")}`,
    }));
};
const isMcpError = (e) => e instanceof McpError;
/** Adapt one MCP tool definition (on a started client) to our Tool interface. */
export const mcpToolToTool = (client, def, serverName) => {
    const name = mcpToolName(serverName, def.name);
    const schema = passthroughSchema(def.inputSchema);
    return {
        name,
        description: def.description,
        inputSchema: schema,
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
        async *execute(input, _ctx) {
            yield { type: "progress", message: `calling ${serverName} tool ${def.name}` };
            try {
                const res = await client.callTool(def.name, input);
                yield { type: "result", result: { ok: res.ok, output: res.content } };
            }
            catch (e) {
                const message = isMcpError(e) ? e.message : e.message;
                yield { type: "result", result: { ok: false, output: message } };
            }
        },
    };
};
/**
 * Start every configured MCP server, list its tools, and bridge them all.
 * Returns the bridged tools plus the live clients (the CLI stops them on exit).
 * A server that fails to start/list is logged and skipped — the others still
 * load, the CLI never crashes.
 */
export const loadMcpTools = async (servers) => {
    const tools = [];
    const clients = [];
    for (const config of servers) {
        const client = new McpClient(config);
        try {
            await client.start();
            const defs = await client.listTools();
            for (const def of defs)
                tools.push(mcpToolToTool(client, def, config.name));
            clients.push(client);
        }
        catch (e) {
            logger.warn(`mcp: skipping server "${config.name}": ${e.message}`);
            await client.stop().catch(() => undefined);
        }
    }
    return { tools, clients };
};
