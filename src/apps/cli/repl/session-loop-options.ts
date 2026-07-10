/**
 * CLI-06 (ADR-0307) — `runSessionLoop` OPTIONS assembly, extracted from the host
 * `runRepl` to keep repl.ts under its LOC budget (same slimming pattern as
 * `repl/factories/`). Pure composition: takes the already-built session / surface
 * / wire bundles and projects them into the exact `runSessionLoop` argument
 * shape, spreading every default-OFF slot conditionally so
 * `exactOptionalPropertyTypes` never sees a literal `undefined`. The host owns
 * entry routing; the per-turn loop wiring lives here.
 */

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
): ReturnType<typeof buildPromptUx> =>
  buildPromptUx(featureCfg, setup.cwd, env, (m) => setup.pills.update({ mode: m }), modeCycleStore)

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
    ux: await buildReplPromptUx(featureCfg, setup, env, wires.modeCycleStore),
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
