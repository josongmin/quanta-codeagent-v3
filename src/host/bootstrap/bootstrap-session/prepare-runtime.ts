/**
 * `@/host/bootstrap/bootstrap-session/prepare-runtime` — the session PROLOGUE:
 * everything that must exist before any feature/tooling wiring can run.
 *
 * SINGLE RESPONSIBILITY: mint, in ONE load-bearing order, the terminal-agnostic
 * prerequisites of a session — structured logger, capability drift probe, idle
 * guards, the live permission-posture runtime (mode accessor + E4 control + E5
 * question guard), the session abort controller, the effort/brief cells, the
 * main LLM stack (+ the gated model-route forwarder), the AI titler, the session
 * egress proxy, and the loaded feature bundle. The ORDER is the contract: the
 * proxy binds BEFORE `loadFeatures` spawns MCP stdio children so their env
 * carries the proxy address, and a load failure closes the freshly-bound proxy
 * before rethrowing so no listening port leaks.
 *
 * Split out of `bootstrap-session.ts` (god-module cap) — VERBATIM relocation, no
 * behavior delta. One-way edges: it imports `./bootstrap-fault`,
 * `./capability-probe`, `./startup-announcement`; nothing here imports the
 * bootstrap back.
 */

import { createBriefStore, createEffortStore, parseBoolKnob, parseEffort } from "@/agent"
import type { QuestionAvailabilityReader } from "@/agent/dispatch-guard"
import { buildRouteEventForwarder } from "@/host/bootstrap/route-event-forwarder"
import type { LLMPort } from "@/llm"
import { StructuredLogger } from "@/observability"
import type { PermissionContext } from "@/permission"
import type { PostureControl } from "@/permission/posture/control"
import type { PermissionModeSessionState } from "@/runner/assemble/session-authorities"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import { openSessionEgressProxy } from "@/runtime/network-proxy"
import { errMessage } from "@/shared"
import type { AgentEvent } from "@/stream"
// RFC-05 E4/E5 — the behavior-live posture RUNTIME (ONE authority behind the mode
// accessor/adapter, the E4 control, and the E5 question guard).
import { buildLivePostureRuntime } from "../live-posture-runtime"
import type { BootstrapFeatures, SessionBootstrapDeps, SessionRuntimeConfigShape } from "../types"
import { failSessionBootstrap } from "./bootstrap-fault"
import { probeCapabilityConsistency } from "./capability-probe"
import { interactiveStructuredLogLevel } from "./startup-announcement"

/** The terminal-agnostic prerequisites the bootstrap assembles BEFORE the
 *  feature/tooling wiring: the structured logger, idle guards, mutable
 *  permission posture, session abort controller, effort/brief stores, the main
 *  LLM stack, the AI titler, the session egress proxy, and the loaded feature
 *  bundle. Order is load-bearing (proxy opens BEFORE `loadFeatures` spawns MCP
 *  children); the helper preserves it verbatim. */
export interface PreparedSessionRuntime {
  readonly slog: StructuredLogger
  readonly idleMonitor: ReturnType<SessionBootstrapDeps["buildIdleGuards"]>["idleMonitor"]
  readonly rejectCounter: ReturnType<SessionBootstrapDeps["buildIdleGuards"]>["rejectCounter"]
  readonly permission: PermissionContext
  readonly permissionModeState: PermissionModeSessionState
  /** RFC-05 E4 — posture front-door control (SAME authority); → base.postureControl. */
  readonly postureControl: PostureControl
  /** RFC-05 E5 — live question guard (SAME authority); → base/AgentConfig.questionGuard. */
  readonly questionGuard: QuestionAvailabilityReader
  readonly abort: AbortController
  readonly effortStore: ReturnType<typeof createEffortStore>
  readonly briefStore: ReturnType<typeof createBriefStore>
  readonly finalLLM: LLMPort
  readonly autoTitlePort: ReturnType<SessionBootstrapDeps["buildAutoTitlePort"]>
  readonly sessionProxy: Awaited<ReturnType<typeof openSessionEgressProxy>>
  readonly features: BootstrapFeatures
  /** RFC02-3 (A8) — late-bind hook for the PRODUCTION route sink. Present ONLY
   *  when `QUANTA_MODEL_REROUTE_EVENT` is on: the forwarder passed to
   *  `deps.buildLlm` at LLM-build time (before the stream exists) has its target
   *  set to the live `stream.emit` here by `assembleBootstrapResult`. Absent ⇒
   *  no sink was wired (byte-identical). */
  readonly bindRouteEventTarget?: (emit: (ev: AgentEvent) => void) => void
  /** RFC02-3 (A8, feeder) — the SAME gated forwarder `sink` handed to
   *  `deps.buildLlm`; carried through so the result exposes it to the
   *  `/retry-with` + scheduler-reroute attach sites (see `SessionBootstrapResult`
   *  field doc). Present ONLY when the gate is on (absent ⇒ byte-identical). */
  readonly routeEventSink?: (ev: AgentEvent) => void
}

/** Build {@link PreparedSessionRuntime} — the verbatim pre-feature prologue of
 *  `bootstrapSession`. An LLM build failure short-circuits via
 *  {@link failSessionBootstrap} (a `never` throw); a `loadFeatures` failure
 *  closes the freshly-bound egress proxy before re-throwing so no listening
 *  port leaks. Order and conditional logs are byte-identical to the prior
 *  inline body. */
export const prepareSessionRuntime = async (
  deps: SessionBootstrapDeps,
  runtime: SessionRuntimeConfigShape,
): Promise<PreparedSessionRuntime> => {
  const interactiveLevel = interactiveStructuredLogLevel(runtime)
  const slog = new StructuredLogger(
    interactiveLevel !== undefined ? { level: interactiveLevel } : {},
  )
  // ADR-0503 P3 — armed, read-only capability consistency probe. Gated on the
  // strict master gate inside the runner; OFF ⇒ byte-identical no-op (no probe,
  // no log). Observe-only: it never enforces or replaces a legacy gate.
  probeCapabilityConsistency(runtime.env)
  const { idleMonitor, rejectCounter } = deps.buildIdleGuards(runtime)
  // RFC-05 E3 — the permission posture mode is owned by the durable posture
  // AUTHORITY (E2), not a standalone state cell. `permission.mode` is an ACCESSOR
  // over the delegating adapter: `get` reads the authority's LIVE effectiveMode
  // (the per-turn admissibility gate reads the current value, never a stale
  // snapshot) and `set` delegates to `authority.set({ mode }, revision)` so a
  // mid-session change (CLI `shift+tab` mode-cycle → `permissionModeState().set()`,
  // web/agent control-request `permission.mode = …`) is a durable POSTURE
  // mutation the very next turn reads. Seeded from `runtime.mode` (unmanaged ⇒
  // effectiveMode == `runtime.mode`, byte-identical default path).
  //
  // RFC-05 E4/E5 — `buildLivePostureRuntime` composes ONE authority into the mode
  // accessor + adapter, the E4 `postureControl` (host `session.posture.set` + CLI
  // `/posture`, full lossless patch), and the E5 `questionGuard` — see that seam.
  const { permission, permissionModeState, postureControl, questionGuard } =
    buildLivePostureRuntime(runtime.mode)
  const abort = new AbortController()
  const effortStore = createEffortStore(parseEffort(runtime.env.QUANTA_EFFORT) ?? "default")
  // #17 (C3) — seed the brief-mode store from `QUANTA_BRIEF` (default-OFF). The
  // `/brief` slash + a `set_brief` control-op mutate the SAME cell; the loop
  // reads it per turn via `AgentConfig.sessionBrief`.
  const briefStore = createBriefStore(parseBoolKnob(runtime.env.QUANTA_BRIEF))
  // RFC02-3 (A8) — build the PRODUCTION route sink forwarder (gated). Passed to
  // `deps.buildLlm` so a real `FallbackLLM` swap projects `model_route_changed`;
  // its target is late-bound to the live stream in `assembleBootstrapResult`.
  // Gate OFF ⇒ `sink` is undefined ⇒ `buildLlm` wires no `onTransition`
  // (byte-identical).
  const routeForwarder = buildRouteEventForwarder(runtime.env)
  let finalLLM: LLMPort
  try {
    finalLLM = await deps.buildLlm(
      runtime.provider,
      runtime.model,
      runtime.mode,
      permission,
      abort.signal,
      slog,
      routeForwarder.sink,
    )
  } catch (e) {
    return failSessionBootstrap("llm_build_failed", errMessage(e), e)
  }

  // jun-6 (RFC jun-6-ai-session-title) — build the fire-and-forget AI titler.
  // Default-OFF: the surface factory returns `undefined` unless
  // `QUANTA_SESSION_AUTO_TITLE` is on AND `QUANTA_SESSION_TITLE_MODEL` resolves a
  // cheap port. Mirrors the `buildSummarizerLlm` second-LLM precedent (the cheap
  // LLM is pinned to the session abort signal so it is cancelled on session end).
  // Absent ⇒ `context-binding.ts` omits `AgentConfig.autoTitlePort` (byte-identical).
  const autoTitlePort = deps.buildAutoTitlePort(runtime.provider, abort.signal)

  // H3 (jun-10 session-scoped egress) — open the SESSION-SCOPED egress proxy
  // BEFORE `loadFeatures` spawns the MCP stdio servers, so the proxy's stable
  // address is fixed into every server child's env at spawn time. This is the
  // ARCHITECTURAL fix for the bypass: the per-turn `withEgressProxy` (bound
  // INSIDE `runAgent`, fresh ephemeral port each turn, closed on turn return)
  // cannot gate a process-lifetime MCP child spawned here, before any turn. We
  // resolve the config from `runtime.env` (the SAME `resolveNetworkProxyFromEnv`
  // the per-turn `AgentConfig.networkProxy` slot uses, so the bytes match) and
  // bind ONCE. DEFAULT-OFF: `QUANTA_NETWORK_PROXY` absent ⇒ `undefined` ⇒
  // `openSessionEgressProxy` binds NO socket, returns `proxyEnv = {}` (no proxy
  // keys reach the child) + a no-op `close()` ⇒ byte-identical to today.
  const networkProxy = resolveNetworkProxyFromEnv(runtime.env)
  const sessionProxy = await openSessionEgressProxy(networkProxy)
  // B1 (jun-04) — thread the freshly-built LLM so an inbound MCP
  // `sampling/createMessage` can be fulfilled by the loaded clients (the surface
  // gates advertisement on its knobs + consent; passing the LLM here is what
  // makes the wiring possible at all).
  let features: BootstrapFeatures
  try {
    features = await deps.loadFeatures(slog, finalLLM, sessionProxy.proxyEnv)
  } catch (e) {
    // The proxy socket was bound BEFORE the MCP spawn that just failed; release
    // it so a failed load never leaks the listening port (mirrors the MCP-client
    // cleanup the catch below performs once `features` exists).
    await sessionProxy.close()
    throw e
  }
  return {
    slog,
    idleMonitor,
    rejectCounter,
    permission,
    permissionModeState,
    postureControl,
    questionGuard,
    abort,
    effortStore,
    briefStore,
    finalLLM,
    autoTitlePort,
    sessionProxy,
    features,
    ...(routeForwarder.bind !== undefined ? { bindRouteEventTarget: routeForwarder.bind } : {}),
    ...(routeForwarder.sink !== undefined ? { routeEventSink: routeForwarder.sink } : {}),
  }
}
