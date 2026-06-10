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

import type { AgentConfig } from "@/agent"
import { buildSystemPrompt, HookBus } from "@/agent"
import type { ApprovalStateMachinePort } from "@/agent/approval-state-machine"
import type { ObjectivePort } from "@/agent/objective"
import {
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  wireObservability,
} from "@/agent/observability-wire"
import type { RunLedgerPort } from "@/agent/run-ledger"
import type { ShadowVerifyPort } from "@/agent/shadow-verify"
import {
  type AssemblerEnv,
  buildInteractiveTurnAssembler as buildSharedInteractiveTurnAssembler,
  type InteractiveTurnAssemblerRequest,
} from "@/host/runtime"
import { pickProvider, tryCreateLLM } from "@/llm"
import type { PermissionContext } from "@/permission"
import { buildSkillsConfigCore, buildSubagentConfigCore, parseEnvFlag } from "@/runner/assemble"
import { createRuntimeFromAgentConfigBase, type RuntimeFacade } from "@/sdk/runtime"
import { gateOn } from "@/shared"
import { StdoutStream } from "@/stream"
import { buildDefaultTools, ToolRegistry } from "@/tool"
import { type AgentStateSourceHandle, createAgentStateSource } from "./agent-state-source"
import {
  type CanvasToolDiffSourceHandle,
  createCanvasToolDiffSource,
} from "./canvas-tool-diff-source"
import { type CanvasUsageSourceHandle, createCanvasUsageSource } from "./canvas-usage-source"
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
   * QUANTA_WEB_AGENT_STATE — agent-state source fed by the session's
   * `onAgentState` seam (the out-of-band stream tap). Present only when
   * `QUANTA_WEB_AGENT_STATE=1` (gate OFF ⇒ undefined ⇒ the server forwards no
   * `agentState` frames, byte-identical).
   */
  readonly agentState?: AgentStateSourceHandle
  /**
   * QUANTA_WEB_AGENT_STATE — the OUT-OF-BAND INBOUND port (mirror of the
   * agent-state OUTBOUND tap). When present, `AgentConfig.userInputPort` is
   * wired so the `request_user_input` tool is registered + a paused agent can be
   * answered from the browser. Minted on the SAME gate as the agent-state source
   * (you can only answer a prompt you can see). Gate OFF ⇒ undefined ⇒ the tool
   * is not registered ⇒ the agent cannot ask on web (byte-identical).
   */
  readonly userInput?: WebUserInputPortHandle
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
    // ADR-0211/web — a LIVE getter/setter proxy over a mutable cell (the exact
    // shape `bootstrap-session.ts` builds). The per-turn permission gate reads
    // `permission.mode` fresh each turn, so `host.setPermissionMode` (→
    // `session.permission.set`) is honored mid-session WITHOUT rebuilding the
    // session. A fixed scalar (the old `{ mode: "default" }`) made web mode
    // switching a lying control; this makes it real.
    let permMode: PermissionContext["mode"] = "default"
    const permission: PermissionContext = {
      get mode() {
        return permMode
      },
      set mode(next) {
        permMode = next
      },
    }
    // Default-ON (env-disablable) capability blocks — same truth table as the
    // CLI (`internal.ts`), so the web/tauri surface gets subagent fan-out + the
    // skill catalogue/auto-trigger by default. `QUANTA_SUBAGENT=0` /
    // `QUANTA_SKILLS=0` opt out; `QUANTA_SKILLS_DIR` adds a user skill dir.
    const subagentEnabled = parseEnvFlag(env.QUANTA_SUBAGENT, true)
    // §25.1 — wire `run_workflow` on the web/tauri surface too (CLI parity with
    // apps/cli/internal.ts buildSubagentConfig). DEFAULT-OFF byte-identical:
    // QUANTA_WORKFLOW unset ⇒ `enableWorkflow` absent ⇒ the tool is NOT
    // registered (legacy web behavior). It rides the SAME tier-1 subagent
    // runner, so it requires subagent enabled AND QUANTA_WORKFLOW=1.
    const subagent = buildSubagentConfigCore({
      enabled: subagentEnabled,
      ...(subagentEnabled && parseEnvFlag(env.QUANTA_WORKFLOW, false)
        ? { enableWorkflow: true }
        : {}),
    })
    const skillsDir = env.QUANTA_SKILLS_DIR
    const skills = buildSkillsConfigCore({
      ...(skillsDir !== undefined ? { dir: skillsDir } : {}),
      enabled: parseEnvFlag(env.QUANTA_SKILLS, true),
    })
    // ADR-0415 — per-session observability wire. Gate OFF ⇒ noop handle +
    // undefined bus ⇒ `observabilitySlots` returns `{}` (byte-identical legacy).
    // Threading the live bus + promoted ports onto the session config makes the
    // loop's dispatch emit onto the SAME bus attribution subscribed to, and the
    // approval-gate wire read ONE unified model.
    const observability = wireSessionObservability(env, cwd)
    // ADR-0440 — canvas usage source. Gate OFF ⇒ undefined ⇒ no
    // `onPromptAssembled` capture (byte-identical) + no facade port ⇒ the
    // server attaches no canvas sink.
    const canvasUsage = gateOn(env, "QUANTA_WEB_CANVAS") ? createCanvasUsageSource() : undefined
    // ADR-0440 wire-finish — tool-diff source. Gate OFF ⇒ undefined ⇒ no
    // `onToolDiff` wired (no tool captures, byte-identical) + no facade port ⇒
    // the server forwards no `tool.diff` frames.
    const canvasToolDiff = gateOn(env, "QUANTA_WEB_CANVAS")
      ? createCanvasToolDiffSource()
      : undefined
    // QUANTA_WEB_AGENT_STATE — agent-state source. Gate OFF ⇒ undefined ⇒ no
    // `onAgentState` wired ⇒ the stream tap is never installed (no capture,
    // byte-identical) + no facade port ⇒ the server forwards no `agentState`
    // frames.
    const agentState = gateOn(env, "QUANTA_WEB_AGENT_STATE")
      ? createAgentStateSource()
      : undefined
    // QUANTA_WEB_AGENT_STATE — the OUT-OF-BAND INBOUND port (mirror of the
    // agent-state OUTBOUND tap). Minted ONLY when the agent-state source exists
    // (same gate): a request/resolve frame rides the same agent-state channel,
    // and you can only answer a prompt you can see. Its `capture` feeds the
    // agent-state sink so the request + the resolve are forwarded to the
    // browser. Gate OFF ⇒ undefined ⇒ `userInputPort` absent ⇒ the
    // `request_user_input` tool is NOT registered (byte-identical).
    const userInput =
      agentState !== undefined
        ? createWebUserInputPort({ capture: (ev) => agentState.sink.capture(ev) })
        : undefined
    const base: Omit<AgentConfig, "modePolicy" | "budgetMeter"> = {
      llm,
      registry: new ToolRegistry(buildDefaultTools()),
      stream: new StdoutStream(),
      permission,
      messages: [],
      system: buildSystemPrompt(cwd),
      cwd,
      maxTurns: 200,
      signal: abort.signal,
      // SECURITY (jun-10) — enable the HITL 4-tier gate so the per-turn
      // permission gate enforces `hand-off-required` ⇒ HARD DENY and
      // `always-confirm` ⇒ ask EVEN under `bypass`/`acceptEdits`. Without this
      // the daemon's `session.permission.set("bypass")` would blanket-allow
      // every tool incl. hand-off-required ones — CLI parity
      // (`apps/cli/.../runtime-context-compose.ts` wires the same rails).
      hitl: { enabled: true },
      ...(subagent !== undefined ? { subagent } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(canvasUsage !== undefined ? { onPromptAssembled: canvasUsage.sink } : {}),
      ...(canvasToolDiff !== undefined ? { onToolDiff: canvasToolDiff.sink } : {}),
      ...(agentState !== undefined ? { onAgentState: agentState.sink } : {}),
      // QUANTA_WEB_AGENT_STATE — wire the inbound port so the agent can ask on
      // web (the tool registers iff this is present). Absent ⇒ tool not
      // registered (byte-identical).
      ...(userInput !== undefined ? { userInputPort: userInput.port } : {}),
      ...observabilitySlots(observability),
    }
    const turnAssembler = buildInteractiveTurnAssembler()
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base,
      turnAssembler,
      history: [...base.messages],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    // ADR-0415 — expose the wire ports on the facade so the daemon's emitter
    // reads live state. Gate OFF ⇒ getters read undefined ⇒ emitter silent.
    const facade = attachObservabilityPorts(runtime, observability.handle)
    // ADR-0440 — expose the canvas usage source so the daemon's canvas sink
    // subscribes to live per-turn usage. Gate OFF ⇒ undefined ⇒ no sink.
    if (canvasUsage !== undefined) {
      Object.defineProperty(facade, "canvasUsage", {
        get: () => canvasUsage,
        enumerable: true,
      })
    }
    // ADR-0440 wire-finish — expose the tool-diff source so the daemon's canvas
    // sink subscribes to live tool mutations. Gate OFF ⇒ undefined ⇒ no source.
    if (canvasToolDiff !== undefined) {
      Object.defineProperty(facade, "canvasToolDiff", {
        get: () => canvasToolDiff,
        enumerable: true,
      })
    }
    // QUANTA_WEB_AGENT_STATE — expose the agent-state source so the daemon's
    // agent-state sink subscribes to live captures. Gate OFF ⇒ undefined ⇒ no
    // source.
    if (agentState !== undefined) {
      Object.defineProperty(facade, "agentState", {
        get: () => agentState,
        enumerable: true,
      })
    }
    // QUANTA_WEB_AGENT_STATE — expose the inbound port so the daemon's server
    // can `resolve(promptId, …)` an inbound answer frame + `cancelAll()` on
    // disconnect. Gate OFF ⇒ undefined ⇒ no port (byte-identical).
    if (userInput !== undefined) {
      Object.defineProperty(facade, "userInput", {
        get: () => userInput,
        enumerable: true,
      })
    }
    return facade
  }
}
