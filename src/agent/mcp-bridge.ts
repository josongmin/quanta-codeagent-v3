import { z } from "zod"
import {
  type CapabilityNegotiator,
  clientTasksPort,
  type ElicitationPrompter,
  McpClient,
  type McpClientTransport,
  McpError,
  McpReconnectSupervisor,
  type McpServerConfig,
  type McpToolDef,
  type SamplingHandlerPort,
  type SupervisorDeps,
  tasksPortOver,
} from "@/mcp"
import { errMessage, logger } from "@/shared"
import {
  mcpTasksTools,
  type TasksHandle,
  type Tool,
  type ToolContext,
  type ToolEvent,
} from "@/tool"

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

/** ADR-0431 — adapt a live `McpClient` into the duck-typed `TasksHandle` the
 *  `@/tool` mcp_tasks tools consume. The slice fence forbids `@/tool` importing
 *  `@/mcp`, so the bridge (the assembler) is where the concrete `McpTasksPort`
 *  becomes the structural mirror. The two shapes are byte-identical by
 *  construction; any drift is a TYPE error here.
 *
 *  Returns the three tools ONLY when the connected server advertised the
 *  `tasks/*` capability in its `initialize` response (default-OFF). Absent ⇒
 *  empty array, so a server that does not speak tasks adds NO tools (the load
 *  is byte-identical to before this binding existed). */
const tasksToolsFor = (client: McpClient): Tool[] => {
  if (!client.serverSupportsTasks()) return []
  // `McpTasksPort` and `TasksHandle` are structurally identical (the mirror is
  // maintained in lockstep); the assignment proves it at compile time.
  const handle: TasksHandle = clientTasksPort(client)
  return mcpTasksTools(handle)
}

/** ADR-0435 (follow-up) — supervisor-aware sibling of {@link tasksToolsFor}.
 *
 *  Instead of binding the tasks handle to a CONCRETE (mortal) `McpClient`, it
 *  builds the handle over the supervisor, whose `requestRaw`/`serverSupportsTasks`
 *  always re-resolve the CURRENT live client. So when auto-restart swaps the
 *  underlying client behind the stable supervisor, the once-built `mcp_task_*`
 *  tools keep working against the NEW client — no stale capture.
 *
 *  Gated exactly like the default path: tools are present ONLY when the current
 *  server advertises `capabilities.tasks` (`sup.serverSupportsTasks()`). A
 *  supervised server that does NOT advertise tasks ⇒ empty array (byte-identical
 *  to the pre-follow-up supervised path, which never bridged tasks at all). */
export const supervisedTasksToolsFor = (sup: McpReconnectSupervisor): Tool[] => {
  if (!sup.serverSupportsTasks()) return []
  // `tasksPortOver` captures the SUPERVISOR (a `TasksRpc`), not a client. Every
  // method dispatches a fresh `sup.requestRaw(...)`, which delegates to the live
  // client at call time — the restart-survival invariant.
  const handle: TasksHandle = tasksPortOver(sup)
  return mcpTasksTools(handle)
}

/**
 * Supervisor-aware variant of {@link mcpToolToTool} (ADR-0435). Instead of
 * capturing a single (mortal) client instance, it captures the supervisor and
 * routes every call through `sup.callTool`, which always delegates to the
 * current live client — surviving auto-restarts behind a stable tool name.
 *
 * The execute/yield/error-mapping shape is identical to {@link mcpToolToTool}
 * so the model sees the same result contract whether or not auto-restart is on.
 */
export const mcpToolToToolSupervised = (
  sup: McpReconnectSupervisor,
  def: McpToolDef,
  serverName: string,
): Tool => {
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
        const res = await sup.callTool(def.name, input)
        yield { type: "result", result: { ok: res.ok, output: res.content } }
      } catch (e) {
        const message = isMcpError(e) ? e.message : errMessage(e)
        yield { type: "result", result: { ok: false, output: message } }
      }
    },
  }
}

/** A handle the CLI can `stop()` on shutdown. Both `McpClient` and
 *  `McpReconnectSupervisor` satisfy it. */
export interface McpStoppable {
  stop(): Promise<void>
}

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
 *
 * `opts.transportFor` (ADR-0431) is an OPTIONAL per-server transport factory —
 * a test seam mirroring `McpClient`'s `transport` option. Absent ⇒ the client
 * builds its default carrier (stdio / HTTP-SSE per config), byte-identical to
 * the legacy load.
 *
 * When `opts.supervisorDepsFor` is injected (ADR-0435), each server is wrapped
 * in an auto-restart supervisor; the returned `clients` array then holds the
 * supervisors (which expose a compatible `stop()`). Without it, the original
 * single-client path runs unchanged.
 */
/** B1 (jun-04) — the already-DECIDED inbound-sampling wiring, threaded DOWN from
 *  the composition root. `@/agent/mcp-bridge` is a PURE consumer here: it never
 *  imports `@/host` (the `buildSamplingWiring` + `pickMcpNegotiator` decision
 *  lives in the surface, where the `LLMPort` + consent prompter are assembled),
 *  it only forwards these two artifacts into the `McpClient` it constructs.
 *
 *  The two fields are bundled into ONE object precisely so they cannot drift:
 *  the negotiator (which already advertises `sampling: {}`) and the handler that
 *  answers it MOVE TOGETHER. Supply BOTH or NEITHER. When the bundle is absent,
 *  the load is byte-identical to before this field existed (no negotiator
 *  override ⇒ `defaultNegotiator` caps `{}`, no handler ⇒ the client's headless
 *  rejecter — the advertise-iff-able default). */
export interface SamplingWiringInput {
  /** The pre-built capability negotiator — advertises `sampling: {}` IFF a real
   *  handler is wired (the caller computes this from `buildSamplingWiring`'s
   *  `advertise` flag via `pickMcpNegotiator`). */
  readonly negotiator: CapabilityNegotiator
  /** The LLM-backed handler an inbound `sampling/createMessage` routes to. */
  readonly handler: SamplingHandlerPort
}

/** Opt-in knobs for {@link loadMcpTools}. Omitting all of them is byte-identical
 *  to the pre-ADR-0435 behavior. */
export interface LoadMcpToolsOpts {
  /** ADR-0431 — construct the transport for a server (test double / custom
   *  carrier). A test seam mirroring `McpClient`'s `transport` option. Absent ⇒
   *  the client builds its default carrier (stdio / HTTP-SSE per config),
   *  byte-identical to the legacy load. */
  transportFor?: (config: McpServerConfig) => McpClientTransport
  /** ADR-0435 — per-server supervisor deps. When present, each server is
   *  wrapped in an auto-restart {@link McpReconnectSupervisor} and bridged via
   *  {@link mcpToolToToolSupervised}; the returned `clients` then hold the
   *  supervisors (compatible `stop()`). Absent ⇒ the byte-identical
   *  single-client path. */
  supervisorDepsFor?: (config: McpServerConfig) => SupervisorDeps
  /** B1 (jun-04) — the advertise-iff-able inbound-sampling wiring decided at the
   *  composition root (see {@link SamplingWiringInput}). Present ⇒ each
   *  single-client server advertises `sampling` AND routes inbound
   *  `sampling/createMessage` to the supplied LLM-backed handler. Absent ⇒
   *  byte-identical (no advertisement, headless rejecter). */
  samplingWiring?: SamplingWiringInput
}

/** Load one server on the ADR-0435 supervised (auto-restart) path. `create`
 *  never throws on a failed first start (it enters backoff), so a flaky server
 *  no longer drops the whole load. Returns the bridged tools + the supervisor
 *  to push (or `null` when listing failed and the supervisor was stopped). */
const loadSupervised = async (
  config: McpServerConfig,
  deps: SupervisorDeps,
): Promise<{ tools: Tool[]; client: McpStoppable } | null> => {
  const sup = await McpReconnectSupervisor.create(config, deps)
  try {
    const defs = await sup.listTools()
    const tools = defs.map((def) => mcpToolToToolSupervised(sup, def, config.name))
    // ADR-0435 follow-up (limitation CLOSED): bridge the ADR-0431 `tasks/*`
    // surface on the supervised path too. The handle is built over the
    // SUPERVISOR (not a concrete client), so it re-resolves the current live
    // client per call and survives auto-restart. Default-OFF: present only when
    // the current server advertises `capabilities.tasks`.
    tools.push(...supervisedTasksToolsFor(sup))
    return { tools, client: sup }
  } catch (e) {
    logger.warn(`mcp: skipping server "${config.name}": ${errMessage(e)}`)
    await sup.stop().catch(() => undefined)
    return null
  }
}

/** Load one server on the default (byte-identical) single-client path. Track C
 *  (elicitation prompter) + ADR-0431 (transport seam + tasks surface) apply. */
const loadSingle = async (
  config: McpServerConfig,
  elicitationPrompterFor: ElicitationPrompterFactory | undefined,
  transportFor: ((config: McpServerConfig) => McpClientTransport) | undefined,
  samplingWiring: SamplingWiringInput | undefined,
): Promise<{ tools: Tool[]; client: McpStoppable } | null> => {
  const clientOpts: ConstructorParameters<typeof McpClient>[1] = {}
  if (elicitationPrompterFor !== undefined) {
    clientOpts.elicitationPrompter = elicitationPrompterFor(config.name)
  }
  if (transportFor !== undefined) {
    clientOpts.transport = transportFor(config)
  }
  // B1 — advertise + handler MOVE TOGETHER: the negotiator (which already
  // advertises `sampling: {}`) and the handler that answers it are set as one
  // unit from the same bundle, so the client can never advertise a capability it
  // would answer with `-32601`. Absent ⇒ no override (defaultNegotiator + the
  // client's headless rejecter), byte-identical to the legacy single-client load.
  if (samplingWiring !== undefined) {
    clientOpts.negotiator = samplingWiring.negotiator
    clientOpts.samplingHandler = samplingWiring.handler
  }
  const client = new McpClient(config, clientOpts)
  try {
    await client.start()
    const defs = await client.listTools()
    const tools = defs.map((def) => mcpToolToTool(client, def, config.name))
    // ADR-0431 — default-OFF MCP tasks surface: wired iff the server advertised
    // the `tasks/*` capability. No advertisement ⇒ no tools.
    tools.push(...tasksToolsFor(client))
    return { tools, client }
  } catch (e) {
    logger.warn(`mcp: skipping server "${config.name}": ${errMessage(e)}`)
    await client.stop().catch(() => undefined)
    return null
  }
}

export const loadMcpTools = async (
  servers: McpServerConfig[],
  elicitationPrompterFor?: ElicitationPrompterFactory,
  opts?: LoadMcpToolsOpts,
): Promise<{ tools: Tool[]; clients: McpStoppable[] }> => {
  const tools: Tool[] = []
  const clients: McpStoppable[] = []
  const supervisorDepsFor = opts?.supervisorDepsFor
  for (const config of servers) {
    const loaded =
      supervisorDepsFor !== undefined
        ? await loadSupervised(config, supervisorDepsFor(config))
        : await loadSingle(config, elicitationPrompterFor, opts?.transportFor, opts?.samplingWiring)
    if (loaded === null) continue
    tools.push(...loaded.tools)
    clients.push(loaded.client)
  }
  return { tools, clients }
}
