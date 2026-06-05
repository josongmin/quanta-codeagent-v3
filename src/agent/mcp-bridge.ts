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
  type RootsProviderPort,
  type SamplingHandlerPort,
  type SupervisorDeps,
  tasksPortOver,
} from "@/mcp"
import { errMessage, logger } from "@/shared"
import {
  type ResourcesHandleResult as HandleResult,
  mcpTasksTools,
  type PromptEntry,
  type PromptResult,
  type ResourceBlock,
  type ResourceEntry,
  type ResourcesHandle,
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

// ── N3 — MCP resources/prompts aggregate ───────────────────────────────────

/** The subset of a live `McpClient` the resources aggregate consumes. The four
 *  methods' result shapes (`McpResult<McpResource[]>` …) are STRING-IDENTICAL
 *  mirrors of the `@/tool` `HandleResult<ResourceEntry[]>` … types, so the
 *  concrete `McpClient` satisfies this WITHOUT a per-method adapter — the slice
 *  fence (which forbids `@/tool` importing `@/mcp`) is honored because THIS
 *  bridge layer imports both and is where the structural identity is asserted at
 *  compile time. Any drift in either declaration is a TYPE error at
 *  {@link aggregateResourcesHandle}. */
export interface McpResourcesClient {
  listResources(): Promise<HandleResult<ResourceEntry[]>>
  readResource(uri: string): Promise<HandleResult<ResourceBlock[]>>
  listPrompts(): Promise<HandleResult<PromptEntry[]>>
  getPrompt(name: string, args?: Record<string, unknown>): Promise<HandleResult<PromptResult>>
}

/** A failure is `unsupported` IFF the server never advertised the capability —
 *  the aggregate treats such a client as "absent" for the operation (skipped in
 *  lists, transparent in routing) rather than letting one capability-less server
 *  shadow the others. */
const isUnsupported = (r: HandleResult<unknown>): boolean =>
  r.ok === false && r.reason === "unsupported"

/** Aggregate one-or-more live MCP clients behind a SINGLE duck-typed
 *  `ResourcesHandle` (the four N3 tools' host port). NO-THROW end to end (every
 *  member returns a typed `HandleResult`, exactly as each underlying `McpClient`
 *  method does).
 *
 *  Semantics:
 *   - `listResources` / `listPrompts` — CONCAT across all clients; a client whose
 *     server didn't advertise the capability (`unsupported`) is SKIPPED, and a
 *     client that errors (transport / malformed) is skipped too (best-effort, the
 *     other servers' entries still surface). Always `ok:true` (possibly empty).
 *   - `readResource(uri)` / `getPrompt(name)` — ROUTE: try clients IN ORDER,
 *     return the FIRST result that is not `unsupported` (an `ok:true` hit, or the
 *     first real failure from a capable server). When every client is
 *     `unsupported` (or the client list is empty), return a typed `unsupported`
 *     failure — never a throw.
 *
 *  Empty client list ⇒ lists are `ok:true` empty, reads are `unsupported`. The
 *  surface only wires this handle when at least one client supports the surface
 *  (see {@link resourcesHandleFor}), so the empty-handle path is defensive. */
export const aggregateResourcesHandle = (clients: McpResourcesClient[]): ResourcesHandle => {
  const concat = async <T>(
    call: (c: McpResourcesClient) => Promise<HandleResult<T[]>>,
  ): Promise<HandleResult<T[]>> => {
    const acc: T[] = []
    for (const c of clients) {
      const r = await call(c)
      if (r.ok) acc.push(...r.value)
      // unsupported + any transport/malformed failure ⇒ skip this client; the
      // other servers' entries still aggregate (no-throw, best-effort).
    }
    return { ok: true, value: acc }
  }
  const route = async <T>(
    call: (c: McpResourcesClient) => Promise<HandleResult<T>>,
  ): Promise<HandleResult<T>> => {
    // A resource uri / prompt name is owned by exactly one server, but the
    // aggregate does not know which — so it tries EVERY capable client and an
    // `ok:true` hit wins regardless of position. A non-`unsupported` failure
    // (transport / malformed / not-found) from a non-owning capable server must
    // NOT shadow a hit further down, so it is remembered but only returned when
    // no client produced a hit. `unsupported` clients (never advertised the
    // capability) are skipped entirely.
    let firstRealFailure: HandleResult<T> | undefined
    for (const c of clients) {
      const r = await call(c)
      if (r.ok) return r
      if (!isUnsupported(r) && firstRealFailure === undefined) firstRealFailure = r
    }
    return (
      firstRealFailure ?? {
        ok: false,
        reason: "unsupported",
        message: "no connected MCP server advertised the requested capability",
      }
    )
  }
  return {
    listResources: () => concat((c) => c.listResources()),
    readResource: (uri) => route((c) => c.readResource(uri)),
    listPrompts: () => concat((c) => c.listPrompts()),
    getPrompt: (name, args) => route((c) => c.getPrompt(name, args)),
  }
}

/** Build the N3 aggregate `ResourcesHandle` over the resources-capable clients,
 *  or `undefined` when NONE qualify (so the surface leaves
 *  `DefaultToolPorts.mcpResources` unset ⇒ the four tools stay absent +
 *  byte-identical).
 *
 *  A client qualifies IFF its server advertised `resources` OR `prompts` — a
 *  server that speaks neither contributes nothing, so including it would only add
 *  an always-`unsupported` arm. SUPERVISED clients (the auto-restart path) are
 *  now INCLUDED (jun-06 RFC, limitation CLOSED): `McpReconnectSupervisor` exposes
 *  the six `resources/*`+`prompts/*` methods, re-resolving the CURRENT live client
 *  per call, so it structurally satisfies `ResourcesCapableClient` and folds into
 *  the SAME aggregate. During a reconnect gap a supervised member returns a typed
 *  `transport` failure (no throw), so it simply drops out of that one call and
 *  rejoins on recovery. */
export const resourcesHandleFor = (
  clients: ReadonlyArray<ResourcesCapableClient>,
): ResourcesHandle | undefined => {
  const capable = clients.filter((c) => c.serverSupportsResources() || c.serverSupportsPrompts())
  if (capable.length === 0) return undefined
  return aggregateResourcesHandle(capable)
}

/** A live client that BOTH satisfies the resources method-set AND can report
 *  whether its server advertised the capability (so {@link resourcesHandleFor}
 *  can drop the always-`unsupported` arms). The concrete `McpClient` satisfies
 *  it; `McpReconnectSupervisor` ALSO satisfies it (jun-06 RFC) — it now exposes
 *  the six resources/prompts methods, re-resolving the live client per call — so
 *  it is admitted into the aggregate on the supervised path. */
export interface ResourcesCapableClient extends McpResourcesClient {
  serverSupportsResources(): boolean
  serverSupportsPrompts(): boolean
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
/** B1 + H19 (jun-04) — the already-DECIDED MCP inbound-capability wiring bundle,
 *  threaded DOWN from the composition root. `@/agent/mcp-bridge` is a PURE
 *  consumer here: it never imports `@/host` (the `buildSamplingWiring` +
 *  `buildRootsWiring` + `pickMcpNegotiator` decision lives in the surface, where
 *  the `LLMPort` + consent prompter + workspace cwd are assembled), it only
 *  forwards these artifacts into every `McpClient` it constructs — on BOTH the
 *  single-client and the supervised (auto-restart) path.
 *
 *  The fields are bundled into ONE object precisely so they cannot drift: the
 *  negotiator (which advertises `sampling`/`roots` IFF the matching port is
 *  wired) and the ports that answer those advertisements MOVE TOGETHER.
 *
 *  Advertise-iff-able is enforced at the SOURCE (the surface): the negotiator is
 *  computed from the SAME gates that produce `samplingHandler`/`rootsProvider`,
 *  so a present field ⇒ the negotiator advertises it, and an absent field ⇒ it
 *  does not. When the whole bundle is absent the load is byte-identical to before
 *  this field existed (no negotiator override ⇒ `defaultNegotiator` caps `{}`, no
 *  handler ⇒ the client's headless rejecter, no roots provider ⇒ an inbound
 *  `roots/list` answered with an empty list — every advertise-iff-able default). */
export interface SamplingWiringInput {
  /** The pre-built capability negotiator — advertises `sampling`/`roots` IFF the
   *  matching port is wired (the caller computes this from the `advertise` flags
   *  of `buildSamplingWiring` / `buildRootsWiring` via `pickMcpNegotiator`). */
  readonly negotiator: CapabilityNegotiator
  /** The LLM-backed handler an inbound `sampling/createMessage` routes to.
   *  Optional: a deployment may wire `roots` WITHOUT `sampling` (or vice-versa);
   *  absent ⇒ the client keeps its headless sampling rejecter. */
  readonly handler?: SamplingHandlerPort
  /** H19 — the workspace roots source an inbound `roots/list` answers from.
   *  Optional + advertise-iff-able: present ⇒ the negotiator advertises `roots`
   *  AND the client answers `roots/list` from it; absent ⇒ no `roots`
   *  advertisement, `roots/list` answered with an empty list. */
  readonly rootsProvider?: RootsProviderPort
}

/** Apply a {@link SamplingWiringInput} bundle to the `McpClient` constructor
 *  opts in ONE place so the single-client path and the supervised factory wire
 *  IDENTICALLY (the unification point — no field can be applied on one path and
 *  forgotten on the other). Mutates + returns `opts` for call-site brevity.
 *
 *  Honesty rule: the negotiator is ALWAYS set whenever the bundle is present
 *  (it is the advertise-iff-able record computed at the source), and the
 *  `samplingHandler` / `rootsProvider` ports are set ONLY when present — so a
 *  capability is advertised IFF its answering port is wired. */
export const applyMcpClientWiring = (
  opts: NonNullable<ConstructorParameters<typeof McpClient>[1]>,
  wiring: SamplingWiringInput | undefined,
): NonNullable<ConstructorParameters<typeof McpClient>[1]> => {
  if (wiring === undefined) return opts
  // The negotiator reflects BOTH sampling AND roots (computed together at the
  // source); set it whenever ANY inbound capability is wired.
  opts.negotiator = wiring.negotiator
  if (wiring.handler !== undefined) opts.samplingHandler = wiring.handler
  if (wiring.rootsProvider !== undefined) opts.rootsProvider = wiring.rootsProvider
  return opts
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
  /** B1 + H19 (jun-04) — the advertise-iff-able inbound-capability wiring bundle
   *  decided at the composition root (see {@link SamplingWiringInput}). Present ⇒
   *  each server (on BOTH the single-client AND the supervised path) advertises
   *  `sampling`/`roots` IFF the matching port is wired, routes inbound
   *  `sampling/createMessage` to the supplied LLM-backed handler, and answers
   *  inbound `roots/list` from the supplied workspace roots provider. On the
   *  supervised path the bundle is threaded into the restart factory, so a
   *  reconnected client RE-advertises + re-handles. Absent ⇒ byte-identical (no
   *  advertisement, headless rejecter, empty roots). */
  samplingWiring?: SamplingWiringInput
}

/** Load one server on the ADR-0435 supervised (auto-restart) path. `create`
 *  never throws on a failed first start (it enters backoff), so a flaky server
 *  no longer drops the whole load. Returns the bridged tools + the supervisor
 *  to push (or `null` when listing failed and the supervisor was stopped).
 *
 *  B1 + H19 — the inbound-capability wiring bundle is threaded via the injected
 *  `SupervisorDeps.factory` (the composition root bakes it in with
 *  {@link applyMcpClientWiring}), so the supervisor — which owns the LIFECYCLE,
 *  not the policy — re-applies the SAME `{ negotiator, samplingHandler,
 *  rootsProvider }` to every (re)connected client. The bridge passes the deps
 *  straight through (pure pass-through). */
const loadSupervised = async (
  config: McpServerConfig,
  deps: SupervisorDeps,
): Promise<{ tools: Tool[]; client: McpStoppable; resources?: ResourcesCapableClient } | null> => {
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
    // jun-06 RFC (limitation CLOSED): admit the supervisor into the N3 resources
    // aggregate too. The supervisor now exposes the six `resources/*`+`prompts/*`
    // methods (each re-resolving the CURRENT live client per call), so it
    // structurally satisfies `ResourcesCapableClient` WITHOUT a wrapper. Surface
    // it ONLY when the current server advertises resources OR prompts, so a
    // supervised server that speaks neither stays byte-identical (no `resources`
    // field, zero new tools). Read per-call inside the supervisor so a restart
    // that changes capability re-evaluates.
    const resources = sup.serverSupportsResources() || sup.serverSupportsPrompts() ? sup : undefined
    return { tools, client: sup, ...(resources !== undefined ? { resources } : {}) }
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
): Promise<{ tools: Tool[]; client: McpStoppable; resources?: ResourcesCapableClient } | null> => {
  const clientOpts: ConstructorParameters<typeof McpClient>[1] = {}
  if (elicitationPrompterFor !== undefined) {
    clientOpts.elicitationPrompter = elicitationPrompterFor(config.name)
  }
  if (transportFor !== undefined) {
    clientOpts.transport = transportFor(config)
  }
  // B1 + H19 — advertise + answering-port MOVE TOGETHER via the SAME shared
  // helper the supervised factory uses: the negotiator (computed at the source to
  // advertise `sampling`/`roots` IFF wired) and the ports that answer them are
  // set as one unit, so the client can never advertise a capability it would
  // answer with `-32601`. Absent ⇒ no override (defaultNegotiator + the client's
  // headless rejecter + empty roots), byte-identical to the legacy load.
  applyMcpClientWiring(clientOpts, samplingWiring)
  const client = new McpClient(config, clientOpts)
  try {
    await client.start()
    const defs = await client.listTools()
    const tools = defs.map((def) => mcpToolToTool(client, def, config.name))
    // ADR-0431 — default-OFF MCP tasks surface: wired iff the server advertised
    // the `tasks/*` capability. No advertisement ⇒ no tools.
    tools.push(...tasksToolsFor(client))
    // N3 — surface the CONCRETE client (which exposes the resources/prompts
    // methods, unlike the `McpStoppable` narrowing) so `loadMcpTools` can build
    // the aggregate `ResourcesHandle`. The `McpClient` structurally satisfies
    // `ResourcesCapableClient`; the assignment proves it at compile time.
    return { tools, client, resources: client }
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
): Promise<{ tools: Tool[]; clients: McpStoppable[]; resources?: ResourcesHandle }> => {
  const tools: Tool[] = []
  const clients: McpStoppable[] = []
  // N3 + jun-06 RFC — the resources-capable clients across BOTH paths: the
  // single-client path surfaces the concrete `McpClient`, and the supervised
  // (auto-restart) path now surfaces the SUPERVISOR (which re-resolves the live
  // client per call). Collected so the bridge builds ONE aggregate
  // `ResourcesHandle` over every server, supervised or not.
  const resourcesClients: ResourcesCapableClient[] = []
  const supervisorDepsFor = opts?.supervisorDepsFor
  for (const config of servers) {
    const loaded =
      supervisorDepsFor !== undefined
        ? await loadSupervised(config, supervisorDepsFor(config))
        : await loadSingle(config, elicitationPrompterFor, opts?.transportFor, opts?.samplingWiring)
    if (loaded === null) continue
    tools.push(...loaded.tools)
    clients.push(loaded.client)
    if (loaded.resources !== undefined) resourcesClients.push(loaded.resources)
  }
  // N3 + jun-06 RFC — `undefined` when NO connected server (single OR supervised)
  // advertised resources/prompts ⇒ the surface leaves `DefaultToolPorts.mcpResources`
  // unset ⇒ the four tools stay absent + byte-identical.
  const resources = resourcesHandleFor(resourcesClients)
  return { tools, clients, ...(resources !== undefined ? { resources } : {}) }
}
