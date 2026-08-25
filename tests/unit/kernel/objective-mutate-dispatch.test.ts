/**
 * RFC-03 C3 — kernel dispatch of `session.objective.mutate`.
 *
 * The objective DOMAIN state is host-owned (the authority), so the kernel's job
 * is a projection: bump the session revision, emit ONE `session.state.updated`
 * echo, and route the mutation to `host.mutateObjective` (which applies it under
 * CAS). Pins:
 *   - the reducer emits exactly the revision-bump echo (no host-turn, no
 *     approval events);
 *   - the scheduler calls `host.mutateObjective` with the mutation +
 *     expectedRevision;
 *   - CAS: two mutates at one objective revision through the SAME authority yield
 *     exactly one commit and one stale (the host binds actor `user`).
 */
import { describe, expect, test } from "bun:test"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  InMemorySessionEventLog,
  type SessionHost,
} from "@/kernel/session"
import { buildObjectiveMutate } from "@/protocol/session"
import { capabilitiesFor } from "../../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", tools: true, artifacts: true })

const clock = { now: () => new Date("2026-08-22T00:00:00.000Z") }

const baseHost = (over: Partial<SessionHost>): SessionHost => ({
  describe: () => ({ sessionId: "s1", permissionMode: "default", capabilityManifest: manifest }),
  runTurn: async () => ({ outcome: { reason: "completed", turns: 0, messages: [] }, messages: [] }),
  close: async () => undefined,
  ...over,
})

describe("session.objective.mutate — kernel dispatch", () => {
  test("reducer emits one revision-bump state echo and routes to host.mutateObjective", async () => {
    const state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const seen: Array<{ mutation: unknown; expectedRevision?: number }> = []
    const host = baseHost({
      mutateObjective: (args) => {
        seen.push(args)
        return { ok: true }
      },
    })
    const cmd = buildObjectiveMutate(
      { sessionId: "s1", clock },
      { kind: "create", definition: { goal: "g" } },
      undefined,
    )
    const result = await dispatchSessionCommand(state, cmd, {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host,
    })
    // one echo, revision advanced by 1
    expect(result.events.length).toBe(1)
    expect(result.events[0]?.type).toBe("session.state.updated")
    expect(result.state.revision).toBe(state.revision + 1)
    // routed to the host with the mutation
    expect(seen.length).toBe(1)
    expect(seen[0]?.mutation).toEqual({ kind: "create", definition: { goal: "g" } })
  })

  test("scheduler forwards expectedRevision as the CAS target", async () => {
    const state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    let seenRev: number | undefined = -1
    const host = baseHost({
      mutateObjective: ({ expectedRevision }) => {
        seenRev = expectedRevision
        return { ok: true }
      },
    })
    const cmd = buildObjectiveMutate(
      { sessionId: "s1", clock },
      { kind: "create", definition: { goal: "g" } },
      {
        expectedObjectiveRevision: 7,
      },
    )
    await dispatchSessionCommand(state, cmd, {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host,
    })
    expect(seenRev).toBe(7)
  })

  test("absent host.mutateObjective ⇒ the reducer still echoes (no throw)", async () => {
    const state = createKernelSessionState({
      sessionId: "s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const cmd = buildObjectiveMutate(
      { sessionId: "s1", clock },
      { kind: "create", definition: { goal: "g" } },
      undefined,
    )
    const result = await dispatchSessionCommand(state, cmd, {
      clock,
      eventLog: new InMemorySessionEventLog(),
      host: baseHost({}),
    })
    expect(result.events[0]?.type).toBe("session.state.updated")
  })
})
