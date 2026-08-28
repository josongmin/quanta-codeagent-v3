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

import { type AgentConfig, buildSystemPrompt, type HookBus } from "@/agent"
import type { ActiveTurnRefHolder } from "@/agent/conversation-action-surface"
import type { QuestionAvailabilityReader } from "@/agent/dispatch-guard"
import type { ObservabilityWireHandle } from "@/agent/observability-wire"
import type { PlanStore } from "@/agent/plan/state"
import { loadRepoRules } from "@/agent/repo-rules"
import { modeLoadsRepoRules } from "@/agent/run-mode"
import { promptSurfaceProfileForRunMode, resolveCliDefaultEnvPosture } from "@/agent/system-prompt"
import type { ArtifactRegistry } from "@/artifact"
import type { LLMPort } from "@/llm"
import {
  createObjectiveAttemptSlot,
  type ObjectiveAttemptSlot,
  type ObjectivePort,
} from "@/objective"
import type { PermissionContext } from "@/permission"
import type { PostureControl } from "@/permission/posture/control"
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
import type { WebModelSwitchHandle } from "../web-model-switch"
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

/** RFC-03 H1 (web parity fix) — presence-only projection of the session-stable
 *  objective authority onto the config base. Extracted (mirrors
 *  {@link observabilitySlots}) so the `buildAgentConfigBase` closure stays under
 *  biome's cognitive-complexity cap. Absent (TOOLS gate off) ⇒ `{}` ⇒ the slot is
 *  omitted (default-OFF byte-identical under `exactOptionalPropertyTypes`). */
const objectiveSlot = (
  objective: ObjectivePort | undefined,
): Partial<Pick<AgentConfig, "objective">> & { objectiveAttemptSlot?: ObjectiveAttemptSlot } =>
  objective !== undefined
    ? // GOAL-08 — the host-owned attributed-attempt slot the session host
      // claims before a goal turn; without it a web goal turn is unattributed
      // (no budget, no receipt, no hard-cap consumption).
      { objective, objectiveAttemptSlot: createObjectiveAttemptSlot() }
    : {}

const turnActivitySlot = (
  activeTurnRef: ActiveTurnRefHolder | undefined,
): Partial<Pick<AgentConfig, "activeTurnRef">> =>
  activeTurnRef !== undefined ? { activeTurnRef } : {}

/**
 * aug-27 — the model-switch pair (mirrors {@link turnActivitySlot}).
 *
 * `stickyModelStore` is what `skill-gate#readStickyModelForMode` reads at the top
 * of every turn; `modelCandidates` is the LIVE array (shared by reference with the
 * catalog wire, so a lazily-probed model is selectable next turn) that
 * `resolveSkillTurnOverride` resolves that pick to a PORT out of. BOTH or NEITHER:
 * the store alone writes a pick the swap cannot apply, the candidates alone have
 * nothing to select — which is the state where `set_model` looked accepted and
 * changed nothing. A helper (not an inline ternary) keeps `buildAgentConfigBase`
 * under biome's cognitive-complexity cap.
 */
const modelSwitchSlots = (
  modelSwitch: WebModelSwitchHandle | undefined,
): Partial<Pick<AgentConfig, "stickyModelStore" | "modelCandidates">> =>
  modelSwitch !== undefined
    ? {
        stickyModelStore: {
          store: modelSwitch.store,
          provider: modelSwitch.provider,
          effectiveModel: modelSwitch.effectiveModel,
        },
        modelCandidates: modelSwitch.candidates,
      }
    : {}

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
  modelSwitch,
  follower,
  activeTurnRef,
  observability,
  objective,
  postureControl,
  questionGuard,
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
  /** aug-27 — the model switch. Its store lands on `base.stickyModelStore` (read
   *  by `skill-gate#readStickyModelForMode` every turn) and its LIVE candidate
   *  array on `base.modelCandidates` (where `resolveSkillTurnOverride` resolves a
   *  picked id to a PORT). Both halves are required: the store alone writes a pick
   *  the swap cannot apply, the candidates alone have nothing to select. */
  readonly modelSwitch?: WebModelSwitchHandle | undefined
  readonly follower: ReturnType<typeof buildFollowerCoControlSlot>
  readonly activeTurnRef?: ActiveTurnRefHolder | undefined
  readonly observability: {
    readonly handle: ObservabilityWireHandle
    readonly bus: HookBus | undefined
  }
  // RFC-03 H1 (web parity fix) — the session-stable objective authority, minted
  // ONCE at the factory INDEPENDENT of the observability gate. Present (under
  // `QUANTA_OBJECTIVE_TOOLS`) ⇒ threaded onto `base.objective` so the per-turn
  // assembler's `maybeWireObjective` ADOPTS it (caller-override precedence) every
  // turn instead of re-minting a fresh port ⇒ durable cross-turn goal AND a real
  // out-of-band `session.objective.mutate` (`applyHostObjectiveMutation` reads
  // `base.objective`). NOTE: the transcript `webObjectiveSnapshot` reads the
  // FACADE's obs-gated `.objective` getter (`attachObservabilityPorts` ⇐
  // `handle.objective`), NOT this base slot, so its durable-snapshot arm is only
  // populated when observability is ALSO on — a pre-existing, separate concern
  // (see the GAP note in the factory; the facade getter must stay obs-coupled or
  // the emitter would leak objective frames with observability OFF). Absent (TOOLS
  // gate off) ⇒ omitted ⇒ `base.objective` undefined (byte-identical legacy,
  // whatever observability is).
  readonly objective?: ObjectivePort | undefined
  // RFC-05 E4 — the surface-owned posture FRONT-DOOR control; present ⇒ the host
  // `session.posture.set` applies the FULL lossless patch through the SAME live
  // authority the gate reads. Absent ⇒ mode-only compat (byte-identical).
  readonly postureControl?: PostureControl | undefined
  // RFC-05 E5 — the live `request_user_input` availability reader over that SAME
  // authority's bound `askOutsidePlan`. Absent ⇒ question available by default.
  readonly questionGuard?: QuestionAvailabilityReader | undefined
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
    // aug-27 — see {@link modelSwitchSlots}: the two halves the loop consumes.
    ...modelSwitchSlots(modelSwitch),
    // T02 — wire the conversation-action port + active-turn ref so a web
    // follower's steer lands as a mid-turn injection (the loop polls the port).
    ...(follower !== undefined ? { conversationActionPort: follower.surface.port } : {}),
    ...turnActivitySlot(activeTurnRef),
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
    // RFC-05 E4 — lift the posture front-door control onto the base so the host
    // `session.posture.set` projection (`applyHostPostureMutation`) applies the
    // FULL lossless patch through the SAME live authority the next turn's gate
    // reads. Absent (selector off) ⇒ omitted ⇒ the mode-only compat fallback
    // (byte-identical legacy web behavior; NO silent rich-field drop).
    ...(postureControl !== undefined ? { postureControl } : {}),
    // RFC-05 E5 — lift the live `request_user_input` guard onto the base so the
    // spec projection + dispatch consult read the SAME authority's askOutsidePlan
    // (a `/posture ask off` reaches the next turn). Absent ⇒ available by default.
    ...(questionGuard !== undefined ? { questionGuard } : {}),
    // RFC-03 H1 (web parity fix) — lift the SESSION-STABLE objective authority
    // onto the base INDEPENDENT of observability. The per-turn assembler's
    // `maybeWireObjective` sees a defined `cfg.objective` (caller-override) and
    // ADOPTS it every turn (no per-turn re-mint ⇒ no cross-turn goal amnesia).
    // When obs is ON this is the SAME instance the obs wire attributes against
    // (single authority, no split-brain). Absent (TOOLS off) ⇒ omitted ⇒
    // undefined (byte-identical legacy). Sourced here, NOT from `observabilitySlots`.
    ...objectiveSlot(objective),
    ...observabilitySlots(observability),
  }
  return base
}
