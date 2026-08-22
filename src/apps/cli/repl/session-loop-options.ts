/**
 * CLI-06 (ADR-0307) — `runSessionLoop` OPTIONS assembly, extracted from the host
 * `runRepl` to keep repl.ts under its LOC budget (same slimming pattern as
 * `repl/factories/`). Pure composition: takes the already-built session / surface
 * / wire bundles and projects them into the exact `runSessionLoop` argument
 * shape, spreading every default-OFF slot conditionally so
 * `exactOptionalPropertyTypes` never sees a literal `undefined`. The host owns
 * entry routing; the per-turn loop wiring lives here.
 */

import { loadNamedAgents } from "@/agent"
import type { MentionLiveSources } from "@/host/runtime/internal/mention-source-deps"
import { resolveModelEffortSupport } from "@/llm/provider-metadata"
import { listSessions, type SessionMeta } from "@/session"
import { errMessage, logger } from "@/shared"
import { atAutocompleteEnabled } from "../at-autocomplete"
import type { McpServerInfo } from "../mcp-cmd"
import { runFocusNextAttention } from "../slash/attention-cmd"
import type { CliFeatureConfig } from "./cli-feature-config"
import type { buildNotifyAndContextWarning } from "./factories"
import type { runSessionLoop } from "./session-loop"
import type { setupSession } from "./session-setup"
import {
  buildPromptUx,
  type composeSurfaceWires,
  composeTurnSinks,
  type createSurfaceState,
} from "./surface-compose"
import type { EffortCycleWire, FocusAttentionWire } from "./surface-compose/prompt-ux"

type SessionLoopArgs = Parameters<typeof runSessionLoop>[0]
type Setup = Awaited<ReturnType<typeof setupSession>>
type SurfaceState = ReturnType<typeof createSurfaceState>
type Wires = ReturnType<typeof composeSurfaceWires>
type Rfc09 = ReturnType<typeof buildNotifyAndContextWarning>

/** RFC-08 — prompt-UX bundle (sink repaints the status-bar pill on shift+tab).
 *  `env` is INJECTED by the host (repl.ts, the allowlisted env owner) — this
 *  slice never reads `process.env` directly (anti-regression: env reads stay in
 *  the CLI bootstrap files). */
const buildReplPromptUx = (
  featureCfg: CliFeatureConfig,
  setup: Setup,
  env: NodeJS.ProcessEnv,
  // #13 (Agent-B, additive) — the surface-built mode-cycle store, so the
  // shift+tab pill/hook reuses the SAME instance the `/mode` slash mutates.
  // Absent ⇒ buildModeCycle mints its own (gate off ⇒ undefined anyway).
  modeCycleStore?: Wires["modeCycleStore"],
  // RFC-08 BUILD-1 — the live surface wires: `slashCtx.effort` (SAME EffortStore
  // + pill `/effort` mutates) and `setup.liveModelSource` (re-pointed by
  // surface-compose to the `/model` adapter's live `current()`). Absent the
  // effort slot ⇒ no effort-cycle wire ⇒ a bound chord is inert. NOT a new store.
  effortSlot?: NonNullable<Wires["slashCtx"]>["effort"],
  // RFC-01 A4 — the live `/attention` slot (the SAME wire the `/attention` slash
  // reads) so an operator-bound `focus-next-attention` chord takes the operator
  // to the exact agent `/attention next` would. Absent ⇒ no focus wire (a bound
  // chord is inert).
  slashCtx?: Wires["slashCtx"],
): ReturnType<typeof buildPromptUx> =>
  buildProviderMentionSources(setup, env).then((mentionSources) =>
    buildPromptUx(
      featureCfg,
      setup.cwd,
      env,
      (m) => setup.pills.update({ mode: m }),
      modeCycleStore,
      buildEffortCycleWire(setup.liveModelSource, effortSlot),
      // RFC-12-2 WIRING — the live sources for the `@`-autocomplete mcp/subagent/
      // thread listers. The MCP snapshot comes from the SAME `/mcp` surface the
      // resolver path uses; the named-agent registry is loaded from `setup.cwd`
      // (the session-resolved jail root — fail-open, same loader as
      // `composeCliRuntimeContext`); threads come from `listSessions`.
      mentionSources,
      buildFocusAttentionWire(slashCtx),
    ),
  )

/** RFC-01 A4 — project the live `/attention` slot onto the `focus-next-attention`
 *  hook contract. Reuses the EXACT `ctx.attention` + `ctx.agents` wires the
 *  `/attention` slash reads (one authority graph, no second reader) and the SAME
 *  `runFocusNextAttention` select+drill the slash's `next` sub-command runs, so
 *  the chord and the slash take the operator to the identical agent. The notice +
 *  drill are written to stdout (the reader repaints the prompt on the next key).
 *  Returns `undefined` when the attention slot is absent (gate off) ⇒ a bound
 *  chord stays inert (byte-identical). */
const buildFocusAttentionWire = (
  slashCtx: Wires["slashCtx"] | undefined,
): FocusAttentionWire | undefined => {
  const attention = slashCtx?.attention
  if (attention === undefined) return undefined
  const agents = slashCtx?.agents
  return {
    focusNext: () => {
      runFocusNextAttention({
        attention,
        agents,
        now: Date.now(),
        out: (s) => {
          process.stdout.write(s)
        },
      })
    },
  }
}

/** RFC-12-2 WIRING — build the autocomplete provider's LIVE mention sources from
 *  the settled `setup` bundle. MCP: the connected servers of `setup.mcpSurface`
 *  (server name → bridged tools). Subagent: `loadNamedAgents(setup.cwd)` (the
 *  repo-controlled registry — RFC-07 foreign-lineage-safe; fail-open to no
 *  subagent candidates). Thread: `listSessions` projected to the thread summary
 *  shape. Every source is OPTIONAL / NO-THROW ⇒ an absent source darkens ONLY
 *  its kind (byte-identical).
 *
 *  GATE-OFF BYTE-IDENTICAL: when `QUANTA_AT_AUTOCOMPLETE` is off there is no
 *  provider at all (`buildAtProvider` early-returns undefined), so this skips
 *  the `loadNamedAgents` fs scan + `listSessions` index read entirely — no new
 *  IO on the gate-off path (returns `{}`). */
const buildProviderMentionSources = async (
  setup: Setup,
  env: NodeJS.ProcessEnv,
): Promise<MentionLiveSources | undefined> => {
  if (!atAutocompleteEnabled(env)) return undefined
  const mcpServers = setup.mcpSurface?.servers
    ?.filter((s: McpServerInfo) => s.status === "connected")
    .map((s: McpServerInfo) => ({ name: s.name, tools: s.tools }))
  const hasMcp = mcpServers !== undefined && mcpServers.length > 0
  // Fail-open: a load fault ⇒ undefined ⇒ no subagent candidates (the provider
  // omits the lister). Same loader the resolver path uses.
  const subagents = await loadNamedAgents(setup.cwd).catch((e) => {
    // Fail-open probe (see comment above): a load fault ⇒ no subagent
    // candidates, but a failing agents-dir scan is a real (non-fatal) defect,
    // surfaced at warn (never stranded work — the mention list just omits them).
    logger.warn(`session-loop-options: loadNamedAgents failed: ${errMessage(e)}`)
    return undefined
  })
  return {
    ...(hasMcp ? { mcpServers } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
    sessions: async () =>
      (await listSessions()).map((m: SessionMeta) => ({
        id: m.id,
        title: m.title,
        cwd: m.cwd,
        ...(m.gitBranch !== undefined ? { gitBranch: m.gitBranch } : {}),
        ...(m.threadSource !== undefined ? { threadSource: m.threadSource } : {}),
        // B4 lineage — carry fork parentage so the `@thread:` autocomplete lister
        // scopes candidates to the caller's lineage (never suggest a sibling).
        ...(m.forkedFromId !== undefined ? { forkedFromId: m.forkedFromId } : {}),
      })),
    // B4 lineage scope — the caller's OWN thread id (fail-closed if absent).
    ...(setup.sessionId !== undefined ? { selfThreadId: setup.sessionId } : {}),
  }
}

/** RFC-08 BUILD-1 — project the live slash `effort` wire + the live model source
 *  onto the effort-cycle owner contract. Reuses the EXISTING `EffortStore`-backed
 *  `effort.get/set` (its `set` also repaints the pill), the live model id via
 *  `liveModelSource.source()` (surface-compose re-points it to the `/model`
 *  adapter's `current()`), and the SSOT `resolveModelEffortSupport` (the SAME
 *  function `buildModelAdapter.effortSupport` calls) — no second store/table.
 *  Returns `undefined` when the effort slot is absent (a surface without the
 *  `/effort` wire cannot cycle), so `buildEffortCycle` omits `onCycleEffort`.
 *  Exported for the focused wiring hellgate (it reads the LIVE model, not boot).
 */
export const buildEffortCycleWire = (
  liveModelSource: { readonly source: () => string },
  effortSlot: NonNullable<Wires["slashCtx"]>["effort"] | undefined,
): EffortCycleWire | undefined => {
  if (effortSlot === undefined) return undefined
  return {
    currentModel: () => liveModelSource.source(),
    effortSupport: (id) => resolveModelEffortSupport(id),
    effort: { get: () => effortSlot.get(), set: (level) => effortSlot.set(level) },
  }
}

/** Project the built bundles into the `runSessionLoop` argument object. */
export const buildSessionLoopOptions = async (deps: {
  setup: Setup
  surfaceState: SurfaceState
  wires: Wires
  rfc09: Rfc09
  featureCfg: CliFeatureConfig
  /** Injected by the host (repl.ts) so this slice never touches `process.env`. */
  env: NodeJS.ProcessEnv
  /** #8 last-mile (jun-6) — the live stdin source for the CONCURRENT in-turn
   *  keystroke reader. Injected by the host (repl.ts binds `process.stdin`) so
   *  this slice + the loop never poke `process.stdin` directly. Threaded onto
   *  the loop's `inTurnStdin` slot; only consumed when `QUANTA_MIDTURN_CAPTURE=1`
   *  (the loop short-circuits otherwise ⇒ default-OFF byte-identical). */
  inTurnStdin?: import("./in-turn-reader").InTurnReaderStdin
  /** ADR-0528 L2 — prompts the host re-injects as the first turn(s) (accepted
   *  crash-resume `resumeMessage`). Threaded onto the loop's `seedPrompts` slot;
   *  absent/empty ⇒ byte-identical. */
  seedPrompts?: readonly string[]
}): Promise<SessionLoopArgs> => {
  const { setup, surfaceState, wires, rfc09, featureCfg, env } = deps
  return {
    setup,
    dispatchSlash: wires.dispatchSlash,
    sinks: composeTurnSinks(setup, surfaceState),
    ...rfc09,
    ...(surfaceState.imageQueue !== undefined ? { imageQueue: surfaceState.imageQueue } : {}),
    textInbox: wires.textInbox,
    ux: await buildReplPromptUx(
      featureCfg,
      setup,
      env,
      wires.modeCycleStore,
      wires.slashCtx.effort,
      wires.slashCtx,
    ),
    registerExitTeardown: (cb) => {
      process.once("exit", cb)
    },
    // ADR-0292 — turn-end record + restore swap (null ⇒ loop short-circuits).
    convCheckpointWire: wires.convCheckpointWire,
    registerReplaceMessages: wires.setReplaceMessages,
    // UUX-4-07 — `/fork` switch install slot (absent when no id-mode rewind
    // state was built ⇒ the loop never installs ⇒ mint-and-stay behavior).
    ...(wires.setSwitchSession !== undefined
      ? { registerSessionSwitch: wires.setSwitchSession }
      : {}),
    registerSideConversationStart: wires.setSideConversationStart,
    registerPlanQueueSendNow: wires.setPlanQueueSendNow,
    // B2 (jul-04) — the loop installs the live `/cron` automation slash slot via
    // this setter once it mints the automation engine (late-bind).
    registerAutomationSlash: wires.setAutomationSlash,
    // #8 — the live plan-queue store, threaded so the loop can build the
    // mid-turn capture facade over it when QUANTA_MIDTURN_CAPTURE=1.
    planQueueStore: wires.planQueueStore,
    // `/goal` (Codex parity) — the surface-owned objective store, threaded so
    // the loop can arm the idle goal-continuation ticker over the SAME instance
    // `/goal` mutates (gated by QUANTA_GOAL_ENFORCE).
    objectiveStore: wires.objectiveStore,
    // #8 last-mile (jun-6) — the stdin source for the in-turn reader (host-
    // injected; default-OFF unless the capture knob is set). Spread by-presence.
    ...(deps.inTurnStdin !== undefined ? { inTurnStdin: deps.inTurnStdin } : {}),
    ...(deps.seedPrompts !== undefined && deps.seedPrompts.length > 0
      ? { seedPrompts: deps.seedPrompts }
      : {}),
    // §steer — inbound delivery: the conversation-action surface (weave/interrupt
    // sinks + activeTurnRef) + the session-mutable mode ref. Spread by-presence
    // so the queue-default / surface-absent path stays byte-identical.
    ...(wires.conversationActions !== undefined
      ? { conversationActions: wires.conversationActions }
      : {}),
    inboundMode: wires.inboundMode,
    // WS-H / UUX-3-01 — the background-turn portal (present iff QUANTA_BG_TURN).
    // Previously composed in surface-compose but NEVER forwarded here, which
    // left Ctrl+B detach unreachable in the real CLI (dead wire) while the
    // loop-level hellgates stayed green. Spread by-presence (default-OFF omits).
    ...(wires.backgroundPortal !== undefined ? { backgroundPortal: wires.backgroundPortal } : {}),
    runtimeFacadeCompose: wires.runtimeFacadeCompose,
    // ADR-0293 — seam attached by the loop once externalPromptQueue is born.
    playbookSeam: wires.playbookSeam,
    ...(setup.playbookCliFlag !== undefined ? { playbookCliFlag: setup.playbookCliFlag } : {}),
    // L5 M-11 — per-session search-wire teardown threaded onto the loop close stack.
    ...(setup.searchPipelineDispose !== undefined
      ? { searchPipelineDispose: setup.searchPipelineDispose }
      : {}),
  }
}
