/**
 * `@/apps/web-daemon/runtime-factory` — production composition root.
 *
 * The daemon entry (`./index.ts`) injects this factory ONLY when invoked as
 * a script (`import.meta.main`). Tests still inject their own factory.
 *
 * Mirrors `src/apps/agent/mode-presets/interactive.ts` — same
 * `assembleAgentConfig({ mode:"interactive", ... })` pipeline, just exposed
 * as a long-running session over the WS transport instead of stdin.
 *
 * THIS module is now ONLY the composition root: it binds `process.env` /
 * `process.cwd()` once and ORDERS the boot steps. Each step's substance lives
 * in a cohesive sibling under `./runtime-factory/`, each named for its single
 * responsibility (the god-module split — the dependency edge is ONE-WAY, this
 * file imports them and none imports back):
 *
 *   - `./runtime-factory/observable-facade`      — the widened read-only facade
 *                                                  contract + the getter attachers.
 *   - `./runtime-factory/session-observability`  — the per-session ADR-0415
 *                                                  observability wire + its config slots.
 *   - `./runtime-factory/session-collaborators`  — MINT the gated per-session
 *                                                  collaborators and inbound ports.
 *   - `./runtime-factory/agent-config-base`      — PROJECT them onto the session
 *                                                  `RuntimeAgentConfigBase`.
 *   - `./runtime-factory/readout-sources`        — the READ-ONLY `/readout/:name`
 *                                                  projections.
 *   - `./runtime-factory/daemon-mcp`             — MCP composition + the `/mcp` accessor.
 *
 * The public surface is UNCHANGED — every export this module ever had is still
 * exported here (re-exported where the declaration moved), so no importer of
 * `@/apps/web-daemon/runtime-factory` moves a line.
 */

import {
  type AssemblerEnv,
  buildInteractiveTurnAssembler as buildSharedInteractiveTurnAssembler,
  type InteractiveTurnAssemblerRequest,
} from "@/host/runtime"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import { pickProvider, tryCreateLLM } from "@/llm"
import { applyGoalPreset } from "@/objective"
import { getDefaultPermissionStore, type PermissionStore } from "@/permission"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { errMessage, gateOn, logger } from "@/shared"
import { buildWebSkillAuthority } from "./authority-readouts"
import { createCanvasToolDiffSource } from "./canvas-tool-diff-source"
import { buildAgentConfigBase } from "./runtime-factory/agent-config-base"
import { loadDaemonMcp } from "./runtime-factory/daemon-mcp"
import {
  attachObservabilityPorts,
  defineOptionalFacadeGetters,
  type ObservableRuntimeFacade,
} from "./runtime-factory/observable-facade"
import { buildReadoutSources } from "./runtime-factory/readout-sources"
import {
  mintInboundPorts,
  mintSessionCollaborators,
  resolveArtifactSlots,
  resolveWebLivePosture,
} from "./runtime-factory/session-collaborators"
import { wireSessionObservability } from "./runtime-factory/session-observability"

/**
 * PUBLIC SURFACE (unchanged). `ObservableRuntimeFacade` /
 * `attachObservabilityPorts` now live in `./runtime-factory/observable-facade`,
 * `wireSessionObservability` in `./runtime-factory/session-observability`, and
 * `resolveArtifactSlots` in `./runtime-factory/session-collaborators` — they are
 * RE-EXPORTED verbatim here so every existing importer keeps its path.
 */
export type { ObservableRuntimeFacade }
export { attachObservabilityPorts, resolveArtifactSlots, wireSessionObservability }

/** Surface wrapper over the shared host assembler (ADR-0303 thin-surface):
 *  binds the web-daemon's own `process.env` into the env-pure host builder so
 *  callers keep the legacy 0-/1-arg signature. */
export const buildInteractiveTurnAssembler = (req: InteractiveTurnAssemblerRequest = {}) =>
  buildSharedInteractiveTurnAssembler(req, process.env as AssemblerEnv)

/**
 * Everything the production runtime needs BEFORE the agent config is assembled:
 * the abort scope, the live posture, the session registries and skills, the
 * objective authority and observability, the canvas/artifact slots, the
 * agent-state ports and the daemon's MCP surface.
 *
 * Extracted from the factory's returned closure, which `191ce3051` took past the
 * 150-line god-function ceiling. The bag is returned rather than typed by hand —
 * 29 values with types spread across a dozen modules — so the caller destructures
 * it and the rest of the closure keeps using the same bare names it always did.
 */
const assembleWebRuntimeParts = async (
  env: Record<string, string | undefined>,
  // NonNullable: the factory returns early when `tryCreateLLM` yields null, so the
  // closure this was extracted from only ever saw a live port — and that narrowing
  // cannot cross a function boundary.
  llm: NonNullable<ReturnType<typeof tryCreateLLM>>,
  // RFC-05 E3 (web parity) — the SAME on-disk permission store loader the CLI
  // threads (`getDefaultPermissionStore().load()`, fail-soft). Passed as a dep so
  // tests can inject a temp store; `resolveWebLivePosture` only consumes it when
  // BOTH QUANTA_POSTURE_SELECTOR and QUANTA_POSTURE_DURABLE_RESUME are on.
  loadPermissionStore: () => Promise<PermissionStore | undefined>,
) => {
  const cwd = process.cwd()
  const abort = new AbortController()
  // ADR-0211/web + RFC-05 E4/E5 — the live-posture slice. The `permission` mode
  // accessor is ALWAYS present (ADR-0211 live cell); under QUANTA_POSTURE_SELECTOR
  // it is the E3 adapter over the SAME authority the E4 `postureControl` +
  // E5 `questionGuard` mutate/read, so a wire `session.posture.set` applies the
  // FULL patch (not the silent mode-only drop). Gate OFF ⇒ mode cell only ⇒
  // control/guard undefined (byte-identical). See {@link resolveWebLivePosture}.
  // RFC-05 E3 — under both QUANTA_POSTURE_SELECTOR + QUANTA_POSTURE_DURABLE_RESUME the
  // live posture is backed by the on-disk store keyed by the stable daemon identity
  // (a restart restores the last effective posture); either gate OFF ⇒ in-memory seed.
  const { permission, postureControl, questionGuard } = await resolveWebLivePosture(
    env,
    loadPermissionStore,
  )
  // UUX-1-11 — the loop/readout collaborator bundle (subagent registry, plan
  // store, memory store, prompt-usage holder). See {@link mintSessionCollaborators}.
  const { taskRegistry, subagent, skills, planStore, memoryStore, usageHolder, canvasUsage } =
    mintSessionCollaborators(env)
  // RFC-06 F4 — the ONE durable skill runtime authority for this web session.
  // Threaded to the AGENT via `config.skills.authority` (buildSkillBlock reads
  // it) AND to the `/skills` readout (its `active` projection) — so prompt,
  // ToolSearch, invocation and the web panel converge on one authority. This is
  // the SINGLE discovery owner; the old independent readout scan is gone.
  const skillAuthority = await buildWebSkillAuthority(skills, env)
  const skillsWithAuthority =
    skills !== undefined && skillAuthority !== undefined
      ? { ...skills, authority: skillAuthority }
      : skills
  // RFC-03 H1 (web parity fix) — mint THE ONE session-stable objective
  // authority HERE, ONCE, INDEPENDENT of observability. `confirmationAvailable:
  // false` (web has no `onConfirm`) ⇒ FAIL-CLOSED under QUANTA_PROPOSE_GOAL; the
  // builder returns `undefined` when `QUANTA_OBJECTIVE_TOOLS` is off ⇒ no leak.
  // The SAME instance is threaded onto `base.objective` (durable cross-turn goal)
  // AND fed into the obs wire below for approval-attribution (single authority,
  // no split-brain). Web durable objective restore is a documented Phase-2
  // per-connection park ⇒ NO `restoreFrom` (mint fresh). This replaces the old
  // mint that lived INSIDE `wireSessionObservability`, which left `base.objective`
  // undefined whenever observability was OFF (cross-turn goal amnesia).
  const objective = resolveGatedObjectiveAuthority(env, { confirmationAvailable: false })
  // ADR-0415 — per-session observability wire. Gate OFF ⇒ noop handle +
  // undefined bus ⇒ `observabilitySlots` returns `{}` (byte-identical legacy).
  // Threading the live bus + promoted ports onto the session config makes the
  // loop's dispatch emit onto the SAME bus attribution subscribed to, and the
  // approval-gate wire read ONE unified model. The objective is INJECTED (the
  // same instance threaded onto the base) so obs attribution and the base share
  // ONE authority.
  const observability = wireSessionObservability(env, cwd, objective)
  // ADR-0440 wire-finish — tool-diff source. Gate OFF ⇒ undefined ⇒ no
  // `onToolDiff` wired (no tool captures, byte-identical) + no facade port ⇒
  // the server forwards no `tool.diff` frames.
  const canvasToolDiff = gateOn(env, "QUANTA_WEB_CANVAS") ? createCanvasToolDiffSource() : undefined
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
  const {
    agentState,
    subagentSource,
    userInput,
    follower,
    activeTurnRef,
    controlRequest,
    askUserTools,
  } = mintInboundPorts(env, permission)
  // P4 (jul-11, UUX-4-14) — compose MCP from the surface-shared assembly
  // (@/host/mcp-composition). No .mcp.json ⇒ empty (byte-identical). Bridged
  // tools join the registry; clients stop on shutdown; the /mcp readout goes
  // live. NEVER throws (a broken config never crashes daemon boot).
  const { tools: mcpTools, clients: mcpClients, mcpAccessor } = await loadDaemonMcp(env, llm)
  return {
    cwd,
    abort,
    permission,
    postureControl,
    questionGuard,
    taskRegistry,
    subagent,
    skills,
    planStore,
    memoryStore,
    usageHolder,
    canvasUsage,
    skillAuthority,
    skillsWithAuthority,
    objective,
    observability,
    canvasToolDiff,
    canvasArtifact,
    artifactRegistry,
    artifactPreviewResolver,
    agentState,
    subagentSource,
    userInput,
    follower,
    activeTurnRef,
    controlRequest,
    askUserTools,
    mcpTools,
    mcpClients,
    mcpAccessor,
  }
}

/**
 * The production durable-posture store loader — the SAME shape the CLI threads
 * (`repl.ts`): `getDefaultPermissionStore().load()`, fail-soft to `undefined` on any
 * error so a corrupt/unreadable store degrades to the in-memory seed and NEVER
 * crashes daemon boot. CLI and web share this default store file, so the operator's
 * durable posture lives on one machine. Only consumed when both posture gates are on.
 */
const loadDefaultPermissionStore = async (): Promise<PermissionStore | undefined> => {
  try {
    const store = getDefaultPermissionStore()
    await store.load()
    return store
  } catch (e) {
    // Fail-soft is the DESIGN (a corrupt store must not stop daemon boot), but
    // silence is not: the operator's durable posture just vanished and every
    // approval falls back to the in-memory seed. Say which, and why.
    logger.warn(`web-daemon.loadDefaultPermissionStore: ${errMessage(e)}`)
    return undefined
  }
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
  applyGoalPreset(env)
  const provider = pickProvider(env)
  const llm = tryCreateLLM(provider, {}, env)
  if (llm === null) {
    throw new Error(
      `web-daemon: LLM provider "${provider}" not configured ` +
        `(set ANTHROPIC_API_KEY / OPENAI_API_KEY, or run /login for chatgpt-oauth)`,
    )
  }

  return async (): Promise<ObservableRuntimeFacade> => {
    const {
      cwd,
      abort,
      permission,
      postureControl,
      questionGuard,
      taskRegistry,
      subagent,
      planStore,
      memoryStore,
      usageHolder,
      canvasUsage,
      skillAuthority,
      skillsWithAuthority,
      objective,
      observability,
      canvasToolDiff,
      canvasArtifact,
      artifactRegistry,
      artifactPreviewResolver,
      agentState,
      subagentSource,
      userInput,
      follower,
      activeTurnRef,
      controlRequest,
      askUserTools,
      mcpTools,
      mcpClients,
      mcpAccessor,
    } = await assembleWebRuntimeParts(env, llm, loadDefaultPermissionStore)
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
      // RFC-06 F4 — pass the authority-augmented skills so buildSkillBlock reads
      // the ONE shared authority (config.skills.authority) instead of minting an
      // interim one (single authority across prompt/search/invocation/readout).
      skills: skillsWithAuthority,
      planStore,
      usageHolder,
      canvasToolDiff,
      agentState,
      subagentSource,
      userInput,
      controlRequest,
      follower,
      activeTurnRef,
      observability,
      // RFC-03 H1 (web parity fix) — the session-stable objective authority
      // (minted once above) lands on `base.objective`, so every turn's assembler
      // ADOPTS the SAME port (no per-turn re-mint ⇒ durable goal + live snapshot +
      // a real out-of-band `session.objective.mutate`).
      objective,
      // RFC-05 E4/E5 — thread the front-door control + question guard onto the
      // config base so the host `session.posture.set` projection applies the FULL
      // lossless patch through the SAME live authority the gate reads (absent when
      // the selector is off ⇒ omitted ⇒ mode-only compat, byte-identical).
      postureControl,
      questionGuard,
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
      // RFC-03 C2 (web-parity persistence seam) — expose the SESSION-STABLE
      // objective authority (minted once above under QUANTA_OBJECTIVE_TOOLS) as a
      // NON-obs, plain value getter for TRANSCRIPT PERSISTENCE only. The daemon's
      // `webObjectiveSnapshot` reads THIS field — NOT the obs-gated `objective`
      // getter (which `attachObservabilityPorts` proxies off the wire handle and
      // returns undefined under obs-off) — so the durable goal persists whenever
      // TOOLS is on, independent of observability. It is NOT an observability
      // emitter port ⇒ exposing it emits no obs frame (obs stream byte-identical).
      // Absent when TOOLS is off: `objective` is undefined and
      // `defineOptionalFacadeGetters` SKIPS undefined values ⇒ no getter ⇒
      // snapshot undefined ⇒ transcript omits `objective` (byte-identical
      // default-OFF). Passed directly (like `canvasUsage`) — the helper's
      // undefined-skip removes the need for a guard ternary here.
      objectiveAuthority: objective,
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
      activeTurnRef,
      // UUX-1-11 — read-only readout accessor bundle over the SAME live
      // collaborators wired above (fleet registry / plan store / skills config /
      // durable memory store / usage holder). The server threads it into the
      // `GET /readout/:name` route.
      readoutSources: buildReadoutSources({
        taskRegistry,
        planStore,
        // RFC-06 F4 — the `/skills` readout reads the shared authority's active
        // projection (no independent discovery scan). Absent ⇒ honest missing line.
        skillAuthority,
        memoryStore,
        usageHolder,
        ...(mcpAccessor !== undefined ? { mcp: mcpAccessor } : {}),
      }),
    })
    return facade
  }
}
