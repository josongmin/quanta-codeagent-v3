/**
 * `@/apps/web-daemon/runtime-factory` — production composition root.
 *
 * The daemon entry (`./index.ts`) injects this factory ONLY when invoked as
 * a script (`import.meta.main`). Tests still inject their own factory.
 *
 * Mirrors `src/apps/agent/mode-presets/interactive.ts` — same
 * `assembleAgentConfig({ mode:"interactive", ... })` pipeline, just exposed
 * as a long-running session over the WS transport instead of stdin.
 */

import type { AgentConfig, McpStoppable } from "@/agent"
import { buildSystemPrompt, HookBus } from "@/agent"
import type { ApprovalStateMachinePort } from "@/agent/approval-state-machine"
import { isControlRequestEnabled } from "@/agent/control-request"
import {
  type ConversationActionSurface,
  createConversationActionSurface,
} from "@/agent/conversation-action-surface"
import { type InboundMode, parseInboundMode } from "@/agent/inbound-mode"
import type { ObjectivePort } from "@/agent/objective"
import {
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  wireObservability,
} from "@/agent/observability-wire"
import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"
import { loadRepoRules } from "@/agent/repo-rules"
import type { RunLedgerPort } from "@/agent/run-ledger"
import { modeLoadsRepoRules } from "@/agent/run-mode"
import type { ShadowVerifyPort } from "@/agent/shadow-verify"
import { promptSurfaceProfileForRunMode, resolveCliDefaultEnvPosture } from "@/agent/system-prompt"
import { FollowerCoControlDispatcher, isFollowerCoControlEnabled } from "@/agent/thread-follower"
import { type ArtifactRegistry, createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import {
  buildMcpLoadOpts,
  loadMcpToolsOrEmpty,
  mcpAutoRestartEnabled,
  readMcpConfig,
  resolveMcpInboundWiring,
  resolveMcpLaunchPolicy,
  resolveMcpOAuthProvider,
} from "@/host/mcp-composition"
import { createMcpHealthHolder, sanitizeServerKey } from "@/host/mcp-health"
import {
  type ArtifactPreviewResolver,
  type AssemblerEnv,
  buildInteractiveTurnAssembler as buildSharedInteractiveTurnAssembler,
  createArtifactPreviewResolver,
  type InteractiveTurnAssemblerRequest,
} from "@/host/runtime"
import type { LLMPort } from "@/llm"
import { pickProvider, tryCreateLLM } from "@/llm"
import type { PersistentStorePort } from "@/memory"
import { StructuredLogger } from "@/observability"
import type { PermissionContext } from "@/permission"
import {
  buildMemoryForSession,
  buildSkillsConfigCore,
  buildSubagentConfigCore,
  parseEnvFlag,
} from "@/runner/assemble"
import {
  createRuntimeFromAgentConfigBase,
  type RuntimeAgentConfigBase,
  type RuntimeFacade,
} from "@/sdk/runtime"
import { checkSessionStoreHealth } from "@/session"
import { errMessage, gateOn, logger } from "@/shared"
import { discoverSkills, discoverSystemSkills } from "@/skill"
import { StdoutStream } from "@/stream"
import { TaskRegistry } from "@/subagent"
import { buildDefaultTools, type Tool, ToolRegistry } from "@/tool"
import { askUserTool } from "@/tool/ask-user"
import { type AgentStateSourceHandle, createAgentStateSource } from "./agent-state-source"
import { createSubagentSource, type SubagentSourceHandle } from "./subagent-source"
import {
  type CanvasArtifactSourceHandle,
  createCanvasArtifactSource,
} from "./canvas-artifact-source"
import {
  type CanvasToolDiffSourceHandle,
  createCanvasToolDiffSource,
} from "./canvas-tool-diff-source"
import { type CanvasUsageSourceHandle, createCanvasUsageSource } from "./canvas-usage-source"
import type {
  AgentFleetReadoutRow,
  McpServerRow,
  MemoryReadoutEntry,
  WebReadoutSources,
} from "./readout"
import { createWebAskUserPort } from "./web-ask-user-port"
import {
  createWebControlRequestPort,
  type WebControlRequestPortHandle,
} from "./web-control-request-port"
import { createWebUserInputPort, type WebUserInputPortHandle } from "./web-user-input-port"

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

/**
 * ADR-0415 — adapt a live {@link HookBus} to the duck-typed
 * {@link ObservabilityHookBus} the wire consumes (slice fence: the wire never
 * imports `@/agent/hooks`). `HookBus.on()` has no public unsubscribe, so the
 * detach is a no-op; `handle.detach()` drops the wire's local refs regardless.
 */
const toObservabilityHookBus = (bus: HookBus): ObservabilityHookBus => ({
  subscribe: (event, handler) => {
    bus.on(event, handler as never)
    return () => undefined
  },
})

/**
 * ADR-0415 — project the per-session observability wire into the conditional
 * AgentConfig slot fragment. Extracted from the factory closure to keep that
 * closure under biome's cognitive-complexity cap as the spread count grows.
 * Pure: every field is presence-only (absent ⇒ slot omitted; default-OFF
 * byte-identical under `exactOptionalPropertyTypes`).
 */
const observabilitySlots = (observability: {
  readonly handle: ObservabilityWireHandle
  readonly bus: HookBus | undefined
}): Partial<
  Pick<AgentConfig, "hooks" | "objective" | "runLedger" | "approvalStateMachine" | "shadowVerify">
> => {
  const { handle, bus } = observability
  return {
    ...(bus !== undefined ? { hooks: bus } : {}),
    ...(handle.objective !== undefined ? { objective: handle.objective } : {}),
    ...(handle.runLedger !== undefined ? { runLedger: handle.runLedger } : {}),
    ...(handle.approvalStateMachine !== undefined
      ? { approvalStateMachine: handle.approvalStateMachine }
      : {}),
    ...(handle.shadowVerify !== undefined ? { shadowVerify: handle.shadowVerify } : {}),
  }
}

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
const buildFollowerCoControlSlot = (
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

/** Surface wrapper over the shared host assembler (ADR-0303 thin-surface):
 *  binds the web-daemon's own `process.env` into the env-pure host builder so
 *  callers keep the legacy 0-/1-arg signature. */
export const buildInteractiveTurnAssembler = (req: InteractiveTurnAssemblerRequest = {}) =>
  buildSharedInteractiveTurnAssembler(req, process.env as AssemblerEnv)

/**
 * ADR-0404 + ADR-0415 — per-session observability wire for the web-daemon
 * surface. Mints the canonical {@link HookBus} the loop emits `post_tool_use`
 * to (the SAME bus run-ledger-attribution subscribes to) and stitches the four
 * ports together. Default-OFF byte-identical: `QUANTA_OBSERVABILITY !== "on"`
 * ⇒ `bus` is `undefined`, the wire is the shared noop handle, every port is
 * absent ⇒ the session config + facade are byte-identical to the legacy path.
 */
const wireSessionObservability = (
  env: Record<string, string | undefined>,
  cwd: string,
): { readonly handle: ObservabilityWireHandle; readonly bus: HookBus | undefined } => {
  if (!gateOn(env, "QUANTA_OBSERVABILITY")) {
    return { handle: wireObservability(), bus: undefined }
  }
  const bus = new HookBus()
  const handle = wireObservability({
    enabled: true,
    repoRoot: cwd,
    hookBus: toObservabilityHookBus(bus),
  })
  return { handle, bus }
}

/** A2 — the daemon's default tool registry with the SHARED artifact registry
 *  threaded in (gated) so the `artifact_*` tools register into the SAME instance
 *  the turn-drain reads. Absent registry ⇒ the artifact tools are NOT registered
 *  (byte-identical). Extracted to keep the factory closure under the god-FN cap. */
const buildDaemonToolRegistry = (
  artifactRegistry: ArtifactRegistry | undefined,
  extraTools: readonly Tool[] = [],
): ToolRegistry =>
  new ToolRegistry([
    ...buildDefaultTools(artifactRegistry !== undefined ? { artifactRegistry } : {}),
    ...extraTools,
  ])

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

/** UUX-1-11 — project a subagent `TaskRecord` onto the narrow readout row
 *  (structural copy; the readout renderer never imports `@/subagent`). */
const toAgentFleetReadoutRow = (rec: {
  id: string
  description: string
  agentType?: string
  status: "running" | "completed" | "failed" | "stopped"
  startedAt: number
  endedAt?: number
  error?: string
}): AgentFleetReadoutRow => ({
  id: rec.id,
  description: rec.description,
  ...(rec.agentType !== undefined ? { agentType: rec.agentType } : {}),
  status: rec.status,
  startedAt: rec.startedAt,
  ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
  ...(rec.error !== undefined ? { error: rec.error } : {}),
})

/** UUX-1-11 — project a durable `MemoryEntry` onto the narrow readout view
 *  (id/tier/text/importance only — tags & embeddings stay host-side). */
const toMemoryReadoutEntry = (entry: {
  id: string
  tier?: string
  text: string
  importance?: number
  createdAt: number
}): MemoryReadoutEntry => ({
  id: entry.id,
  ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
  text: entry.text,
  ...(entry.importance !== undefined ? { importance: entry.importance } : {}),
  createdAt: entry.createdAt,
})

/**
 * UUX-1-11 — assemble the read-only {@link WebReadoutSources} bundle from the
 * live session collaborators this factory just minted. Every accessor is a
 * thin projection over the SAME instance the loop runs on (no split-brain):
 *  - `agents`  → the TaskRegistry threaded into `subagent.taskRegistry`
 *  - `plan`    → the PlanStore on `base.planStore` (the 5 plan tools write it)
 *  - `skills`  → the same `discoverSkills`/`discoverSystemSkills` scan the CLI
 *                `/skills` slash performs (system wins name collisions)
 *  - `memory`  → the durable store `buildMemoryForSession(env)` resolves (the
 *                store the CLI writes; READ-ONLY here — this surface composes
 *                no memory config, so web turns do not write memories yet)
 *  - `context` → the always-on prompt-usage holder (`onPromptAssembled` sink)
 * `/cost` is deliberately absent: it is folded server-side in `startWebDaemon`
 * from `turn.completed` events (the daemon-native usage truth).
 */
const buildReadoutSources = (args: {
  readonly taskRegistry: TaskRegistry | undefined
  readonly planStore: PlanStore | undefined
  readonly skills: { dir?: string } | undefined
  readonly memoryStore: PersistentStorePort | undefined
  readonly usageHolder: CanvasUsageSourceHandle
}): WebReadoutSources => {
  const { taskRegistry, planStore, skills, memoryStore, usageHolder } = args
  return {
    ...(taskRegistry !== undefined
      ? { agents: () => taskRegistry.list().map(toAgentFleetReadoutRow) }
      : {}),
    ...(planStore !== undefined ? { plan: () => planStore.current() } : {}),
    ...(skills !== undefined
      ? {
          skills: async (): Promise<readonly { name: string; description: string }[]> => {
            const user = skills.dir !== undefined ? await discoverSkills(skills.dir) : []
            const system = await discoverSystemSkills()
            // System wins a name collision — same override order buildSkillBlock
            // uses, so the readout can never disagree with the model-visible set.
            const byName = new Map<string, { name: string; description: string }>()
            for (const s of [...user, ...system]) {
              byName.set(s.name, { name: s.name, description: s.description })
            }
            return [...byName.values()]
          },
        }
      : {}),
    ...(memoryStore !== undefined
      ? { memory: async () => (await memoryStore.all()).map(toMemoryReadoutEntry) }
      : {}),
    context: () => usageHolder.latest(),
    // P4/P2 (jul-11, UUX-4-18) — session-store health is a dependency-free
    // async probe (no SlashContext needed), so the `/doctor` readout is ALWAYS
    // available on this daemon (CLI parity for the store-health check).
    doctor: () => checkSessionStoreHealth(),
  }
}

/**
 * UUX-1-11 — mint the session collaborators that back both the LOOP (subagent
 * trio / plan tools / prompt-usage sink) and the READ-ONLY readout accessors.
 * Extracted from the factory closure (keeps it under the god-FN cap; mirrors
 * {@link resolveArtifactSlots}). Single-instance discipline: every collaborator
 * here is threaded into the AgentConfig AND read by {@link buildReadoutSources},
 * so a readout can never disagree with the tools.
 */
/**
 * P4 (jul-11, UUX-4-14) — compose MCP for the web daemon from the SAME
 * surface-shared assembly the CLI uses (`@/host/mcp-composition`, promoted out
 * of apps/cli). Headless: no elicitation prompter (an inbound elicitation is
 * auto-declined, byte-identical to a piped CLI). NEVER throws — a broken MCP
 * config must not crash daemon boot; on any fault the daemon serves with no MCP
 * tools and an empty health view.
 *
 * Returns the bridged tools (merged into the daemon registry), the client
 * handles (stopped on shutdown), and a LIVE `/mcp` readout accessor: up/down is
 * re-read from the health holder on every call (so a mid-session server death
 * shows ✗), tool counts are load-time.
 */
const loadDaemonMcp = async (
  env: Record<string, string | undefined>,
  llm: LLMPort,
): Promise<{
  readonly tools: readonly Tool[]
  readonly clients: readonly McpStoppable[]
  readonly mcpAccessor: (() => readonly McpServerRow[]) | undefined
}> => {
  try {
    const slog = new StructuredLogger()
    const configs = await readMcpConfig(slog, env, await resolveMcpLaunchPolicy(slog))
    if (configs.length === 0) return { tools: [], clients: [], mcpAccessor: undefined }
    const mcpHealth = createMcpHealthHolder()
    const loadOpts = buildMcpLoadOpts(slog, {
      autoRestart: mcpAutoRestartEnabled(),
      inboundWiring: resolveMcpInboundWiring(llm, undefined),
      oauthProvider: resolveMcpOAuthProvider(configs),
      opts: {},
      mcpHealth,
    })
    const { tools, clients } = await loadMcpToolsOrEmpty(configs, undefined, loadOpts)
    // Load-time tool count per RAW config server name (bridged names are
    // `mcp__<sanitized>__<tool>` — join by the sanitized key).
    const countBySanitized = new Map<string, number>()
    for (const t of tools) {
      const m = t.name.match(/^mcp__(.+?)__/)
      if (m?.[1] !== undefined) {
        countBySanitized.set(m[1], (countBySanitized.get(m[1]) ?? 0) + 1)
      }
    }
    const names = configs.map((c) => c.name)
    const mcpAccessor = (): readonly McpServerRow[] => {
      const down = mcpHealth.downServers()
      return names.map((name) => {
        const key = sanitizeServerKey(name)
        if (down.has(key)) {
          const reason = down.get(key)
          return reason !== undefined ? { name, status: "down", reason } : { name, status: "down" }
        }
        return { name, status: "up", toolCount: countBySanitized.get(key) ?? 0 }
      })
    }
    return { tools, clients, mcpAccessor }
  } catch {
    return { tools: [], clients: [], mcpAccessor: undefined }
  }
}

const mintSessionCollaborators = (
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
const mintLivePermissionCell = (): PermissionContext => {
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
const mintInboundPorts = (
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

/**
 * Assemble the {@link RuntimeAgentConfigBase} for a web-daemon session from the
 * per-session collaborators the factory just minted. Extracted from the factory
 * closure to keep it under the god-FN cap (mirrors {@link mintSessionCollaborators}
 * / {@link mintInboundPorts}); a pure projection — every conditional field is
 * presence-only so an absent gate omits the slot (default-OFF byte-identical).
 * The `webEnvPosture` derivation rides along as an own-local off `env`.
 */
const buildAgentConfigBase = async ({
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
    // `permission` cell). `env` is the daemon's own `process.env` so the
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
    ...observabilitySlots(observability),
  }
  return base
}

/**
 * Build a `runtimeFactory` suitable for `WebDaemonConfig`. The LLM port is
 * resolved ONCE at boot (env-driven provider pick); each invocation of the
 * returned factory mints a fresh {@link ObservableRuntimeFacade} (= fresh
 * session host) whose four observability getters proxy that session's wire
 * handle (ADR-0415). The widened return type is structurally a `RuntimeFacade`
 * so `WebDaemonConfig.runtimeFactory` accepts it unchanged.
 */
export const buildProductionRuntimeFactory = (): (() => Promise<ObservableRuntimeFacade>) => {
  const env = process.env as Record<string, string | undefined>
  const provider = pickProvider(env)
  const llm = tryCreateLLM(provider, {}, env)
  if (llm === null) {
    throw new Error(
      `web-daemon: LLM provider "${provider}" not configured ` +
        `(set ANTHROPIC_API_KEY / OPENAI_API_KEY, or run /login for chatgpt-oauth)`,
    )
  }

  return async (): Promise<ObservableRuntimeFacade> => {
    const cwd = process.cwd()
    const abort = new AbortController()
    // ADR-0211/web — live permission cell (see {@link mintLivePermissionCell}).
    const permission = mintLivePermissionCell()
    // UUX-1-11 — the loop/readout collaborator bundle (subagent registry, plan
    // store, memory store, prompt-usage holder). See {@link mintSessionCollaborators}.
    const { taskRegistry, subagent, skills, planStore, memoryStore, usageHolder, canvasUsage } =
      mintSessionCollaborators(env)
    // ADR-0415 — per-session observability wire. Gate OFF ⇒ noop handle +
    // undefined bus ⇒ `observabilitySlots` returns `{}` (byte-identical legacy).
    // Threading the live bus + promoted ports onto the session config makes the
    // loop's dispatch emit onto the SAME bus attribution subscribed to, and the
    // approval-gate wire read ONE unified model.
    const observability = wireSessionObservability(env, cwd)
    // ADR-0440 wire-finish — tool-diff source. Gate OFF ⇒ undefined ⇒ no
    // `onToolDiff` wired (no tool captures, byte-identical) + no facade port ⇒
    // the server forwards no `tool.diff` frames.
    const canvasToolDiff = gateOn(env, "QUANTA_WEB_CANVAS")
      ? createCanvasToolDiffSource()
      : undefined
    // A2 — the artifact slice: canvas source (QUANTA_WEB_CANVAS) + the SHARED
    // registry & preview resolver (QUANTA_ARTIFACT_STORE). Extracted so this
    // factory closure stays under the god-FN cap. Gate OFF ⇒ all undefined
    // (byte-identical). See {@link resolveArtifactSlots}.
    const { canvasArtifact, artifactRegistry, artifactPreviewResolver } = resolveArtifactSlots(
      env,
      cwd,
    )
    // OUT-OF-BAND INBOUND port cluster (agent-state tap + user-input mirror +
    // T02 follower + ADR-0496 control-request + gated ask_user). Each keeps its
    // original gate; see {@link mintInboundPorts}.
    const { agentState, subagentSource, userInput, follower, controlRequest, askUserTools } =
      mintInboundPorts(env, permission)
    // P4 (jul-11, UUX-4-14) — compose MCP from the surface-shared assembly
    // (@/host/mcp-composition). No .mcp.json ⇒ empty (byte-identical). Bridged
    // tools join the registry; clients stop on shutdown; the /mcp readout goes
    // live. NEVER throws (a broken config never crashes daemon boot).
    const { tools: mcpTools, clients: mcpClients, mcpAccessor } = await loadDaemonMcp(env, llm)
    const base = await buildAgentConfigBase({
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
    })
    const turnAssembler = buildInteractiveTurnAssembler()
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      turnAssembler,
      history: [...base.messages],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => {
        // P4 — release MCP client handles (child processes / sockets) on close.
        for (const c of mcpClients) await c.stop?.()
      },
    })
    // ADR-0415 — expose the wire ports on the facade so the daemon's emitter
    // reads live state. Gate OFF ⇒ getters read undefined ⇒ emitter silent.
    const facade = attachObservabilityPorts(runtime, observability.handle)
    // Expose every optional live port as a read-only getter (present ⇒ the daemon
    // subscribes/reads it; absent ⇒ the field is undefined ⇒ no sink/route,
    // byte-identical). ADR-0440 canvas usage/tool-diff/artifact; A2 registry +
    // preview resolver; QUANTA_WEB_AGENT_STATE agent-state + inbound; ADR-0496 A1
    // control-request; T02 follower.
    defineOptionalFacadeGetters(facade, {
      canvasUsage,
      canvasToolDiff,
      canvasArtifact,
      artifactRegistry,
      artifactPreviewResolver,
      agentState,
      // QUANTA_WEB_SUBAGENTS — expose the source so `index.ts` threads it into
      // the server config; `server.ts` installs the topic broadcast. Absent ⇒
      // getter reads undefined ⇒ no install (byte-identical).
      ...(subagentSource !== undefined ? { subagentSource } : {}),
      ...(userInput !== undefined ? { userInput } : {}),
      // QUANTA_CONTROL_REQUEST — expose the control-request port so the daemon's
      // server can `enqueue(req)` a peeked `controlRequest` frame. Absent ⇒ no
      // enqueue target (byte-identical).
      ...(controlRequest !== undefined ? { controlRequest } : {}),
      ...(follower !== undefined ? { followerCoControl: follower.dispatcher } : {}),
      // UUX-1-11 — read-only readout accessor bundle over the SAME live
      // collaborators wired above (fleet registry / plan store / skills config /
      // durable memory store / usage holder). The server threads it into the
      // `GET /readout/:name` route.
      readoutSources: buildReadoutSources({
        taskRegistry,
        planStore,
        skills,
        memoryStore,
        usageHolder,
        ...(mcpAccessor !== undefined ? { mcp: mcpAccessor } : {}),
      }),
    })
    return facade
  }
}

/** Define each present value as a read-only enumerable getter on the facade
 *  (Object.defineProperty, NOT a shallow copy, so the facade's prototype-bound
 *  methods keep working — same discipline as {@link attachObservabilityPorts}).
 *  An `undefined` value is SKIPPED so an absent gate leaves the field truly
 *  absent (byte-identical default-OFF). Collapses the per-port define blocks so
 *  the factory closure stays under the god-FN cap. */
const defineOptionalFacadeGetters = (
  facade: ObservableRuntimeFacade,
  ports: Readonly<Record<string, unknown>>,
): void => {
  for (const [key, value] of Object.entries(ports)) {
    if (value === undefined) continue
    Object.defineProperty(facade, key, { get: () => value, enumerable: true })
  }
}
