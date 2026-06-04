/**
 * skill-mcp-attach-adapter — the dual-transport composition-layer adapter that
 * fulfils the skill→MCP {@link SkillMcpPorts} (attach + detach) seam declared by
 * `@/skill/skill-mcp-deps`.
 *
 * WHAT: `createSkillMcpSession(ports, env)` (the per-session coordinator) drives
 * an injected {@link AttachMcpPort} / {@link DetachMcpPort} to actually attach
 * the MCP servers a skill declares — but no composition root builds a REAL one.
 * This module is that real one. It bridges the launcher-agnostic
 * {@link McpServerSpec} the skill slice emits onto the two concrete carriers:
 *
 *   - `transport: "stdio"`  → route to `@/agent/plugin-mcp-launcher`'s
 *     {@link McpLauncherPort} (process spawn). The adapter builds a
 *     {@link PluginMcpServerSpec} (`command` + `args`) and tracks the returned
 *     {@link McpServerHandle} so detach/shutdown can stop the process.
 *   - `transport: "streamable_http" | "sse"`  → route to the injected
 *     {@link HttpMcpConnectPort} (a thin seam over the `@/mcp` client + the
 *     ADR-0391 Streamable-HTTP/SSE transport — CONNECT to `url`, do NOT spawn).
 *     The adapter tracks the returned {@link HttpMcpConnection} so detach/
 *     shutdown can close the connection.
 *
 * WHY a port for the HTTP side (not a direct `@/mcp` import)? Plane-clean +
 * testability: the unit hellgate drives stdio AND http with in-memory fakes and
 * NO real process/socket. The composition root supplies the production
 * {@link HttpMcpConnectPort} (wrapping `new McpClient({ name, command: [], url },
 * { transport: httpSseTransport(...) })`); the launcher port it already has from
 * `@/agent/plugin-mcp-launcher`.
 *
 * IDENTITY + IDEMPOTENCY: a per-session registry keyed by {@link depIdentity}
 * (the SAME stable key the skill session dedups on). A repeat attach of an
 * already-attached identity is a no-op — never a double launch/connect, even if
 * the coordinator hands the adapter a spec it already attached.
 *
 * NO-THROW (hard): a failed launch/connect leaves that identity UNTRACKED — so a
 * later reconcile retries it — and is reported via the injected logger; nothing
 * escapes the boundary. A `ready: false` launcher handle is treated as a
 * failure (untracked + its no-op handle is NOT retained). detach/shutdown stop
 * tracked entries best-effort and always swallow.
 *
 * NO arbitrary heuristics / magic numbers: routing is a closed switch on the
 * closed {@link McpDepTransport} enum; identity is the documented
 * {@link depIdentity}. There are no thresholds/timeouts in this layer — timeouts
 * live in the launcher / mcp client it wraps.
 *
 * Slice-fence: this is an `@/agent`-layer COMPOSITION adapter. It MAY import
 * `@/agent/plugin-mcp-launcher`, `@/skill/skill-mcp-deps`, and `@/shared`. It is
 * NOT re-exported from `@/agent` (reached via the explicit module path). It must
 * NOT import `@/agent/loop` or `@/agent/dispatch` (ADR-0190 plane-clean).
 */

import type { McpLauncherPort, McpServerHandle } from "@/agent/plugin-mcp-launcher"
import { logger as defaultLogger, errMessage, type Logger } from "@/shared"
import {
  type AttachMcpPort,
  type DetachMcpPort,
  depIdentity,
  type McpAttachOutcome,
  type McpServerSpec,
  type SkillMcpPorts,
} from "@/skill/skill-mcp-deps"

/** A live HTTP (Streamable-HTTP / SSE) MCP connection the adapter holds for the
 *  session. Mirrors the relevant subset of `@/mcp` `McpClient` — only the
 *  teardown the adapter needs. `stop()` MUST be idempotent + NO-THROW (the
 *  `McpClient.stop()` it wraps already is: `if (this.stopped) return`). */
export interface HttpMcpConnection {
  /** Stable id (`depIdentity`) the adapter tracked this connection under. Used
   *  only for diagnostics — the registry keys on identity directly. */
  readonly id: string
  /** Idempotent, NO-THROW teardown. */
  stop(): Promise<void>
}

/** The injected seam for the HTTP carriers. The composition root implements
 *  this against the `@/mcp` client + ADR-0391 Streamable-HTTP/SSE transport
 *  (CONNECT to `spec.url`, do NOT spawn). MUST NOT throw on a connect failure —
 *  it REJECTS, and the adapter catches the rejection (NO-THROW invariant). A
 *  rejection ⇒ that identity is left untracked so a later reconcile retries. */
export interface HttpMcpConnectPort {
  /** Connect to the HTTP MCP server described by `spec` (an HTTP-carrier spec:
   *  `transport` is `streamable_http` | `sse`, `url` is present). `id` is the
   *  pre-computed {@link depIdentity} the adapter will track the result under,
   *  passed so the connection can carry it for diagnostics. */
  connect(spec: McpServerSpec, id: string): Promise<HttpMcpConnection>
}

/** Injected infra for the adapter. All side-effecting collaborators are ports
 *  so the hellgate drives them with fakes — NO `process.*` / real spawn / real
 *  socket in unit tests. */
export interface SkillMcpAttachAdapterDeps {
  /** stdio carrier sink — `@/agent/plugin-mcp-launcher` `McpLauncherPort`. */
  readonly launcher: McpLauncherPort
  /** HTTP carrier sink — wraps the `@/mcp` client over the http-sse transport. */
  readonly httpConnect: HttpMcpConnectPort
  /** Diagnostics sink. Defaults to the shared structured logger. A failed
   *  launch/connect is logged here (NEVER thrown). */
  readonly logger?: Logger
}

/** What the adapter exposes: the `SkillMcpPorts` the per-session coordinator
 *  (`createSkillMcpSession`) consumes, plus an explicit `shutdownAll` the
 *  composition root calls at session end to stop EVERY tracked carrier. */
export interface SkillMcpAttachAdapter {
  /** The attach + detach ports handed to `createSkillMcpSession(ports, env)`. */
  readonly ports: SkillMcpPorts
  /** Stop every tracked stdio handle + HTTP connection and clear the registry.
   *  NO-THROW; idempotent (a second call after the first is a no-op). */
  shutdownAll(): Promise<void>
  /** Read-only snapshot of currently-tracked identities (test/diagnostic). */
  trackedIdentities(): readonly string[]
}

/** One tracked carrier — a stdio launcher handle OR an HTTP connection — keyed
 *  in the registry by {@link depIdentity}. The union lets `detach`/`shutdownAll`
 *  tear each down through its own teardown without re-routing on transport. */
type TrackedCarrier =
  | { readonly kind: "stdio"; readonly handle: McpServerHandle }
  | { readonly kind: "http"; readonly connection: HttpMcpConnection }

/** The plugin-id the adapter launches skill-declared stdio servers under. Skill
 *  deps are session-scoped (not owned by any one plugin manifest), so a single
 *  stable synthetic owner namespaces them in the launcher's `serverId`
 *  (`${SKILL_MCP_PLUGIN_ID}::<serviceName>`). Named + documented — not an
 *  arbitrary string (memory rule). */
export const SKILL_MCP_PLUGIN_ID = "skill-mcp-deps"

/** Map the launcher-agnostic stdio {@link McpServerSpec} onto the launcher's
 *  {@link PluginMcpServerSpec} (`command` + `args`). A stdio spec always carries
 *  a non-empty `command` (validated upstream by `parseSkillMcpDeps`); we defend
 *  with `?? ""` / `?? []` so a malformed spec degrades to an empty command the
 *  launcher rejects with `ready: false` rather than throwing here. */
const toPluginSpec = (spec: McpServerSpec): { command: string; args: string[] } => ({
  command: spec.command ?? "",
  args: [...(spec.args ?? [])],
})

/**
 * Build the dual-transport skill→MCP attach adapter.
 *
 * @param deps — injected launcher port, HTTP connect port, and logger.
 * @returns the {@link SkillMcpPorts} (attach + detach) + `shutdownAll` over a
 *          per-session, identity-keyed registry.
 */
export const createSkillMcpAttachAdapter = (
  deps: SkillMcpAttachAdapterDeps,
): SkillMcpAttachAdapter => {
  const log = deps.logger ?? defaultLogger
  // identity -> tracked carrier. THE single per-session source of truth: it
  // makes the adapter idempotent (a repeat attach of a tracked identity is a
  // no-op) and lets detach/shutdown find exactly the carriers to tear down.
  const tracked = new Map<string, TrackedCarrier>()

  /** Attach one stdio spec via the launcher. On success ⇒ track + attached.
   *  On any failure (port reject OR `ready: false` handle) ⇒ UNTRACKED +
   *  attached:false (so a later reconcile retries). NO-THROW. */
  const attachStdio = async (spec: McpServerSpec, id: string): Promise<McpAttachOutcome> => {
    try {
      const handle = await deps.launcher.launch(toPluginSpec(spec), {
        pluginId: SKILL_MCP_PLUGIN_ID,
        serverName: spec.serviceName,
      })
      if (!handle.ready) {
        // Failed launch: do NOT retain the no-op handle — leave the identity
        // untracked so a later reconcile retries. Best-effort shutdown of the
        // (resource-less) failed handle for symmetry.
        await handle.shutdown().catch(() => undefined)
        log.warn("skill-mcp: stdio launch not ready", {
          service: spec.serviceName,
          reason: handle.error ?? "unknown",
        })
        return {
          serviceName: spec.serviceName,
          attached: false,
          reason: handle.error ?? "not ready",
        }
      }
      tracked.set(id, { kind: "stdio", handle })
      return { serviceName: spec.serviceName, attached: true }
    } catch (e) {
      const reason = errMessage(e)
      log.warn("skill-mcp: stdio launch threw", { service: spec.serviceName, reason })
      return { serviceName: spec.serviceName, attached: false, reason }
    }
  }

  /** Connect one HTTP spec via the injected connect port. On success ⇒ track +
   *  attached. On reject ⇒ UNTRACKED + attached:false. NO-THROW. */
  const attachHttp = async (spec: McpServerSpec, id: string): Promise<McpAttachOutcome> => {
    try {
      const connection = await deps.httpConnect.connect(spec, id)
      tracked.set(id, { kind: "http", connection })
      return { serviceName: spec.serviceName, attached: true }
    } catch (e) {
      const reason = errMessage(e)
      log.warn("skill-mcp: http connect threw", { service: spec.serviceName, reason })
      return { serviceName: spec.serviceName, attached: false, reason }
    }
  }

  /** Route one spec by its (closed) transport. Idempotent: an already-tracked
   *  identity is a no-op success (never a second launch/connect). */
  const attachOne = async (spec: McpServerSpec): Promise<McpAttachOutcome> => {
    const id = depIdentity(spec)
    if (tracked.has(id)) {
      // Idempotency — already attached for this session. No double-launch.
      return { serviceName: spec.serviceName, attached: true }
    }
    return spec.transport === "stdio" ? attachStdio(spec, id) : attachHttp(spec, id)
  }

  const attach: AttachMcpPort = {
    attach: async (specs) => {
      // Sequential — MCP server start (process spawn / handshake) is rarely
      // parallel-safe (mirrors the launcher/registry's sequential discipline)
      // and the spec count per reconcile is tiny (one per distinct dep).
      const out: McpAttachOutcome[] = []
      for (const spec of specs) out.push(await attachOne(spec))
      return out
    },
  }

  /** Tear down ONE tracked carrier through its own teardown. NO-THROW; always
   *  drops the tracking on completion (the underlying stop is idempotent, so
   *  even a partial failure must not leave a permanently-undetachable entry). */
  const teardownOne = async (id: string, carrier: TrackedCarrier): Promise<void> => {
    try {
      if (carrier.kind === "stdio") await carrier.handle.shutdown()
      else await carrier.connection.stop()
    } catch (e) {
      log.warn("skill-mcp: teardown threw", { id, reason: errMessage(e) })
    } finally {
      tracked.delete(id)
    }
  }

  const detach: DetachMcpPort = {
    detach: async (specs) => {
      // Shut down EXACTLY the named identities that are currently tracked.
      // An untracked identity (never attached / already detached) is a no-op.
      for (const spec of specs) {
        const id = depIdentity(spec)
        const carrier = tracked.get(id)
        if (carrier !== undefined) await teardownOne(id, carrier)
      }
    },
  }

  const shutdownAll = async (): Promise<void> => {
    // Snapshot before iterating so teardownOne's `tracked.delete` can't disturb
    // the iteration. Sequential teardown for the same parallel-safety reason.
    const entries = [...tracked.entries()]
    for (const [id, carrier] of entries) await teardownOne(id, carrier)
    tracked.clear()
  }

  const trackedIdentities = (): readonly string[] => [...tracked.keys()]

  return { ports: { attach, detach }, shutdownAll, trackedIdentities }
}
