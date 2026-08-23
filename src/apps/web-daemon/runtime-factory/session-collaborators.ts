/**
 * `@/apps/web-daemon/runtime-factory/session-collaborators` — ONE
 * responsibility: MINT the per-session collaborators and live ports the web
 * daemon runs on, each behind ITS OWN env gate.
 *
 * Every function here is a gate → instance mapping and nothing else (no
 * AgentConfig projection — that is `./agent-config-base`; no readout
 * projection — that is `./readout-sources`):
 *   - `buildFollowerCoControlSlot` (QUANTA_THIN_CLIENT_DISPATCH / QUANTA_INBOUND_MODE)
 *   - `resolveArtifactSlots`       (QUANTA_WEB_CANVAS / QUANTA_ARTIFACT_STORE)
 *   - `mintSessionCollaborators`   (QUANTA_SUBAGENT / QUANTA_WORKFLOW / QUANTA_SKILLS
 *                                   / QUANTA_PLAN_STORE / QUANTA_MEMORY / QUANTA_WEB_CANVAS)
 *   - `mintLivePermissionCell`     (ungated — the ADR-0211 live mode cell)
 *   - `mintInboundPorts`           (QUANTA_WEB_AGENT_STATE / QUANTA_WEB_SUBAGENTS
 *                                   / QUANTA_CONTROL_REQUEST / QUANTA_ASK_USER)
 *
 * The uniform contract: gate OFF ⇒ the slot is `undefined` ⇒ the consumer omits
 * the AgentConfig field / facade getter (default-OFF byte-identical).
 *
 * Extracted verbatim from `../runtime-factory.ts` (god-module split); that
 * module re-exports `resolveArtifactSlots`, so no importer moves. The edge is
 * ONE-WAY — the parent imports this file. `env` is always a PARAMETER here
 * (the ambient environment bag is bound only at the composition root).
 */

import { isControlRequestEnabled } from "@/agent/control-request"
import {
  type ConversationActionSurface,
  createConversationActionSurface,
} from "@/agent/conversation-action-surface"
import { type InboundMode, parseInboundMode } from "@/agent/inbound-mode"
import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"
import { FollowerCoControlDispatcher, isFollowerCoControlEnabled } from "@/agent/thread-follower"
import { type ArtifactRegistry, createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import { type ArtifactPreviewResolver, createArtifactPreviewResolver } from "@/host/runtime"
import type { PersistentStorePort } from "@/memory"
import type { PermissionContext } from "@/permission"
import {
  buildMemoryForSession,
  buildSkillsConfigCore,
  buildSubagentConfigCore,
  parseEnvFlag,
} from "@/runner/assemble"
import { gateOn } from "@/shared"
import { TaskRegistry } from "@/subagent"
import type { Tool } from "@/tool"
import { askUserTool } from "@/tool/ask-user"
import { type AgentStateSourceHandle, createAgentStateSource } from "../agent-state-source"
import {
  type CanvasArtifactSourceHandle,
  createCanvasArtifactSource,
} from "../canvas-artifact-source"
import { type CanvasUsageSourceHandle, createCanvasUsageSource } from "../canvas-usage-source"
import { createSubagentSource, type SubagentSourceHandle } from "../subagent-source"
import { createWebAskUserPort } from "../web-ask-user-port"
import {
  createWebControlRequestPort,
  type WebControlRequestPortHandle,
} from "../web-control-request-port"
import { createWebUserInputPort, type WebUserInputPortHandle } from "../web-user-input-port"

/**
 * T02 — build the thread-follower co-control slot for the web daemon. Gated on
 * `QUANTA_THIN_CLIENT_DISPATCH`: mints the conversation-action surface (the
 * lease-safe mid-turn inject path — the jun-09 CLI↔web parity gap) + the session
 * inbound-mode ref + the dispatcher whose sinks drive them. Extracted from the
 * factory closure (mirrors {@link observabilitySlots}) to keep it under biome's
 * cognitive-complexity cap. Gate OFF ⇒ undefined ⇒ no port wired (the loop never
 * polls, byte-identical). FIRE verbs only — a follower's approve/deny rides the
 * approval coordinator wired in `startWebDaemon` (timeout/stale + the resolver's
 * live HARD_DENY re-check); an approval verb routed to `dispatch()` is rejected.
 */
export const buildFollowerCoControlSlot = (
  env: Record<string, string | undefined>,
): { surface: ConversationActionSurface; dispatcher: FollowerCoControlDispatcher } | undefined => {
  if (!isFollowerCoControlEnabled(env)) return undefined
  const surface = createConversationActionSurface()
  const inbound: { current: InboundMode } = {
    current: parseInboundMode(env.QUANTA_INBOUND_MODE) ?? "queue",
  }
  const dispatcher = new FollowerCoControlDispatcher({
    sinks: {
      inject: (t) => surface.pushUserMessage(t),
      interrupt: (r) => surface.pushCancel(r),
      setQueueMode: (m) => {
        inbound.current = m
      },
    },
  })
  return { surface, dispatcher }
}

/**
 * A2 — resolve the artifact slice for the web daemon. Two independent gates:
 *  - `QUANTA_WEB_CANVAS` ⇒ the canvas artifact source (the server-boot bridge
 *    feeds it session `artifact.ready` events; each connection forwards a Canvas
 *    frame).
 *  - `QUANTA_ARTIFACT_STORE` ⇒ the SHARED per-session registry (backs the
 *    `artifact_*` tools + `base.artifactRegistry` producer drain + capability
 *    bit) AND the READ-ONLY preview resolver over the SAME registry (jailed to
 *    cwd), which the `GET /artifact/:id` route reads.
 *
 * Gate OFF ⇒ the field is undefined (byte-identical default-OFF).
 *
 * FOLLOW-UP (honest): the GENERATION tools (`image_gen` / office authoring) that
 * AUTO-register via an `artifactSink` are NOT gated on the web surface yet (their
 * ports live in the CLI's `buildGatedToolPorts`, not this factory) — so today the
 * web producer is the explicit `artifact_register` tool, not auto-registration.
 * The channel itself is fully wired.
 */
export const resolveArtifactSlots = (
  env: Record<string, string | undefined>,
  cwd: string,
): {
  readonly canvasArtifact: CanvasArtifactSourceHandle | undefined
  readonly artifactRegistry: ArtifactRegistry | undefined
  readonly artifactPreviewResolver: ArtifactPreviewResolver | undefined
} => {
  const canvasArtifact = gateOn(env, "QUANTA_WEB_CANVAS") ? createCanvasArtifactSource() : undefined
  const artifactRegistry = gateOn(env, "QUANTA_ARTIFACT_STORE")
    ? createArtifactRegistry({ now: () => Date.now(), idFactory: monotonicIdFactory() })
    : undefined
  const artifactPreviewResolver =
    artifactRegistry !== undefined
      ? createArtifactPreviewResolver({ registry: artifactRegistry, jailRoot: cwd })
      : undefined
  return { canvasArtifact, artifactRegistry, artifactPreviewResolver }
}

/**
 * UUX-1-11 — mint the session collaborators that back both the LOOP (subagent
 * trio / plan tools / prompt-usage sink) and the READ-ONLY readout accessors.
 * Extracted from the factory closure (keeps it under the god-FN cap; mirrors
 * {@link resolveArtifactSlots}). Single-instance discipline: every collaborator
 * here is threaded into the AgentConfig AND read by {@link buildReadoutSources},
 * so a readout can never disagree with the tools.
 */
export const mintSessionCollaborators = (
  env: Record<string, string | undefined>,
): {
  readonly subagentEnabled: boolean
  readonly taskRegistry: TaskRegistry | undefined
  readonly subagent: ReturnType<typeof buildSubagentConfigCore>
  readonly skills: ReturnType<typeof buildSkillsConfigCore>
  readonly planStore: PlanStore | undefined
  readonly memoryStore: PersistentStorePort | undefined
  readonly usageHolder: CanvasUsageSourceHandle
  readonly canvasUsage: CanvasUsageSourceHandle | undefined
} => {
  // Default-ON (env-disablable) capability blocks — same truth table as the
  // CLI (`internal.ts`), so the web/tauri surface gets subagent fan-out + the
  // skill catalogue/auto-trigger by default. `QUANTA_SUBAGENT=0` /
  // `QUANTA_SKILLS=0` opt out; `QUANTA_SKILLS_DIR` adds a user skill dir.
  const subagentEnabled = parseEnvFlag(env.QUANTA_SUBAGENT, true)
  // UUX-1-11 — surface-owned TaskRegistry so the `/agents` readout observes
  // the SAME fleet instance the subagent tool trio registers into (the CLI
  // does the identical thread via its lifecycle bundle). Absent when the
  // subagent capability is disabled ⇒ the readout degrades honestly.
  const taskRegistry = subagentEnabled ? new TaskRegistry() : undefined
  // §25.1 — wire `run_workflow` on the web/tauri surface too (CLI parity with
  // apps/cli/internal.ts buildSubagentConfig). DEFAULT-OFF byte-identical:
  // QUANTA_WORKFLOW unset ⇒ `enableWorkflow` absent ⇒ the tool is NOT
  // registered (legacy web behavior). It rides the SAME tier-1 subagent
  // runner, so it requires subagent enabled AND QUANTA_WORKFLOW=1.
  const subagent = buildSubagentConfigCore({
    enabled: subagentEnabled,
    ...(taskRegistry !== undefined ? { taskRegistry } : {}),
    ...(subagentEnabled && parseEnvFlag(env.QUANTA_WORKFLOW, false)
      ? { enableWorkflow: true }
      : {}),
  })
  const skillsDir = env.QUANTA_SKILLS_DIR
  const skills = buildSkillsConfigCore({
    ...(skillsDir !== undefined ? { dir: skillsDir } : {}),
    enabled: parseEnvFlag(env.QUANTA_SKILLS, true),
  })
  // UUX-1-11 — session plan store (CLI parity: QUANTA_PLAN_STORE default-ON,
  // opt-out). When present the loop registers the 5 structured plan tools and
  // the `/plan` readout renders the live `store.current()`.
  const planStore = parseEnvFlag(env.QUANTA_PLAN_STORE, true)
    ? createInMemoryPlanStore({ now: () => Date.now() })
    : undefined
  // UUX-1-11 — the durable memory store (ADR-0413 canonical factory; the
  // SAME sqlite file the CLI reads/writes). READ-ONLY on this surface: the
  // store backs the `/memory` readout only — `base.memory` is NOT set, so web
  // turns neither recall nor write memories (that activation is a separate,
  // deliberate decision). `QUANTA_MEMORY=off` ⇒ undefined ⇒ honest degrade.
  const memoryStore = buildMemoryForSession(env).store
  // UUX-1-11 — the prompt-usage holder is ALWAYS minted now: the `/context`
  // readout reads `latest()` on demand (pure observation; the sink runs the
  // same estimator the CLI `/context` uses). ADR-0440 canvas exposure stays
  // gated: `QUANTA_WEB_CANVAS` off ⇒ no facade port ⇒ the server attaches no
  // canvas sink and forwards no `context.usage` frames (same SINGLE holder
  // instance when on — no split-brain between the canvas panel and the readout).
  const usageHolder = createCanvasUsageSource()
  const canvasUsage = gateOn(env, "QUANTA_WEB_CANVAS") ? usageHolder : undefined
  return {
    subagentEnabled,
    taskRegistry,
    subagent,
    skills,
    planStore,
    memoryStore,
    usageHolder,
    canvasUsage,
  }
}

/**
 * ADR-0211/web — a LIVE getter/setter proxy over a mutable cell (the exact
 * shape `bootstrap-session.ts` builds). The per-turn permission gate reads
 * `permission.mode` fresh each turn, so `host.setPermissionMode` (→
 * `session.permission.set`) is honored mid-session WITHOUT rebuilding the
 * session. A fixed scalar (the old `{ mode: "default" }`) made web mode
 * switching a lying control; this makes it real. Extracted from the factory
 * closure to keep it under the god-FN cap.
 */
export const mintLivePermissionCell = (): PermissionContext => {
  let permMode: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return permMode
    },
    set mode(next) {
      permMode = next
    },
  }
}

/**
 * The OUT-OF-BAND INBOUND port cluster (extracted from the factory closure to
 * keep it under the god-FN cap; each mint keeps its original gate + docs):
 *  - `agentState` (QUANTA_WEB_AGENT_STATE) — the outbound stream tap; gate OFF
 *    ⇒ undefined ⇒ the tap is never installed + no facade port (byte-identical).
 *  - `userInput` — minted ONLY when the agent-state source exists (same gate):
 *    a request/resolve frame rides the same channel, and you can only answer a
 *    prompt you can see. Absent ⇒ `request_user_input` not registered.
 *  - `follower` (T02, QUANTA_THIN_CLIENT_DISPATCH) — co-control slot; absent ⇒
 *    no conversation-action port wired.
 *  - `controlRequest` (ADR-0496 A1, QUANTA_CONTROL_REQUEST) — binds the
 *    load-bearing `set_permission_mode` effect to THIS session's live
 *    `permission` cell. Gate OFF ⇒ no slot (the loop never polls; a stray
 *    `controlRequest` frame falls through as unknown).
 *  - `askUserTools` (A1 jul-03, QUANTA_ASK_USER) — the structured `ask_user`
 *    elicitation tool ADAPTED onto the web user-input round-trip (needs
 *    `userInput` for a channel). Either gate OFF ⇒ empty ⇒ not registered.
 */
export const mintInboundPorts = (
  env: Record<string, string | undefined>,
  permission: PermissionContext,
): {
  readonly agentState: AgentStateSourceHandle | undefined
  readonly subagentSource: SubagentSourceHandle | undefined
  readonly userInput: WebUserInputPortHandle | undefined
  readonly follower: ReturnType<typeof buildFollowerCoControlSlot>
  readonly controlRequest: WebControlRequestPortHandle | undefined
  readonly askUserTools: Tool[]
} => {
  const agentState = gateOn(env, "QUANTA_WEB_AGENT_STATE") ? createAgentStateSource() : undefined
  // QUANTA_WEB_SUBAGENTS — the Sub-Agents panel source (mirror of agentState).
  // Gate OFF ⇒ undefined ⇒ no `onSubagentEvent` sink, no facade port, no WS
  // frames (byte-identical). Installed onto the Bun server topic in `server.ts`.
  const subagentSource = gateOn(env, "QUANTA_WEB_SUBAGENTS") ? createSubagentSource() : undefined
  const userInput =
    agentState !== undefined
      ? createWebUserInputPort({ capture: (ev) => agentState.sink.capture(ev) })
      : undefined
  const follower = buildFollowerCoControlSlot(env)
  const controlRequest = isControlRequestEnabled(env)
    ? createWebControlRequestPort({ permission })
    : undefined
  const askUserTools: Tool[] =
    gateOn(env, "QUANTA_ASK_USER") && userInput !== undefined
      ? [askUserTool(createWebAskUserPort(userInput.port)) as Tool]
      : []
  return { agentState, subagentSource, userInput, follower, controlRequest, askUserTools }
}
