/**
 * ★ HELLGATE — WS-H / UUX-3-01 (threading leg): `buildSessionLoopOptions` must
 * forward `wires.backgroundPortal` onto the loop deps.
 *
 * RED at HEAD: surface-compose builds the portal (QUANTA_BG_TURN) and even
 * documents "Threaded to the session loop for the Ctrl+B detach" — but
 * `buildSessionLoopOptions` never forwarded it, so `shouldWireBackground`
 * always saw `portal: undefined` in the REAL CLI: Ctrl+B detach (and hence
 * every downstream capture feature) was unreachable in production while the
 * loop-level hellgates stayed green (they inject the portal directly).
 * This is the classic dead-wire class the jul-2 slice-boundary audit named:
 * a composed-but-unthreaded dep is inert config.
 */

import { describe, expect, test } from "bun:test"
import { createBackgroundTurnPortal } from "../../../../../src/apps/cli/repl/background-turn-portal"
import { buildSessionLoopOptions } from "../../../../../src/apps/cli/repl/session-loop-options"

type Deps = Parameters<typeof buildSessionLoopOptions>[0]

/** Minimal lax fakes — buildSessionLoopOptions only PROJECTS these bundles;
 *  the fields below are the ones its projection actually touches. */
const makeFakes = (backgroundPortal: ReturnType<typeof createBackgroundTurnPortal> | undefined) => {
  const featureCfg = {
    history: { enabled: false, maxLines: 100, filePath: undefined },
    multiline: { enabled: false },
  } as unknown as Deps["featureCfg"]
  const setup = {
    cwd: "/tmp/loop-options-test",
    model: "m",
    slog: { info: () => undefined, warn: () => undefined, error: () => undefined },
    metrics: undefined,
    turnSummary: { render: () => "", reset: () => undefined },
    statusBar: { transient: () => undefined },
    pills: { update: () => undefined },
    lifecyclePills: { update: () => undefined, flush: () => undefined },
    lifecycleTaskRegistry: undefined,
    lifecycleFollowUpQueue: undefined,
    playbookCliFlag: undefined,
    searchPipelineDispose: undefined,
    costPanel: undefined,
  } as unknown as Deps["setup"]
  const surfaceState = { history: [], costDeltaPrev: {} } as unknown as Deps["surfaceState"]
  const wires = {
    dispatchSlash: async () => false,
    textInbox: undefined,
    convCheckpointWire: null,
    setReplaceMessages: undefined,
    setSideConversationStart: undefined,
    setPlanQueueSendNow: undefined,
    setAutomationSlash: undefined,
    planQueueStore: undefined,
    inboundMode: { current: "queue" as const },
    runtimeFacadeCompose: {},
    playbookSeam: undefined,
    ...(backgroundPortal !== undefined ? { backgroundPortal } : {}),
  } as unknown as Deps["wires"]
  const rfc09 = {} as unknown as Deps["rfc09"]
  return { setup, surfaceState, wires, rfc09, featureCfg, env: {} as NodeJS.ProcessEnv }
}

describe("session-loop-options — backgroundPortal threading (UUX-3-01)", () => {
  test("wires.backgroundPortal IS forwarded onto the loop deps (RED at HEAD: dropped)", async () => {
    const portal = createBackgroundTurnPortal()
    const opts = await buildSessionLoopOptions(makeFakes(portal))
    expect(opts.backgroundPortal).toBe(portal) // the SAME instance /background reads
  })

  test("absent portal ⇒ slot omitted (default-OFF byte-identical, no literal undefined)", async () => {
    const opts = await buildSessionLoopOptions(makeFakes(undefined))
    expect("backgroundPortal" in opts).toBe(false)
  })
})
