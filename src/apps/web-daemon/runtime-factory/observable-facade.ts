/**
 * `@/apps/web-daemon/runtime-factory/observable-facade` — ONE responsibility:
 * the WIDENED read-only facade contract the web daemon hands its server, and
 * the two `Object.defineProperty` attachers that hang live ports onto it.
 *
 * Nothing here mints anything or reads a gate: it only DESCRIBES which optional
 * live ports a session facade may expose (`ObservableRuntimeFacade`) and how a
 * present port becomes a read-only enumerable getter WITHOUT copying the
 * facade (so the runtime's prototype-bound `createSession` / `close` survive).
 *
 * Extracted verbatim from `../runtime-factory.ts` (god-module split); that
 * module re-exports `ObservableRuntimeFacade` + `attachObservabilityPorts`, so
 * no importer moves. The edge is ONE-WAY — the parent imports this file.
 */

import type { ApprovalStateMachinePort } from "@/agent/approval-state-machine"
import type { ActiveTurnRefHolder } from "@/agent/conversation-action-surface"
import type { ObservabilityWireHandle } from "@/agent/observability-wire"
import type { RunLedgerPort } from "@/agent/run-ledger"
import type { ShadowVerifyPort } from "@/agent/shadow-verify"
import type { FollowerCoControlDispatcher } from "@/agent/thread-follower"
import type { ArtifactRegistry } from "@/artifact"
import type { ArtifactPreviewResolver } from "@/host/runtime"
import type { ObjectivePort } from "@/objective"
import type { UsageAccountingPort } from "@/observability/usage-accounting"
import type { RuntimeFacade } from "@/sdk/runtime"
import type { AgentStateSourceHandle } from "../agent-state-source"
import type { CanvasArtifactSourceHandle } from "../canvas-artifact-source"
import type { CanvasToolDiffSourceHandle } from "../canvas-tool-diff-source"
import type { CanvasUsageSourceHandle } from "../canvas-usage-source"
import type { WebReadoutSources } from "../readout"
import type { SubagentSourceHandle } from "../subagent-source"
import type { WebControlRequestPortHandle } from "../web-control-request-port"
import type { WebUserInputPortHandle } from "../web-user-input-port"

/**
 * ADR-0415 — `RuntimeFacade` widened with the four read-only observability
 * ports so the web-daemon's ADR-0408 emitter can read live Objective /
 * RunLedger / ApprovalStateMachine state WITHOUT reaching into the runtime
 * internals (`@/sdk/runtime`'s `RuntimeFacade` interface stays untouched —
 * the slice fence forbids mutating it). Every field is OPTIONAL: the daemon
 * reads them defensively and the emitter no-ops when all are absent
 * (default-OFF byte-identical when `QUANTA_OBSERVABILITY !== "on"`).
 */
export interface ObservableRuntimeFacade extends RuntimeFacade {
  readonly objective?: ObjectivePort
  /**
   * RFC-03 C2 (web-parity persistence seam) — the SESSION-STABLE objective
   * AUTHORITY threaded for TRANSCRIPT PERSISTENCE ONLY, decoupled from
   * observability. Distinct from the `objective` getter above: that one proxies
   * the OBSERVABILITY wire handle (`attachObservabilityPorts`) and reads
   * `undefined` whenever `QUANTA_OBSERVABILITY` is off (so the obs emitter stays
   * silent); THIS field is the ONE authority `buildProductionRuntimeFactory`
   * mints under `QUANTA_OBJECTIVE_TOOLS` alone (the SAME instance on
   * `base.objective`), present whenever TOOLS is on REGARDLESS of observability.
   * The daemon's `webObjectiveSnapshot` reads THIS (not the obs getter) so the
   * durable goal persists even with observability OFF. It is a plain value
   * getter — NOT an observability emitter port — so exposing it emits NO
   * observability frame (obs emission stays byte-identical). Absent when TOOLS
   * is off ⇒ the snapshot is undefined ⇒ the transcript omits `objective`.
   */
  readonly objectiveAuthority?: ObjectivePort
  /**
   * A7 — the session's usage-accounting authority, READ-ONLY, for the daemon's
   * cost projection (`/cost` readout, and the model label). The SAME instance
   * the base threads to the loop's emitUsage sink; the daemon never writes it.
   * Absent ⇒ the kill switch was thrown (accounting off).
   */
  readonly usageAccounting?: UsageAccountingPort
  readonly runLedger?: RunLedgerPort
  readonly approvalStateMachine?: ApprovalStateMachinePort
  readonly shadowVerify?: ShadowVerifyPort
  /**
   * ADR-0440 — canvas usage source fed by the session's `onPromptAssembled`
   * seam. Present only when `QUANTA_WEB_CANVAS=1` (gate OFF ⇒ undefined ⇒ the
   * server attaches no canvas sink, byte-identical).
   */
  readonly canvasUsage?: CanvasUsageSourceHandle
  /**
   * ADR-0440 wire-finish — canvas tool-diff source fed by the session's
   * `onToolDiff` seam (a file-mutating tool's before/after). Present only when
   * `QUANTA_WEB_CANVAS=1` (gate OFF ⇒ undefined ⇒ the server forwards no
   * `tool.diff` frames, byte-identical).
   */
  readonly canvasToolDiff?: CanvasToolDiffSourceHandle
  /**
   * A2 wire-finish — canvas artifact source fed by a server-boot bridge that
   * maps every session `artifact.ready` event into `capture(ref)`. Present only
   * when `QUANTA_WEB_CANVAS=1` (gate OFF ⇒ undefined ⇒ the server forwards no
   * `artifact.ready` Canvas frames, byte-identical). The session `artifact.ready`
   * event itself is gated on `QUANTA_ARTIFACT_STORE` (see `artifactRegistry`).
   */
  readonly canvasArtifact?: CanvasArtifactSourceHandle
  /**
   * A2 — the SHARED per-session artifact registry, minted behind
   * `QUANTA_ARTIFACT_STORE`. The SAME instance backs `base.artifactRegistry` (the
   * capability bit + the turn runner's `artifact.ready` producer drain) AND the
   * preview resolver below. Gate OFF ⇒ undefined ⇒ no producer, no preview
   * (byte-identical).
   */
  readonly artifactRegistry?: ArtifactRegistry
  /**
   * A2 — the host-side READ-ONLY `quanta-artifact://` preview resolver over the
   * SAME registry. The daemon's `GET /artifact/:id` route reads it here to serve
   * jailed preview bytes. Gate OFF ⇒ undefined ⇒ the route 404s (no channel,
   * byte-identical).
   */
  readonly artifactPreviewResolver?: ArtifactPreviewResolver
  /**
   * QUANTA_WEB_AGENT_STATE — agent-state source fed by the session's
   * `onAgentState` seam (the out-of-band stream tap). Present only when
   * `QUANTA_WEB_AGENT_STATE=1` (gate OFF ⇒ undefined ⇒ the server forwards no
   * `agentState` frames, byte-identical).
   */
  readonly agentState?: AgentStateSourceHandle
  /**
   * QUANTA_WEB_SUBAGENTS — Sub-Agents panel source fed by the session's
   * `onSubagentEvent` seam (subagent spawn/settle transitions). Present only
   * when `QUANTA_WEB_SUBAGENTS=1` (gate OFF ⇒ undefined ⇒ the server installs no
   * `subagent` topic broadcast, byte-identical).
   */
  readonly subagentSource?: SubagentSourceHandle
  /**
   * QUANTA_WEB_AGENT_STATE — the OUT-OF-BAND INBOUND port (mirror of the
   * agent-state OUTBOUND tap). When present, `AgentConfig.userInputPort` is
   * wired so the `request_user_input` tool is registered + a paused agent can be
   * answered from the browser. Minted on the SAME gate as the agent-state source
   * (you can only answer a prompt you can see). Gate OFF ⇒ undefined ⇒ the tool
   * is not registered ⇒ the agent cannot ask on web (byte-identical).
   */
  readonly userInput?: WebUserInputPortHandle
  /**
   * QUANTA_CONTROL_REQUEST (ADR-0496 A1) — the OUT-OF-BAND INBOUND control
   * channel. When present, `AgentConfig.controlRequest` is wired so a browser/IDE
   * `controlRequest` frame drives a mid-session runtime control (the load-bearing
   * `set_permission_mode` mutates this session's live `permission.mode` cell,
   * honored by the per-turn gate). Minted only when `QUANTA_CONTROL_REQUEST` is
   * on. Gate OFF ⇒ undefined ⇒ no slot ⇒ the loop never drains (byte-identical).
   */
  readonly controlRequest?: WebControlRequestPortHandle
  /**
   * T02 — thread-follower co-control dispatcher for a web 2nd-client. Present
   * only when `QUANTA_THIN_CLIENT_DISPATCH` is opted in: the server routes a
   * decoded `followerVerb` frame (steer/interrupt/set-queue-mode) here, and its
   * sinks drive the SAME conversation-action surface wired into this session's
   * `AgentConfig` (steer → inject into the lease holder's running turn — never a
   * 2nd writer). Gate OFF ⇒ undefined ⇒ follower frames fall through (the surface
   * is not wired either, byte-identical). Approvals ride `approval.respond`.
   */
  readonly followerCoControl?: FollowerCoControlDispatcher
  /** Shared loop-owned activity ref used by follower control and goal wakes. */
  readonly activeTurnRef?: ActiveTurnRefHolder
  /**
   * UUX-1-11 — narrow READ-ONLY accessor bundle for `GET /readout/:name`.
   * Threads the SAME live sources the session runs on (subagent TaskRegistry /
   * plan store / skills discovery / durable memory store / context-usage
   * holder) so `/agents`, `/plan`, `/skills`, `/memory`, `/context` serve real
   * data instead of the "not wired" stub. `/cost` is folded server-side from
   * `turn.completed` events (see `startWebDaemon`) — not here. Test factories
   * that do not expose this simply degrade every readout to the honest
   * missing-source line (never an error).
   */
  readonly readoutSources?: WebReadoutSources
}

/**
 * ADR-0415 — attach the wire handle's four ports onto a `RuntimeFacade` as
 * read-only getters proxied from the handle, returning the widened
 * {@link ObservableRuntimeFacade}. Uses `Object.defineProperties` (NOT a
 * shallow copy) so the original facade's prototype-bound methods
 * (`createSession` / `close`) keep working. When the handle is the noop
 * (gate OFF) every getter reads `undefined` ⇒ the emitter stays silent.
 */
export const attachObservabilityPorts = (
  facade: RuntimeFacade,
  handle: ObservabilityWireHandle,
): ObservableRuntimeFacade =>
  Object.defineProperties(facade as ObservableRuntimeFacade, {
    objective: { get: () => handle.objective, enumerable: true },
    runLedger: { get: () => handle.runLedger, enumerable: true },
    approvalStateMachine: { get: () => handle.approvalStateMachine, enumerable: true },
    shadowVerify: { get: () => handle.shadowVerify, enumerable: true },
  })

/** Define each present value as a read-only enumerable getter on the facade
 *  (Object.defineProperty, NOT a shallow copy, so the facade's prototype-bound
 *  methods keep working — same discipline as {@link attachObservabilityPorts}).
 *  An `undefined` value is SKIPPED so an absent gate leaves the field truly
 *  absent (byte-identical default-OFF). Collapses the per-port define blocks so
 *  the factory closure stays under the god-FN cap. */
export const defineOptionalFacadeGetters = (
  facade: ObservableRuntimeFacade,
  ports: Readonly<Record<string, unknown>>,
): void => {
  for (const [key, value] of Object.entries(ports)) {
    if (value === undefined) continue
    Object.defineProperty(facade, key, { get: () => value, enumerable: true })
  }
}
