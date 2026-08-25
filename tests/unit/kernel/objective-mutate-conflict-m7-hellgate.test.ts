/**
 * RFC-03 M7 (MED — wire swallows CAS conflict) HELLGATE.
 *
 * BASE DEFECT: `session.objective.mutate` was the lone command front door that
 * DROPPED CAS conflicts. `authority.commit()` returns `{ok:false, reason:"stale"
 * |...}` (never throws), but `applyHostObjectiveMutation` DISCARDED the return
 * and `mutateObjective` was typed `void`, so the scheduler emitted a SUCCESS
 * `session.state.updated` echo with a bumped revision even for a stale / policy-
 * rejected edit — falsely succeeding while clobbering nothing (the winner's
 * commit stood, but the loser reported success).
 *
 * FIX (mirrors posture/skill): `mutateObjective` returns a typed outcome; the
 * host adapter surfaces the commit refusal; the scheduler THROWS a typed
 * conflict/rejection on `{ok:false}` BEFORE any success echo.
 *
 * Two seams:
 *   A. HOST ADAPTER — `applyHostObjectiveMutation` produces the typed negative
 *      from a REAL authority commit refusal (was: discarded → void).
 *   B. SCHEDULER — a `{ok:false}` outcome THROWS (was: silent success echo).
 */

import { describe, expect, test } from "bun:test"
import { applyHostObjectiveMutation } from "@/host/runtime/internal/context-binding"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
  type SessionHost,
} from "@/kernel/session"
import { buildObjectiveMutate, SessionObjectiveConflictError } from "@/protocol/session"
import { buildObjectiveAuthority } from "@/runner/assemble/session-authorities"
import { capabilitiesFor } from "../../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", tools: true, artifacts: true })
const clock = { now: () => new Date("2026-08-22T00:00:00.000Z") }

const baseHost = (over: Partial<SessionHost>): SessionHost => ({
  describe: () => ({ sessionId: "s1", permissionMode: "default", capabilityManifest: manifest }),
  runTurn: async () => ({ outcome: { reason: "completed", turns: 0, messages: [] }, messages: [] }),
  close: async () => undefined,
  ...over,
})

const freshState = () =>
  createKernelSessionState({
    sessionId: "s1",
    permissionMode: "default",
    capabilityManifest: manifest,
  })

// ── A. HOST ADAPTER — the real authority commit refusal becomes a typed negative
describe("M7 · A — applyHostObjectiveMutation surfaces the CAS/policy refusal", () => {
  test("[A1] a STALE-revision mutate returns a typed stale_revision (not a swallowed success)", () => {
    const authority = buildObjectiveAuthority()
    // Seed the objective so the thread's revision advances to 1.
    authority.create("s1", { goal: "ship" })
    // A wire mutate that expected the PRE-set revision 0 is now stale.
    const outcome = applyHostObjectiveMutation(
      { objective: authority, sessionId: "s1" },
      { mutation: { kind: "setExplicitStatus", status: "paused" }, expectedRevision: 0 },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("unreachable")
    expect(outcome.kind).toBe("stale_revision")
    // And the losing mutate did NOT clobber the winner: status is still active.
    expect(authority.get("s1")?.status).toBe("active")
  })

  test("[A2] a fresh commit at the current revision still returns ok (no false negative)", () => {
    const authority = buildObjectiveAuthority()
    authority.create("s1", { goal: "ship" }) // revision → 1
    const outcome = applyHostObjectiveMutation(
      { objective: authority, sessionId: "s1" },
      { mutation: { kind: "setExplicitStatus", status: "paused" }, expectedRevision: 1 },
    )
    expect(outcome.ok).toBe(true)
    expect(authority.get("s1")?.status).toBe("paused")
  })

  test("[A3] absent authority ⇒ benign ok (byte-identical no-op echo)", () => {
    expect(
      applyHostObjectiveMutation({}, { mutation: { kind: "create", definition: { goal: "g" } } }),
    ).toEqual({
      ok: true,
    })
  })
})

// ── B. SCHEDULER — a {ok:false} outcome CONFLICTS instead of falsely succeeding
describe("M7 · B — the kernel scheduler throws on a stale objective mutate", () => {
  test("[B1] host returns stale_revision ⇒ dispatch THROWS SessionObjectiveConflictError", async () => {
    const host = baseHost({
      mutateObjective: () => ({ ok: false, kind: "stale_revision", expected: 0, actual: 1 }),
    })
    const cmd = buildObjectiveMutate(
      { sessionId: "s1", clock },
      { kind: "create", definition: { goal: "g" } },
      {
        expectedObjectiveRevision: 0,
      },
    )
    await expect(
      dispatchSessionCommand(freshState(), cmd, {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host,
      }),
    ).rejects.toBeInstanceOf(SessionObjectiveConflictError)
  })

  test("[B2] end-to-end: a REAL stale authority mutate CONFLICTS (no success echo, no clobber)", async () => {
    const authority = buildObjectiveAuthority()
    authority.create("s1", { goal: "ship" }) // revision → 1
    const host = baseHost({
      mutateObjective: (a) =>
        applyHostObjectiveMutation({ objective: authority, sessionId: "s1" }, a),
    })
    const cmd = buildObjectiveMutate(
      { sessionId: "s1", clock },
      { kind: "setExplicitStatus", status: "paused" },
      { expectedObjectiveRevision: 0 }, // stale
    )
    await expect(
      dispatchSessionCommand(freshState(), cmd, {
        clock,
        eventLog: new InMemorySessionEventLog(),
        host,
      }),
    ).rejects.toBeInstanceOf(SessionObjectiveConflictError)
    // The clobber never happened.
    expect(authority.get("s1")?.status).toBe("active")
  })

  test("[B3] a clean ok outcome still emits the revision echo (no throw regression)", async () => {
    const host = baseHost({ mutateObjective: () => ({ ok: true }) })
    const cmd = buildObjectiveMutate(
      { sessionId: "s1", clock },
      { kind: "create", definition: { goal: "g" } },
      undefined,
    )
    const result = await dispatchSessionCommand(freshState(), cmd, {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host,
    })
    expect(result.events[0]?.type).toBe("session.state.updated")
  })
})
