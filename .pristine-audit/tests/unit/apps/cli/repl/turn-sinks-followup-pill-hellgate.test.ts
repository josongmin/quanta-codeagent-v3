/**
 * UUX-6-23 HELLGATE — the follow-up pill must count BOTH queues at flush.
 *
 * Root cause: `turn-sinks.ts#snapshotAndFlushLifecyclePills` read ONLY
 * `lifecycleFollowUpQueue.size()` (the agent-level ADR-0037 queue drained by
 * `control-poll`), while mid-turn captured lines land on the session loop's
 * `externalPromptQueue` (the surface-level next-turn drain). A prompt queued
 * mid-turn therefore never moved the pill — the count desynced from what the
 * operator actually had pending.
 *
 * Fix pinned here: `flushLifecyclePills` accepts the loop's live
 * `{ externalQueued }` count and the pill renders the SUM of both sources.
 * The loop passes `externalPromptQueue.size()` at both flush call sites
 * (wiring pinned in `session-loop-hellgate.test.ts`).
 */
import { describe, expect, test } from "bun:test"
import type { LifecyclePills, LifecycleState } from "../../../../../src/apps/cli/lifecycle-pills"
import type { SessionSetupResult } from "../../../../../src/apps/cli/repl/session-setup"
import {
  composeTurnSinks,
  createSurfaceState,
} from "../../../../../src/apps/cli/repl/surface-compose/turn-sinks"

const capturePills = (): LifecyclePills & { patches: Array<Partial<LifecycleState>> } => {
  const patches: Array<Partial<LifecycleState>> = []
  return {
    patches,
    update: (p) => {
      patches.push(p)
    },
    render: () => "",
    flush: () => undefined,
    dispose: () => undefined,
  }
}

const buildSetup = (args: { pills: LifecyclePills; followUpSize?: number }): SessionSetupResult => {
  const partial = {
    model: "test-model",
    slog: { info: () => undefined },
    metrics: undefined,
    turnSummary: { render: () => "", reset: () => undefined },
    statusBar: { transient: () => undefined },
    lifecyclePills: args.pills,
    lifecycleTaskRegistry: undefined,
    lifecycleFollowUpQueue:
      args.followUpSize === undefined ? undefined : { size: () => args.followUpSize },
    mcpTools: [],
    mcpHealth: undefined,
    costPanel: undefined,
  }
  return partial as unknown as SessionSetupResult
}

const followUpPatches = (
  patches: Array<Partial<LifecycleState>>,
): Array<{ queued: number; pausedReason?: string }> =>
  patches.flatMap((p) => (p.followUp !== undefined ? [p.followUp] : []))

describe("UUX-6-23 — follow-up pill reads both queues at flush", () => {
  test("mid-turn external queue alone moves the pill (lifecycle queue absent)", () => {
    const pills = capturePills()
    const sinks = composeTurnSinks(
      buildSetup({ pills }),
      createSurfaceState({
        imageQueue: undefined,
        rewindState: undefined,
        history: [],
      }),
    )
    sinks.flushLifecyclePills({ externalQueued: 2 })
    const fu = followUpPatches(pills.patches)
    expect(fu.length).toBe(1)
    expect(fu[0]?.queued).toBe(2)
  })

  test("both sources present ⇒ pill shows the SUM", () => {
    const pills = capturePills()
    const sinks = composeTurnSinks(
      buildSetup({ pills, followUpSize: 1 }),
      createSurfaceState({
        imageQueue: undefined,
        rewindState: undefined,
        history: [],
      }),
    )
    sinks.flushLifecyclePills({ externalQueued: 2 })
    const fu = followUpPatches(pills.patches)
    expect(fu.length).toBe(1)
    expect(fu[0]?.queued).toBe(3)
  })

  test("paired control — no external count + no lifecycle queue ⇒ NO followUp patch (legacy byte-identical)", () => {
    const pills = capturePills()
    const sinks = composeTurnSinks(
      buildSetup({ pills }),
      createSurfaceState({
        imageQueue: undefined,
        rewindState: undefined,
        history: [],
      }),
    )
    sinks.flushLifecyclePills()
    expect(followUpPatches(pills.patches).length).toBe(0)
  })

  test("paired control — lifecycle queue only (no external arg) keeps legacy count", () => {
    const pills = capturePills()
    const sinks = composeTurnSinks(
      buildSetup({ pills, followUpSize: 4 }),
      createSurfaceState({
        imageQueue: undefined,
        rewindState: undefined,
        history: [],
      }),
    )
    sinks.flushLifecyclePills()
    const fu = followUpPatches(pills.patches)
    expect(fu.length).toBe(1)
    expect(fu[0]?.queued).toBe(4)
  })

  test("draining back to zero clears the pill (queued: 0 patch is emitted once a source existed)", () => {
    const pills = capturePills()
    const sinks = composeTurnSinks(
      buildSetup({ pills }),
      createSurfaceState({
        imageQueue: undefined,
        rewindState: undefined,
        history: [],
      }),
    )
    sinks.flushLifecyclePills({ externalQueued: 2 })
    sinks.flushLifecyclePills({ externalQueued: 0 })
    const fu = followUpPatches(pills.patches)
    expect(fu.length).toBe(2)
    expect(fu[1]?.queued).toBe(0)
  })
})
