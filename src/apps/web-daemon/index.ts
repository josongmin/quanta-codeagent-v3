/**
 * `@/apps/web-daemon` — bun process that publishes the agent SDK over WS.
 *
 * Default-OFF surface. Run:
 *   `bun run src/apps/web-daemon/index.ts`
 * or via the `web:daemon` script in `package.json`.
 *
 * Env knobs (all optional):
 *   QUANTA_WEB_PORT        - TCP port (default `4096`)
 *   QUANTA_WEB_BIND        - bind address (default `127.0.0.1`)
 *   QUANTA_WEB_AUTH_TOKEN  - bearer token; when set, every WS upgrade
 *                            must carry `Authorization: Bearer <token>`
 *                            or `?token=<token>` in the URL
 *   QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD - exact `1` acknowledges
 *                            unauthenticated wildcard/LAN exposure
 *
 * The daemon remains library-shaped first, but when no explicit
 * `runtimeFactory` override is supplied we lazily load the production
 * composition root. This keeps tests injectable while making compiled
 * sidecar binaries independent of `import.meta.main` quirks.
 */

import type { FollowerCoControlDispatcher } from "@/agent/thread-follower"
import { isFollowerCoControlEnabled } from "@/agent/thread-follower"
import { installOtelSpanExportFromEnv } from "@/observability/otel-span-export"
import { type SupportedReadModels, supported } from "@/protocol/session"
import type { RuntimeFacade } from "@/sdk/runtime"
import { errMessage, gateOn, gateOnStrict } from "@/shared"
import type { ObservableRuntimeFacade } from "./runtime-factory"
import {
  type AgentStatePorts,
  type CanvasPorts,
  type ControlRequestPorts,
  type ObservabilityPorts,
  startWebDaemon,
  type UserInputPorts,
  type WebDaemonServerConfig,
} from "./server"
import type { WebDaemonConfig, WebDaemonHandle } from "./types"

const DEFAULT_PORT = 4096
const DEFAULT_BIND = "127.0.0.1"

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined || raw.length === 0) return DEFAULT_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`web-daemon: invalid QUANTA_WEB_PORT="${raw}" — must be integer 0..65535`)
  }
  return n
}

const parseBind = (raw: string | undefined): string => {
  if (raw === undefined || raw.length === 0) return DEFAULT_BIND
  return raw
}

const parseAuthToken = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim().length === 0) return undefined
  return raw
}

const isWildcardBind = (bind: string): boolean => {
  const normalized = bind.trim().toLowerCase()
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") return true
  return /^(?:0{1,4}:){7}0{1,4}$/.test(normalized)
}

const assertSafeBindPolicy = (config: {
  readonly bind: string
  readonly authToken: string | undefined
  readonly allowUnauthenticatedWildcard: boolean
}): void => {
  if (
    !isWildcardBind(config.bind) ||
    config.authToken !== undefined ||
    config.allowUnauthenticatedWildcard
  ) {
    return
  }
  throw new Error(
    "web-daemon: wildcard bind requires QUANTA_WEB_AUTH_TOKEN or " +
      "QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD=1",
  )
}

interface ResolvedNetworkConfig {
  readonly bind: string
  readonly authToken: string | undefined
  readonly allowUnauthenticatedWildcard: boolean
}

const resolveNetworkConfig = (
  overrides: Partial<WebDaemonConfig> | undefined,
  env: Record<string, string | undefined>,
): ResolvedNetworkConfig => {
  const bind = overrides?.bind ?? parseBind(env.QUANTA_WEB_BIND)
  const authToken = parseAuthToken(
    overrides?.authToken !== undefined ? overrides.authToken : env.QUANTA_WEB_AUTH_TOKEN,
  )
  const allowUnauthenticatedWildcard =
    overrides?.allowUnauthenticatedWildcard ??
    gateOnStrict(env, "QUANTA_WEB_ALLOW_UNAUTHENTICATED_WILDCARD")
  const config = { bind, authToken, allowUnauthenticatedWildcard }
  assertSafeBindPolicy(config)
  return config
}

/**
 * ADR-0415 — when observability is on, mint the daemon's single facade EAGERLY
 * so the emitter and the served session share ONE wire handle (= ONE RunLedger
 * / Objective / ApprovalStateMachine). The returned factory is then pinned to
 * that facade (the server still calls it once at boot). Gate OFF ⇒ the lazy
 * factory passes through unchanged + `facade` is `undefined` (byte-identical
 * legacy: the facade is minted inside `startWebDaemon`).
 */
const resolveObservableFactory = async (
  baseFactory: () => Promise<RuntimeFacade>,
  env: Record<string, string | undefined> = process.env,
): Promise<{
  readonly runtimeFactory: () => Promise<RuntimeFacade>
  readonly facade: ObservableRuntimeFacade | undefined
}> => {
  // ADR-0440 + QUANTA_WEB_AGENT_STATE — eagerly mint the facade when ANY of
  // observability / canvas / agent-state is gated ON, so the emitter
  // (observability) / canvas sink / agent-state sink shares ONE facade (= ONE
  // session host) with the served session. ALL gates OFF ⇒ the lazy factory
  // passes through unchanged + facade is undefined (byte-identical).
  if (
    !gateOn(env, "QUANTA_OBSERVABILITY") &&
    !gateOn(env, "QUANTA_WEB_CANVAS") &&
    !gateOn(env, "QUANTA_WEB_AGENT_STATE") &&
    // A2 — the store gate ALSO needs the eager facade so the `GET /artifact/:id`
    // route can read the facade's preview resolver, even when canvas is OFF (the
    // IPC preview channel is independent of the Canvas WS frames). Absent ⇒ the
    // route 404s but the daemon still serves the session (byte-identical legacy).
    !gateOn(env, "QUANTA_ARTIFACT_STORE") &&
    // ADR-0496 A1 — the control-request channel needs the ONE shared facade so
    // the server can enqueue peeked `controlRequest` frames into the live
    // session's port. Gate OFF ⇒ facade not eagerly minted for this reason.
    !gateOn(env, "QUANTA_CONTROL_REQUEST") &&
    // T02 — the follower co-control dispatcher also needs the ONE shared facade
    // so the server can route follower frames into the live session.
    !isFollowerCoControlEnabled(env)
  ) {
    return { runtimeFactory: baseFactory, facade: undefined }
  }
  const facade = (await baseFactory()) as ObservableRuntimeFacade
  return { runtimeFactory: async () => facade, facade }
}

/**
 * ADR-0415 + ADR-0420 — project the live facade ports into the per-connection
 * observability port bundle the server attaches to each WebSocket. ADR-0415
 * fed these ports to a port-ONLY emitter (no sink ⇒ frames went nowhere);
 * ADR-0420 closes that deferral: the server mints ONE emitter per connection
 * whose `ws` sink forwards `observability.snapshot`/`.delta` frames to the
 * connected UI. Returns `undefined` when the facade is absent (gate OFF ⇒ the
 * server attaches no sink ⇒ byte-identical) or carries no readable port.
 */
const buildObservabilityPorts = (
  facade: ObservableRuntimeFacade | undefined,
): ObservabilityPorts | undefined => {
  if (facade === undefined) return undefined
  const ports: ObservabilityPorts = {
    ...(facade.objective !== undefined ? { objective: facade.objective } : {}),
    ...(facade.runLedger !== undefined ? { runLedger: facade.runLedger } : {}),
    ...(facade.approvalStateMachine !== undefined
      ? { approvalSM: facade.approvalStateMachine }
      : {}),
  }
  // No readable port ⇒ no sink (the emitter would be silent anyway; skip the
  // per-connection allocation to keep the gate-ON-but-portless path cheap).
  if (
    ports.objective === undefined &&
    ports.runLedger === undefined &&
    ports.approvalSM === undefined
  ) {
    return undefined
  }
  return ports
}

/**
 * ADR-0440 — project the live facade's canvas sources (usage + tool-diff) into
 * the per-connection canvas port bundle. Returns `undefined` when the facade is
 * absent (gate OFF) or carries no canvas source (`QUANTA_WEB_CANVAS !== "1"`),
 * so the server attaches no canvas sink (byte-identical). Both sources are gated
 * on the same `QUANTA_WEB_CANVAS=1` flag (the runtime-factory mints them as a
 * pair), but each port is wired independently so the bundle is forward-safe if
 * either source is ever gated separately.
 */
const buildCanvasPorts = (facade: ObservableRuntimeFacade | undefined): CanvasPorts | undefined => {
  if (facade === undefined) return undefined
  if (
    facade.canvasUsage === undefined &&
    facade.canvasToolDiff === undefined &&
    facade.canvasArtifact === undefined
  ) {
    return undefined
  }
  return {
    ...(facade.canvasUsage !== undefined ? { usageSource: facade.canvasUsage } : {}),
    // ADR-0440 wire-finish — the canvas tool-diff source (subscribe-only). Each
    // connection's emitter forwards every capture as a `tool.diff` frame.
    ...(facade.canvasToolDiff !== undefined ? { toolDiffSource: facade.canvasToolDiff } : {}),
    // A2 wire-finish — the canvas artifact source (subscribe-only). Each
    // connection's emitter forwards every ready ref as an `artifact.ready` frame.
    ...(facade.canvasArtifact !== undefined ? { artifactSource: facade.canvasArtifact } : {}),
  }
}

/**
 * QUANTA_WEB_AGENT_STATE — project the live facade's agent-state source into
 * the per-connection port bundle. Returns `undefined` when the facade is absent
 * (gate OFF) or carries no agent-state source (`QUANTA_WEB_AGENT_STATE !== "1"`),
 * so the server attaches no agent-state sink (byte-identical).
 */
const buildAgentStatePorts = (
  facade: ObservableRuntimeFacade | undefined,
): AgentStatePorts | undefined => {
  if (facade === undefined) return undefined
  if (facade.agentState === undefined) return undefined
  return { source: facade.agentState }
}

/**
 * QUANTA_WEB_AGENT_STATE — project the live facade's OUT-OF-BAND INBOUND port
 * (the user-input answer/cancel handle) into the per-connection bundle the
 * server uses to resolve a `planInputAnswer` frame + `cancelAll()` on
 * disconnect. Returns `undefined` when the facade is absent (gate OFF) or
 * carries no inbound port (`QUANTA_WEB_AGENT_STATE !== "1"`), so the server has
 * nothing to resolve into (and the tool was never registered ⇒ byte-identical).
 */
const buildUserInputPorts = (
  facade: ObservableRuntimeFacade | undefined,
): UserInputPorts | undefined => {
  if (facade === undefined) return undefined
  if (facade.userInput === undefined) return undefined
  return { handle: facade.userInput }
}

/**
 * QUANTA_CONTROL_REQUEST (ADR-0496 A1) — project the live facade's control-
 * request port into the per-connection bundle the server uses to `enqueue` a
 * peeked `controlRequest` frame. Returns `undefined` when the facade is absent
 * (gate OFF) or carries no control-request port (`QUANTA_CONTROL_REQUEST` off),
 * so the server has nothing to enqueue into (and the loop's drain slot is
 * unwired ⇒ byte-identical).
 */
const buildControlRequestPorts = (
  facade: ObservableRuntimeFacade | undefined,
): ControlRequestPorts | undefined => {
  if (facade === undefined) return undefined
  if (facade.controlRequest === undefined) return undefined
  return { handle: facade.controlRequest }
}

/** T02 — project the session facade's follower co-control dispatcher (if the
 *  `QUANTA_THIN_CLIENT_DISPATCH` gate minted one) so the server can route a
 *  decoded `followerVerb` frame to it. Absent ⇒ undefined ⇒ follower frames fall
 *  through (byte-identical). */
const buildFollowerCoControl = (
  facade: ObservableRuntimeFacade | undefined,
): FollowerCoControlDispatcher | undefined => facade?.followerCoControl

const buildSupportedReadModels = (args: {
  readonly observabilityPorts: ObservabilityPorts | undefined
  readonly canvasPorts: CanvasPorts | undefined
  readonly agentStatePorts: AgentStatePorts | undefined
}): SupportedReadModels => ({
  session: supported("session.v1"),
  agentState:
    args.agentStatePorts !== undefined ? supported("agent-state.v1") : { status: "unsupported" },
  canvas: args.canvasPorts !== undefined ? supported("canvas.v1") : { status: "unsupported" },
  observability:
    args.observabilityPorts !== undefined
      ? supported("observability.v1")
      : { status: "unsupported" },
})

const buildServerConfig = (args: {
  readonly overrides: Partial<WebDaemonConfig> | undefined
  readonly network: ResolvedNetworkConfig
  readonly runtimeFactory: () => Promise<RuntimeFacade>
  readonly supportedReadModels: SupportedReadModels
  readonly observabilityPorts: ObservabilityPorts | undefined
  readonly canvasPorts: CanvasPorts | undefined
  readonly canvasArtifactFeed: WebDaemonServerConfig["canvasArtifactFeed"]
  readonly artifactPreviewResolver: WebDaemonServerConfig["artifactPreviewResolver"]
  readonly agentStatePorts: AgentStatePorts | undefined
  readonly subagentSource: WebDaemonServerConfig["subagentSource"]
  readonly userInputPorts: UserInputPorts | undefined
  readonly controlRequestPorts: ControlRequestPorts | undefined
  readonly followerCoControl: FollowerCoControlDispatcher | undefined
}): WebDaemonServerConfig => ({
  // THE port resolution — done ONCE, here. Everything downstream reads
  // `config.port` rather than re-deriving it, which matters because the two are
  // NOT interchangeable: a programmatic `main({ port })` override never appears
  // in `QUANTA_WEB_PORT`. The cross-origin fence in `server/http.ts` used to
  // re-read that env itself and therefore 403'd the daemon's own SPA under an
  // override; it now takes the port threaded from here (and, preferentially,
  // the actually-bound port off the live `Bun.serve` handle — see
  // `server/fetch-handler.ts` `fencePortFor`, which is what makes the
  // EADDRINUSE `port: 0` fallback below still serve its own SPA).
  //
  // We deliberately do NOT mirror the resolved port back into
  // `process.env.QUANTA_WEB_PORT`: that is a process-global write from a
  // library-shaped boot path (tests and the CLI boot daemons in-process), it
  // would make the fence depend on write ORDER rather than on a value, and it
  // would still be wrong for the OS-picked-port shapes, where the bound port is
  // not known until after the listener exists.
  port: args.overrides?.port ?? parsePort(process.env.QUANTA_WEB_PORT),
  ...args.network,
  runtimeFactory: args.runtimeFactory,
  sessionConfig: args.overrides?.sessionConfig ?? {},
  supportedReadModels: args.supportedReadModels,
  ...(args.observabilityPorts !== undefined ? { observabilityPorts: args.observabilityPorts } : {}),
  ...(args.canvasPorts !== undefined ? { canvasPorts: args.canvasPorts } : {}),
  ...(args.canvasArtifactFeed !== undefined ? { canvasArtifactFeed: args.canvasArtifactFeed } : {}),
  ...(args.artifactPreviewResolver !== undefined
    ? { artifactPreviewResolver: args.artifactPreviewResolver }
    : {}),
  ...(args.agentStatePorts !== undefined ? { agentStatePorts: args.agentStatePorts } : {}),
  ...(args.subagentSource !== undefined ? { subagentSource: args.subagentSource } : {}),
  ...(args.userInputPorts !== undefined ? { userInputPorts: args.userInputPorts } : {}),
  ...(args.controlRequestPorts !== undefined
    ? { controlRequestPorts: args.controlRequestPorts }
    : {}),
  ...(args.followerCoControl !== undefined ? { followerCoControl: args.followerCoControl } : {}),
})

/**
 * Boot the daemon. Accepts an optional override so test code (and a future
 * composition root) can inject a real `runtimeFactory` without parsing env.
 *
 * Without an injected factory, the entry script throws — better to fail loud
 * than to boot a daemon that cannot serve a session.
 */
export const main = async (overrides?: Partial<WebDaemonConfig>): Promise<WebDaemonHandle> => {
  const network = resolveNetworkConfig(overrides, process.env)

  // OTLP span export (ADR-0268) — same boot wire as the CLI, for the daemon
  // process. When QUANTA_OTEL_ENDPOINT is set, the daemon's session spans ship
  // to the collector; Default-OFF no-op otherwise. Torn down in `shutdown`
  // (an awaitable path, so the final flush actually completes — unlike a
  // best-effort beforeExit).
  const otelExport = installOtelSpanExportFromEnv(process.env)
  const baseFactory =
    overrides?.runtimeFactory ?? (await import("./runtime-factory")).buildProductionRuntimeFactory()

  const { runtimeFactory, facade: observableFacade } = await resolveObservableFactory(baseFactory)

  // ADR-0420 — per-connection observability sink bundle. Gate OFF ⇒ undefined
  // ⇒ the server attaches no sink (byte-identical legacy).
  const observabilityPorts = buildObservabilityPorts(observableFacade)

  // ADR-0440 — per-connection canvas sink bundle. Gate OFF ⇒ undefined ⇒ the
  // server attaches no canvas sink (byte-identical legacy).
  const canvasPorts = buildCanvasPorts(observableFacade)

  // QUANTA_WEB_AGENT_STATE — per-connection agent-state sink bundle. Gate OFF ⇒
  // undefined ⇒ the server attaches no agent-state sink (byte-identical legacy).
  const agentStatePorts = buildAgentStatePorts(observableFacade)

  // QUANTA_WEB_SUBAGENTS — the Sub-Agents panel source. Gate OFF ⇒ facade getter
  // reads undefined ⇒ the server installs no `subagent` topic broadcast
  // (byte-identical legacy).
  const subagentSource = observableFacade?.subagentSource

  // QUANTA_WEB_AGENT_STATE — the OUT-OF-BAND INBOUND port (answer/cancel handle).
  // Gate OFF ⇒ undefined ⇒ the server has no port to resolve into AND the tool
  // was never registered (byte-identical legacy).
  const userInputPorts = buildUserInputPorts(observableFacade)
  // QUANTA_CONTROL_REQUEST (ADR-0496 A1) — the OUT-OF-BAND INBOUND control-
  // request port. Gate OFF ⇒ undefined ⇒ the server has no enqueue target AND
  // the loop's drain slot is unwired (byte-identical legacy).
  const controlRequestPorts = buildControlRequestPorts(observableFacade)
  const followerCoControl = buildFollowerCoControl(observableFacade)
  const supportedReadModels = buildSupportedReadModels({
    observabilityPorts,
    canvasPorts,
    agentStatePorts,
  })

  // A2 — the WRITE side of the Canvas artifact source (the server-boot bridge
  // pumps session `artifact.ready` events into it) + the read-only preview
  // resolver (the `GET /artifact/:id` route reads it). Both ride the eagerly-minted
  // observable facade. Gate OFF ⇒ absent ⇒ no bridge, route 404s (byte-identical).
  const canvasArtifactFeed = observableFacade?.canvasArtifact?.sink
  const artifactPreviewResolver = observableFacade?.artifactPreviewResolver

  const config = buildServerConfig({
    overrides,
    network,
    runtimeFactory,
    supportedReadModels,
    observabilityPorts,
    canvasPorts,
    canvasArtifactFeed,
    artifactPreviewResolver,
    agentStatePorts,
    subagentSource,
    userInputPorts,
    controlRequestPorts,
    followerCoControl,
  })

  // Port-collision fallback: if the requested port is taken (EADDRINUSE
  // surfaces as `Failed to start server. Is port X in use?` from Bun),
  // retry with `port: 0` so the OS picks a free port. The actual bound
  // port is exposed on `handle.port` for the shell to publish to the
  // frontend. Opt out with `QUANTA_WEB_STRICT_PORT=1`.
  let handle: WebDaemonHandle
  try {
    handle = await startWebDaemon(config)
  } catch (error) {
    const msg = errMessage(error)
    const strict = gateOn(process.env, "QUANTA_WEB_STRICT_PORT")
    if (strict || !msg.toLowerCase().includes("port")) throw error
    process.stderr.write(
      `web-daemon: port ${config.port} in use — falling back to OS-picked port\n`,
    )
    handle = await startWebDaemon({ ...config, port: 0 })
  }
  process.stderr.write(`web-daemon: listening on ${handle.hostname}:${handle.port}\n`)

  // ADR-0406 + ADR-0415 + ADR-0420 — observability pane (Running/Waiting/
  // Completed + Objective + Approvals). ADR-0415 wired the four live ports off
  // the eagerly-minted observable facade; ADR-0420 closes the emitter-port-only
  // deferral by attaching a per-connection WS sink inside `startWebDaemon`
  // (`config.observabilityPorts`, set above). Gate OFF ⇒ `observableFacade`
  // is undefined ⇒ `observabilityPorts` is undefined ⇒ no sink (byte-identical).
  if (observabilityPorts !== undefined) {
    process.stderr.write("web-daemon: observability sink live (per-connection WS)\n")
  }
  // ADR-0440 — canvas sink (DiffView + UsageBar render-side data). Gate OFF ⇒
  // `canvasPorts` undefined ⇒ no sink (byte-identical).
  if (canvasPorts !== undefined) {
    process.stderr.write("web-daemon: canvas sink live (per-connection WS)\n")
  }
  // QUANTA_WEB_AGENT_STATE — agent-state sink (plan / mode / progress /
  // compaction / ratelimit render-side data). Gate OFF ⇒ `agentStatePorts`
  // undefined ⇒ no sink (byte-identical).
  if (agentStatePorts !== undefined) {
    process.stderr.write("web-daemon: agent-state sink live (per-connection WS)\n")
  }

  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    // TWO independent teardowns. They were one `try`, so a throw from
    // `handle.stop()` skipped the OTel teardown entirely and the `finally` still
    // exited 0 — the trace buffer went with the process, silently. Each now owns
    // its own try/finally so neither can cancel the other.
    try {
      await handle.stop()
    } catch (e) {
      process.stderr.write(`web-daemon: server stop failed during shutdown: ${errMessage(e)}\n`)
    }
    try {
      // The comment here used to say "final flush + restore sink (awaited — no
      // loss)". That is no longer true: a forced flush that fails now DISCARDS
      // its batch, so the honest claim is that the attempt is awaited, not that
      // nothing is lost. `teardown` reports what it dropped.
      await otelExport.teardown()
    } catch (e) {
      process.stderr.write(`web-daemon: otel teardown failed during shutdown: ${errMessage(e)}\n`)
    } finally {
      // Exit code 0 — graceful shutdown is the happy path.
      void sig
      process.exit(0)
    }
  }

  // Only install signal handlers when running as a script — tests use
  // `main({...})` and tear down via `handle.stop()`.
  if (import.meta.main) {
    process.once("SIGINT", () => void shutdown("SIGINT"))
    process.once("SIGTERM", () => void shutdown("SIGTERM"))
  }

  return handle
}

if (import.meta.main) {
  void (async (): Promise<void> => {
    try {
      await main()
    } catch (error: unknown) {
      process.stderr.write(`web-daemon: fatal: ${errMessage(error)}\n`)
      process.exit(1)
    }
  })()
}
