/**
 * ★ HELLGATE (W1b) — the web can READ the goal, honestly, on a default install.
 *
 * MEASURED DEFECT (2026-08-30, two audit rounds): the browser has no `/goal` at
 * all — not the verb, not a read surface, not even one of the `unwired(...)`
 * palette stubs that at least tell a user to run it from the CLI. `grep goal
 * apps/web-frontend/src/components` finds only the observability pane's
 * rendering of `objective.goal`, and that pane is behind `QUANTA_OBSERVABILITY`,
 * which nothing seeds (a bare `bun run web:daemon` never shows it).
 *
 * The readout channel is the right home and it is the only default-ON one: it is
 * served out-of-band over HTTP, so it answers MID-TURN — exactly when you want to
 * look at a goal that is being worked — while the WS channel would be refused by
 * the single-writer lease. And because it is server-rendered text rather than a
 * mirrored type, it can carry what the observability `Objective` wire
 * structurally cannot: `revision`, the validation contract and the progress
 * receipts all live on `ObjectiveDomainSnapshot`, not on the projected
 * `Objective` that the emitter ships.
 *
 * Why this lands BEFORE the write verbs: on a fresh web session there is no
 * objective, and the two audit rounds proved the browser cannot create one (a
 * model `create` is `actor-forbidden` with the propose gate off and
 * `approval-unavailable` with it on, since the daemon composes no confirm
 * surface — probed both). A read surface is honest on an empty domain; a work
 * button would refuse 100% of the time.
 */

import { describe, expect, test } from "bun:test"
import {
  renderGoalReadout,
  resolveReadout,
  SOURCE_BACKED_READOUTS,
} from "@/apps/web-daemon/readout"
import { buildDaemonReadoutSources } from "@/apps/web-daemon/readout-compose"
import { createObjectiveAuthority, createObjectiveCapabilities } from "@/objective"
import type { SessionSnapshotLite } from "@/protocol/session"
import { makeSnapshotLite } from "../../../support/session-fixtures"

const SNAP: SessionSnapshotLite = makeSnapshotLite({
  sessionId: "goal-readout-1",
  revision: 1,
  seq: 1,
  capabilities: { tools: true, subagents: true, transport: "websocket" },
})

const THREAD = "goal-readout-1"

/** Compose the readout sources the way `startWebDaemon` does — the objective
 *  accessor is bound to the LIVE session id, which is the hop that broke for the
 *  observability pane before `bindObjectivePaneThread` existed. */
const setup = () => {
  const authority = createObjectiveAuthority({ now: () => 1_000 })
  const sources = buildDaemonReadoutSources({
    objectiveAuthority: authority,
    threadId: THREAD,
    now: () => 10_000,
  })
  return { authority, sources }
}

describe("W1b — /goal is a readout the daemon answers", () => {
  test("the name is part of the daemon's source-backed vocabulary", () => {
    expect(SOURCE_BACKED_READOUTS as readonly string[]).toContain("goal")
  })

  test("an EMPTY domain is SERVED honestly, not reported as an unwired surface", async () => {
    const { sources } = setup()

    const result = await resolveReadout("goal", SNAP, sources)

    expect(result.wired).toBe(true)
    expect(result.isError).toBe(false)
    expect(result.output.toLowerCase()).toContain("no goal")
    expect(result.data).toEqual({
      kind: "goal",
      revision: 0,
      validationContract: "missing",
      objective: null,
    })
  })

  test("a live goal renders the DOMAIN fields the objective projection cannot carry", async () => {
    const { authority, sources } = setup()
    createObjectiveCapabilities(authority).user.commit(THREAD, {
      kind: "create",
      definition: {
        goal: "ship the readout",
        successCriteria: ["tests pass"],
        budget: { maxTurns: 5 },
      },
    })

    const result = await resolveReadout("goal", SNAP, sources)

    expect(result.wired).toBe(true)
    expect(result.output).toContain("ship the readout")
    expect(result.output).toContain("active")
    // `revision` and the validation contract live ONLY on ObjectiveDomainSnapshot.
    // An implementation that renders `ObjectivePort.get()` physically cannot
    // produce these, which is what stops this test passing against a shortcut.
    expect(result.output).toContain("rev 1")
    expect(result.output).toContain("manual-only")
    expect(result.output).toContain("0/5 turns")
    expect(result.data?.objective).toMatchObject({
      goal: "ship the readout",
      status: "active",
      budget: { turnsUsed: 0, tokensUsed: 0, maxTurns: 5 },
      blockers: [],
    })
    expect(result.data?.objective?.objectiveId).toBeString()
    expect(result.data?.objective?.objectiveId.length).toBeGreaterThan(0)
    expect(result.data?.objective?.criteria[0]).toMatchObject({
      kind: "manual",
      text: "tests pass",
      met: false,
    })
  })

  test("the accessor is bound to the LIVE session id, not a placeholder", async () => {
    const { authority, sources } = setup()
    // A goal on some OTHER thread must not leak into this session's readout.
    createObjectiveCapabilities(authority).user.commit("some-other-thread", {
      kind: "create",
      definition: { goal: "not this session's goal" },
    })

    const result = await resolveReadout("goal", SNAP, sources)

    expect(result.output).not.toContain("not this session's goal")
    expect(result.output.toLowerCase()).toContain("no goal")
  })
})

describe("W1b — the readout says what is blocking a definition change", () => {
  test("a started attempt is rendered, so a refused edit has a visible cause", () => {
    const { authority } = setup()
    const caps = createObjectiveCapabilities(authority)
    caps.user.commit(THREAD, { kind: "create", definition: { goal: "ship the release" } })
    const objective = authority.get(THREAD)
    if (objective === null) throw new Error("no objective")
    caps.system.commit(THREAD, {
      kind: "beginAttempt",
      attempt: {
        objectiveId: objective.objectiveId,
        attemptId: "attempt-77",
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: authority.readDomain(THREAD).revision,
      },
    })

    const body = renderGoalReadout(authority.readDomain(THREAD), 10_000)

    // Without this line `/goal abandon` has no observable end state, and an
    // operator whose `edit` was refused `attempt-in-flight` cannot see why.
    expect(body).toContain("attempt: running")
    expect(body).toContain("attempt-7")
  })

  test("PAIRED CONTROL — no attempt in flight renders no attempt line", () => {
    const { authority } = setup()
    createObjectiveCapabilities(authority).user.commit(THREAD, {
      kind: "create",
      definition: { goal: "ship the release" },
    })

    const body = renderGoalReadout(authority.readDomain(THREAD), 10_000)

    expect(body).not.toContain("attempt: running")
  })

  test("a declared budget cap is rendered so an amendment can be observed", () => {
    const { authority } = setup()
    createObjectiveCapabilities(authority).user.commit(THREAD, {
      kind: "create",
      definition: { goal: "ship the release", budget: { maxTurns: 50 } },
    })

    expect(renderGoalReadout(authority.readDomain(THREAD), 10_000)).toContain("0/50 turns")
  })
})

describe("W1b — an absent accessor is honest about WHAT is missing", () => {
  test("no objective authority ⇒ a missing-source line that names the piece", async () => {
    const sources = buildDaemonReadoutSources({ threadId: THREAD, now: () => 10_000 })

    const result = await resolveReadout("goal", SNAP, sources)

    expect(result.wired).toBe(false)
    expect(result.output).toContain("objective")
    expect(result.output).not.toBe("not wired")
  })

  test("PAIRED CONTROL — 'no goal set' and 'not composed' are different answers", async () => {
    const wired = await resolveReadout("goal", SNAP, setup().sources)
    const unwired = await resolveReadout(
      "goal",
      SNAP,
      buildDaemonReadoutSources({ threadId: THREAD, now: () => 10_000 }),
    )

    expect(wired.output).not.toBe(unwired.output)
    expect(wired.wired).toBe(true)
    expect(unwired.wired).toBe(false)
  })
})
