import {
  type CapabilityNegotiator,
  type ElicitationPrompter,
  McpClient,
  type McpClientTransport,
  type McpOAuthProviderPort,
  McpReconnectSupervisor,
  type McpResourceObserver,
  type McpServerConfig,
  type RootsProviderPort,
  type SamplingHandlerPort,
  type SupervisorDeps,
} from "@/mcp"
import type { ProxyEnvInput } from "@/runtime/network-proxy"
import { errMessage, logger } from "@/shared"
import type { ResourcesHandle, Tool } from "@/tool"
// RFC04-2/3 — the SHARED collision disambiguator + the single-client relist
// SOURCE factory live with the relist assembly (mcp-reload-source) so connect +
// reload run the SAME logic. Function-scoped use (inside `loadMcpTools` /
// `loadSingle`) keeps this import cycle-safe; the edge is whitelisted (RFC04).
import {
  disambiguateMcpToolNames,
  emitReloadSource,
  type McpReloadableSource,
  reloadableSingleClientSource,
  reloadableSupervisedSource,
} from "./mcp-reload-source"
import { type ResourcesCapableClient, resourcesHandleFor } from "./mcp-resources-aggregate"
import {
  type McpToolBindOpts,
  mcpToolToTool,
  mcpToolToToolSupervised,
  supervisedTasksToolsFor,
  tasksToolsFor,
} from "./mcp-tool-adapter"

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

export {
  aggregateResourcesHandle,
  type McpResourcesClient,
  type ResourcesCapableClient,
  resourcesHandleFor,
} from "./mcp-resources-aggregate"
// ── Re-exported bridge surface (unchanged import path) ─────────────────────
// The tool-definition adapter and the resources aggregate were SPLIT into
// sibling modules (god-module ratchet); every name they own is re-exported here
// verbatim so `@/agent/mcp-bridge` keeps its exact public surface and no
// consumer (nor the `@/agent` barrel) changes a single import.
export {
  type McpToolBindOpts,
  mcpToolName,
  mcpToolToTool,
  mcpToolToToolSupervised,
  supervisedTasksToolsFor,
  tasksToolsFor,
} from "./mcp-tool-adapter"

/** Track C — optional per-server elicitation prompter factory. Given the
 *  server's stable id (`config.name`), returns the {@link ElicitationPrompter}
 *  the `McpClient` routes inbound `elicitation/create` requests through. The
 *  factory shape (rather than a single shared prompter) is what lets the CLI
 *  bind the lease key per server (`leasePool.forContext({ serverId })`) so a
 *  coalesced prompt is scoped to ONE server. Absent ⇒ the client keeps its
 *  `headlessRejecter` default (byte-identical to the legacy load path). */
export type ElicitationPrompterFactory = (serverId: string) => ElicitationPrompter

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
 * builds its default carrier via `defaultTransportFor` (stdio / isolated
 * process-ready when `MCP_USE_ISOLATED_SPAWN` is on / HTTP-SSE per config).
 * ADR-0431 still wins when `transportFor` is supplied.
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
  oauthProvider?: McpOAuthProviderPort,
  proxyEnv?: ProxyEnvInput,
  /** RFC04-2/3 (hot-reload) — reload observer, applied through this SAME point. */
  resourceObserver?: McpResourceObserver,
): NonNullable<ConstructorParameters<typeof McpClient>[1]> => {
  // H3 (jun-10 session-scoped egress) — the egress-proxy env is applied through
  // the SAME unification point as the OAuth provider + inbound bundle so the
  // single-client and the supervised (restart) factory wire it IDENTICALLY (no
  // path can gate the child socket while the other forgets it ⇒ a reconnected MCP
  // server would otherwise bypass the allowlist). Present (live proxy) ⇒ each
  // constructed client injects HTTP_PROXY/HTTPS_PROXY/NO_PROXY into its stdio
  // child; absent ⇒ no keys (byte-identical to the pre-thread spawn).
  if (proxyEnv !== undefined) opts.proxyEnv = proxyEnv
  // H18 (jun-06 live-wire) — the OAuth provider is applied through the SAME
  // unification point as the inbound bundle so the single-client and the
  // supervised (restart) factory wire it IDENTICALLY (no path can set the
  // provider while the other forgets it). Present ⇒ each constructed client
  // consults it for a bearer when its `oauth:true` config opts in; absent ⇒ the
  // client keeps `headlessOAuthRejecter` (byte-identical: no token, no header).
  if (oauthProvider !== undefined) opts.oauthProvider = oauthProvider
  // RFC04-2/3 — the reload observer rides the SAME point so a reconnected client
  // re-subscribes its `tools/list_changed`. Absent ⇒ byte-identical (inbound drop).
  if (resourceObserver !== undefined) opts.resourceObserver = resourceObserver
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
   *  the client builds its default carrier via `defaultTransportFor` (stdio /
   *  isolated process-ready when `MCP_USE_ISOLATED_SPAWN` is on / HTTP-SSE). */
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
  /** H18 (jun-06 live-wire) — the connectors-backed `McpOAuthProviderPort` the
   *  composition root assembled via `buildMcpOAuthWiring` (present IFF
   *  `QUANTA_MCP_OAUTH=1` AND deps available). When present, EVERY constructed
   *  client (single AND supervised path) is given this provider, so a server
   *  whose config opts in (`oauth:true`) resolves a bearer before its HTTP
   *  carrier is built and attaches `Authorization: Bearer`. Absent ⇒ each client
   *  keeps `headlessOAuthRejecter` (byte-identical: no discovery, flow, header).
   *  The keyring composition (`QUANTA_MCP_OAUTH_KEYRING`) is BAKED INTO this
   *  provider's token store at the root (`resolveMcpOAuthKeyringOption`), so the
   *  bridge stays a pure consumer — it never reads `process.platform`. */
  oauthProvider?: McpOAuthProviderPort
  /** §19.1 (`QUANTA_MCP_TOOL_ANNOTATIONS`) — the global default-OFF master switch
   *  for honoring server-declared `ToolAnnotations`. When `true`, a tool from a
   *  server whose config is `trusted:true` derives its `isReadOnly`/
   *  `isConcurrencySafe` predicates from the (sanitized) annotations; an
   *  UNTRUSTED server is unaffected regardless. Absent/false ⇒ byte-identical
   *  (every MCP tool stays `false/false`). The trust gate is enforced per server
   *  inside {@link annotationPredicates}, so this flag alone can never elevate an
   *  untrusted server. */
  annotationsHonored?: boolean
  /** H3 (jun-10 session-scoped egress) — the egress-proxy env opened ONCE at
   *  session bootstrap (`openSessionEgressProxy`), BEFORE any MCP server is
   *  spawned, and live for the whole session. Threaded into EVERY constructed
   *  client (single AND supervised path) via {@link applyMcpClientWiring} so each
   *  stdio server child's own sockets are forced through the loopback allowlist.
   *  Absent / proxy OFF ⇒ no keys injected (byte-identical). The HTTP-SSE carrier
   *  is unaffected. */
  proxyEnv?: ProxyEnvInput
  /** ADR-0162 / C-F1 — host-resolved isolated-spawn policy. Threaded into the
   *  single-client path; supervised factories receive the same policy at their
   *  composition root. Absent/false preserves stdio. */
  isolatedSpawn?: boolean
  /** ALBB-09 (jul-9) — optional load-failure sink. Invoked in BOTH catch sites
   *  (single-client + supervised) when a CONFIGURED server's `start()` /
   *  `listTools()` throws, alongside the existing `logger.warn`. A composition
   *  root bridges it to `session.stream.emit({type:"error", ...})` so a server
   *  that FAILS to start becomes an observable non-fatal event on the surface —
   *  today its tools silently vanish, indistinguishable from an un-configured
   *  server. Absent ⇒ byte-identical (warn-only, as today). The sink itself must
   *  not throw; it is invoked best-effort inside the existing catch. */
  onServerLoadError?: (info: { server: string; error: unknown }) => void
  /** WS-G (UUX-6-22, jul-10) — optional mid-session death sink. SINGLE-CLIENT
   *  path only: each loaded `McpClient`'s `onExit` is bridged here with the
   *  RAW config server name (pill ✗ + operator notice). The SUPERVISED path is
   *  intentionally NOT subscribed — the supervisor owns crash→restart (its
   *  give-up state is `degraded`). Best-effort/no-throw; absent ⇒ byte-identical. */
  onServerExit?: (info: { server: string; reason?: string }) => void
  /** RFC04-2/3 (hot-reload) — the capability-gated reload observer threaded into
   *  EVERY constructed client (single AND supervised) via {@link applyMcpClientWiring}.
   *  A live server's `tools/list_changed` reaches it; the composition root bridges
   *  `onNotification` to a `requestReload` (ONE shared instance ⇒ ANY server's
   *  change ⇒ the SAME all-source relist). Absent ⇒ byte-identical; gated on
   *  `QUANTA_MCP_HOT_RELOAD`. */
  resourceObserver?: McpResourceObserver
  /** RFC04-2/3 (hot-reload) — OPTIONAL reload-source sink invoked ONCE per
   *  SUCCESSFULLY-loaded server on BOTH paths with a {@link McpReloadableSource}:
   *  single-client ⇒ `reloadableSingleClientSource` (live client); supervised ⇒
   *  `reloadableSupervisedSource` (the supervisor's stable handle, relisting via
   *  `sup.listTools()` ⇒ current live client ⇒ survives auto-restart). Both re-run
   *  the SAME connect-time `bindOpts` (no reload-only converter/collision/trust); the
   *  composition root (gated on `QUANTA_MCP_HOT_RELOAD`) collects them for the
   *  controller's all-source relist, so an auto-restart server's `tools/list_changed`
   *  hot-reloads too. Absent ⇒ never invoked ⇒ byte-identical. Best-effort. */
  onReloadSource?: (source: McpReloadableSource) => void
}

/** WS-G — duck-subscribe a loaded client's transport-exit to `onServerExit`.
 *  Probed structurally (`McpStoppable` hides the concrete client): the
 *  single-client `McpClient` has `onExit`, the supervisor does not (by
 *  design). NO-THROW end to end. */
const subscribeServerExit = (
  client: McpStoppable,
  server: string,
  onServerExit: ((info: { server: string; reason?: string }) => void) | undefined,
): void => {
  if (onServerExit === undefined) return
  const c = client as { onExit?: (h: (reason?: string) => void) => () => void }
  if (typeof c.onExit !== "function") return
  try {
    c.onExit((reason) => {
      try {
        onServerExit({ server, ...(reason !== undefined ? { reason } : {}) })
      } catch (e) {
        logger.warn(`mcp: onServerExit sink threw for "${server}": ${errMessage(e)}`)
      }
    })
  } catch (e) {
    logger.warn(`mcp: onExit subscribe failed for "${server}": ${errMessage(e)}`)
  }
}

/** §19.1 — the bind opts for ONE server: combine the global knob flag with this
 *  server's host-declared trust. Both must be true for annotations to be
 *  honored; fail-closed on either. */
const bindOptsFor = (
  config: McpServerConfig,
  annotationsHonored: boolean | undefined,
): McpToolBindOpts => ({
  annotationsHonored: annotationsHonored === true,
  trusted: config.trusted === true,
})

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
/** ALBB-09 — best-effort invoke of the optional load-error sink. Wrapped so a
 *  hostile sink can never escape the caller's catch (the load must still degrade
 *  clean to `null`). Absent sink ⇒ no-op (byte-identical). */
const reportServerLoadError = (
  onServerLoadError: ((info: { server: string; error: unknown }) => void) | undefined,
  server: string,
  error: unknown,
): void => {
  if (onServerLoadError === undefined) return
  try {
    onServerLoadError({ server, error })
  } catch (e) {
    logger.warn(`mcp: onServerLoadError sink threw for "${server}": ${errMessage(e)}`)
  }
}

const loadSupervised = async (
  config: McpServerConfig,
  deps: SupervisorDeps,
  annotationsHonored: boolean | undefined,
  onServerLoadError: ((info: { server: string; error: unknown }) => void) | undefined,
  onReloadSource: ((source: McpReloadableSource) => void) | undefined,
): Promise<{ tools: Tool[]; client: McpStoppable; resources?: ResourcesCapableClient } | null> => {
  const sup = await McpReconnectSupervisor.create(config, deps)
  const bindOpts = bindOptsFor(config, annotationsHonored)
  try {
    const defs = await sup.listTools()
    const tools = defs.map((def) => mcpToolToToolSupervised(sup, def, config.name, bindOpts))
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
    // RFC04 supervised extension — reload SOURCE over the SUPERVISOR's stable
    // handle (`sup.listTools()` ⇒ current live client ⇒ survives auto-restart).
    const supSource = reloadableSupervisedSource(sup, config.name, bindOpts)
    emitReloadSource(onReloadSource, config.name, supSource)
    return { tools, client: sup, ...(resources !== undefined ? { resources } : {}) }
  } catch (e) {
    logger.warn(`mcp: skipping server "${config.name}": ${errMessage(e)}`)
    reportServerLoadError(onServerLoadError, config.name, e)
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
  oauthProvider: McpOAuthProviderPort | undefined,
  annotationsHonored: boolean | undefined,
  proxyEnv: ProxyEnvInput | undefined,
  isolatedSpawn: boolean | undefined,
  onServerLoadError: ((info: { server: string; error: unknown }) => void) | undefined,
  resourceObserver: McpResourceObserver | undefined,
  onReloadSource: ((source: McpReloadableSource) => void) | undefined,
): Promise<{ tools: Tool[]; client: McpStoppable; resources?: ResourcesCapableClient } | null> => {
  const clientOpts: ConstructorParameters<typeof McpClient>[1] = {}
  if (isolatedSpawn === true) clientOpts.isolatedSpawn = true
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
  // answer with `-32601`. H18 (jun-06) — the OAuth provider rides the same
  // helper so it is applied identically on both paths. Absent ⇒ no override
  // (defaultNegotiator + the client's headless rejecter + empty roots + the
  // headless OAuth rejecter), byte-identical to the legacy load.
  applyMcpClientWiring(clientOpts, samplingWiring, oauthProvider, proxyEnv, resourceObserver)
  const client = new McpClient(config, clientOpts)
  try {
    await client.start()
    const defs = await client.listTools()
    const bindOpts = bindOptsFor(config, annotationsHonored)
    const tools = defs.map((def) => mcpToolToTool(client, def, config.name, bindOpts))
    // ADR-0431 — default-OFF MCP tasks surface: wired iff the server advertised
    // the `tasks/*` capability. No advertisement ⇒ no tools.
    tools.push(...tasksToolsFor(client))
    // RFC04-2/3 (hot-reload) — reload SOURCE over the live client + connect-time
    // `bindOpts` (relist re-runs the SAME bind). Gated on `QUANTA_MCP_HOT_RELOAD`.
    const singleSource = reloadableSingleClientSource(client, config.name, bindOpts)
    emitReloadSource(onReloadSource, config.name, singleSource)
    // N3 — surface the CONCRETE client (which exposes the resources/prompts
    // methods, unlike the `McpStoppable` narrowing) so `loadMcpTools` can build
    // the aggregate `ResourcesHandle`. The `McpClient` structurally satisfies
    // `ResourcesCapableClient`; the assignment proves it at compile time.
    return { tools, client, resources: client }
  } catch (e) {
    logger.warn(`mcp: skipping server "${config.name}": ${errMessage(e)}`)
    reportServerLoadError(onServerLoadError, config.name, e)
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
        ? await loadSupervised(
            config,
            supervisorDepsFor(config),
            opts?.annotationsHonored,
            opts?.onServerLoadError,
            opts?.onReloadSource,
          )
        : await loadSingle(
            config,
            elicitationPrompterFor,
            opts?.transportFor,
            opts?.samplingWiring,
            opts?.oauthProvider,
            opts?.annotationsHonored,
            opts?.proxyEnv,
            opts?.isolatedSpawn,
            opts?.onServerLoadError,
            opts?.resourceObserver,
            opts?.onReloadSource,
          )
    if (loaded === null) continue
    tools.push(...loaded.tools)
    clients.push(loaded.client)
    // WS-G (UUX-6-22) — bridge a mid-session server death to the surface sink
    // (single-client path only; the supervisor owns restarts — see the opt doc).
    subscribeServerExit(loaded.client, config.name, opts?.onServerExit)
    if (loaded.resources !== undefined) resourcesClients.push(loaded.resources)
  }
  // F1 — DISAMBIGUATE bridged-name collisions before the tools reach the
  // name-keyed (last-write-wins) registry, so a second tool that sanitizes to an
  // already-taken identifier gets a deterministic `_<n>` suffix (both callable)
  // and the collision is warned + recorded — never a silent shadow. No collision
  // ⇒ every name is unchanged (byte-identical).
  const { tools: deduped } = disambiguateMcpToolNames(tools)
  // N3 + jun-06 RFC — `undefined` when NO connected server (single OR supervised)
  // advertised resources/prompts ⇒ the surface leaves `DefaultToolPorts.mcpResources`
  // unset ⇒ the five tools stay absent + byte-identical.
  const resources = resourcesHandleFor(resourcesClients)
  return { tools: deduped, clients, ...(resources !== undefined ? { resources } : {}) }
}
