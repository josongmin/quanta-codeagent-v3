/**
 * `@/apps/web-daemon/runtime-factory/agent-config-base` — ONE responsibility:
 * PROJECT the already-minted per-session collaborators onto the
 * `RuntimeAgentConfigBase` the session host is built from.
 *
 * This is the surface's "what does a web turn run with" declaration: the tool
 * registry (`buildDaemonToolRegistry` — the shared artifact registry threaded
 * into the default tools), the system prompt / surface profile / repo rules,
 * the HITL posture, and one presence-only spread per optional live port. It
 * MINTS nothing gated itself (that is `./session-collaborators`) — every
 * conditional field is `present ⇒ slot, absent ⇒ omitted`, which is what makes
 * every gate default-OFF byte-identical under `exactOptionalPropertyTypes`.
 *
 * Extracted verbatim from `../runtime-factory.ts` (god-module split). The edge
 * is ONE-WAY — the parent imports this file.
 */

import { buildSystemPrompt, type HookBus } from "@/agent"
import type { ObservabilityWireHandle } from "@/agent/observability-wire"
import type { PlanStore } from "@/agent/plan/state"
import { loadRepoRules } from "@/agent/repo-rules"
import { modeLoadsRepoRules } from "@/agent/run-mode"
import { promptSurfaceProfileForRunMode, resolveCliDefaultEnvPosture } from "@/agent/system-prompt"
import type { ArtifactRegistry } from "@/artifact"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { buildSkillsConfigCore, buildSubagentConfigCore } from "@/runner/assemble"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import { errMessage, gateOn, logger } from "@/shared"
import { StdoutStream } from "@/stream"
import { buildDefaultTools, type Tool, ToolRegistry } from "@/tool"
import type { AgentStateSourceHandle } from "../agent-state-source"
import type { CanvasToolDiffSourceHandle } from "../canvas-tool-diff-source"
import type { CanvasUsageSourceHandle } from "../canvas-usage-source"
import { WEB_INLINE_APPROVAL_GATE } from "../server/approval-continuation"
import type { SubagentSourceHandle } from "../subagent-source"
import type { WebControlRequestPortHandle } from "../web-control-request-port"
import type { WebUserInputPortHandle } from "../web-user-input-port"
import type { buildFollowerCoControlSlot } from "./session-collaborators"
import { observabilitySlots } from "./session-observability"

/** A2 — the daemon's default tool registry with the SHARED artifact registry
 *  threaded in (gated) so the `artifact_*` tools register into the SAME instance
 *  the turn-drain reads. Absent registry ⇒ the artifact tools are NOT registered
 *  (byte-identical). Extracted to keep the factory closure under the god-FN cap. */
export const buildDaemonToolRegistry = (
  artifactRegistry: ArtifactRegistry | undefined,
  extraTools: readonly Tool[] = [],
): ToolRegistry =>
  new ToolRegistry([
    ...buildDefaultTools(artifactRegistry !== undefined ? { artifactRegistry } : {}),
    ...extraTools,
  ])

/**
 * Assemble the {@link RuntimeAgentConfigBase} for a web-daemon session from the
 * per-session collaborators the factory just minted. Extracted from the factory
 * closure to keep it under the god-FN cap (mirrors {@link mintSessionCollaborators}
 * / {@link mintInboundPorts}); a pure projection — every conditional field is
 * presence-only so an absent gate omits the slot (default-OFF byte-identical).
 * The `webEnvPosture` derivation rides along as an own-local off `env`.
 */
export const buildAgentConfigBase = async ({
  env,
  llm,
  artifactRegistry,
  askUserTools,
  mcpTools,
  permission,
  cwd,
  abort,
  subagent,
  skills,
  planStore,
  usageHolder,
  canvasToolDiff,
  agentState,
  subagentSource,
  userInput,
  controlRequest,
  follower,
  observability,
}: {
  readonly env: Record<string, string | undefined>
  readonly llm: LLMPort
  readonly artifactRegistry: ArtifactRegistry | undefined
  readonly askUserTools: readonly Tool[]
  readonly mcpTools: readonly Tool[]
  readonly permission: PermissionContext
  readonly cwd: string
  readonly abort: AbortController
  readonly subagent: ReturnType<typeof buildSubagentConfigCore>
  readonly skills: ReturnType<typeof buildSkillsConfigCore>
  readonly planStore: PlanStore | undefined
  readonly usageHolder: CanvasUsageSourceHandle
  readonly canvasToolDiff: CanvasToolDiffSourceHandle | undefined
  readonly agentState: AgentStateSourceHandle | undefined
  readonly subagentSource: SubagentSourceHandle | undefined
  readonly userInput: WebUserInputPortHandle | undefined
  readonly controlRequest: WebControlRequestPortHandle | undefined
  readonly follower: ReturnType<typeof buildFollowerCoControlSlot>
  readonly observability: {
    readonly handle: ObservabilityWireHandle
    readonly bus: HookBus | undefined
  }
}): Promise<RuntimeAgentConfigBase> => {
  const webEnvPosture = resolveCliDefaultEnvPosture(env)
  // WS4 R7/R8 — the web/Tauri surface runs on the user's OWN cwd
  // (interactive-class trust), so it honors the repo's AGENTS.md/CLAUDE.md like
  // the CLI interactive preset. The load decision is GATED on the SSOT policy
  // `modeLoadsRepoRules` (in the surface-agnostic `@/agent/run-mode`, shared with
  // the presets) so web can never drift from the security classification — if
  // "interactive" ever became rule-less, this stops loading too. Fail-open.
  const repoRules = modeLoadsRepoRules("interactive")
    ? await loadRepoRules(cwd).catch((e) => {
        logger.warn("web daemon repo rules load failed; continuing without local rules", {
          cwd,
          error: errMessage(e),
        })
        return undefined
      })
    : undefined
  const base: RuntimeAgentConfigBase = {
    llm,
    // A2 — the default tools with the SHARED artifact registry threaded in so
    // the gated `artifact_*` tools register into the SAME instance the turn-drain
    // reads (single instance, no split-brain; reachable producer). See
    // {@link buildDaemonToolRegistry}. A1 — plus the web `ask_user` tool (gated).
    registry: buildDaemonToolRegistry(artifactRegistry, [...askUserTools, ...mcpTools]),
    stream: new StdoutStream(),
    permission,
    messages: [],
    // jul-9 — the web/Tauri surface is the user's OWN machine too, so honor
    // QUANTA_ENV_DEFAULT (default-OFF ⇒ "frozen" ⇒ byte-identical).
    system: buildSystemPrompt(cwd, { envPosture: webEnvPosture }),
    promptSurfaceProfile: promptSurfaceProfileForRunMode("interactive", {
      envPosture: webEnvPosture,
    }),
    ...(repoRules !== undefined ? { repoRules } : {}),
    cwd,
    maxTurns: 200,
    signal: abort.signal,
    // SECURITY (jun-10) — enable the HITL 4-tier gate so `hand-off-required` ⇒
    // HARD DENY and `always-confirm` ⇒ ask EVEN under bypass/acceptEdits (CLI
    // parity; without it `session.permission.set("bypass")` blanket-allows).
    hitl: { enabled: true },
    ...(subagent !== undefined ? { subagent } : {}),
    ...(skills !== undefined ? { skills } : {}),
    // UUX-1-11 — the plan store rides `base.planStore` (the loop registers
    // the plan tools when present; absent ⇒ omitted, tools not registered).
    ...(planStore !== undefined ? { planStore } : {}),
    // UUX-1-11 — the prompt-usage holder sink is always wired now: the
    // `/context` readout needs `latest()` regardless of the canvas gate
    // (pure observation; the canvas frames stay gated at the facade port).
    onPromptAssembled: usageHolder.sink,
    ...(canvasToolDiff !== undefined ? { onToolDiff: canvasToolDiff.sink } : {}),
    // A2 — lift the SHARED registry onto the base ⇒ capability bit + the turn
    // runner's `artifact.ready` producer drain. `{}` when off (byte-identical).
    ...(artifactRegistry !== undefined ? { artifactRegistry } : {}),
    ...(agentState !== undefined ? { onAgentState: agentState.sink } : {}),
    // QUANTA_WEB_SUBAGENTS — feed the Sub-Agents panel source. The runner
    // projects each lifecycle transition to a `SubagentObservation` and calls
    // this; the source fans it out to WS. Absent ⇒ no sink (byte-identical).
    ...(subagentSource !== undefined
      ? { onSubagentEvent: (ev) => subagentSource.sink.capture(ev) }
      : {}),
    // QUANTA_WEB_AGENT_STATE — wire the inbound port so the agent can ask on
    // web (the tool registers iff this is present). Absent ⇒ tool not
    // registered (byte-identical).
    ...(userInput !== undefined ? { userInputPort: userInput.port } : {}),
    // QUANTA_CONTROL_REQUEST (ADR-0496 A1) — wire the control-request slot so
    // the loop's turn-top `pollControlRequests` drains a browser/IDE control
    // frame + applies the effect (set_permission_mode lands on the live
    // `permission` cell). `env` is the daemon's own ambient env bag so the
    // load-bearing gate check inside the loop matches the mint gate. Absent ⇒
    // no slot ⇒ the port is never polled (byte-identical).
    ...(controlRequest !== undefined
      ? {
          controlRequest: {
            port: controlRequest.port,
            applier: controlRequest.applier,
            context: controlRequest.context,
            env,
          },
        }
      : {}),
    // T02 — wire the conversation-action port + active-turn ref so a web
    // follower's steer lands as a mid-turn injection (the loop polls the port).
    ...(follower !== undefined
      ? {
          conversationActionPort: follower.surface.port,
          activeTurnRef: follower.surface.activeTurnRef,
        }
      : {}),
    // ADR-0540 W1-B — declare the `server-auto-continues` capability marker iff
    // the daemon actually owns the continuation (the SAME gate arms the
    // `setupApprovalContinuation` re-issue in `server.ts`). Clients that see the
    // marker skip their post-approval `turn.run` re-issue. Gate OFF ⇒ this base
    // SLOT is omitted and the manifest normalizes to `false` — the FLOW is the
    // legacy client-owned continuation, unchanged. NOTE (audit M-3): the wire
    // manifest itself always CARRIES the field (`false` when OFF) because
    // `CapabilityManifest` made it required — flow-identical, not byte-identical
    // on the wire (same precedent as every other required capability bit).
    ...(gateOn(env, WEB_INLINE_APPROVAL_GATE) ? { serverAutoContinues: true } : {}),
    // jul-16 GAP-3 — the web daemon speaks session.v1 over WebSocket, so stamp
    // the HONEST transport here (was the base's `"inproc"` default lie — every
    // web session reported an in-process transport). Presence-only seam
    // (mirrors `serverAutoContinues`); completes the 3-way "다름이 정답" with the
    // stdio door (`"stdio"`) and an in-process embedder (`"inproc"`). No
    // production consumer branches on the value today (verified by grep of the
    // in-repo surfaces; the web bundle lives out-of-repo), so this is a
    // truth-fix, not a behavior change.
    sessionTransport: "websocket",
    ...observabilitySlots(observability),
  }
  return base
}
