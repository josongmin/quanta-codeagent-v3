import { describe, expect, test } from "bun:test"
import { createRunLedger } from "@/agent/run-ledger"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import {
  asObjectiveAuthority,
  type BlockerDependencyResolverPort,
  createObjectiveAuthority,
  type ObjectiveAuthority,
} from "@/objective"
import { createRegistryBlockerDependencyResolver } from "@/runner/assemble/session-authorities"
import { TaskRegistry } from "@/subagent"

const beginAttempt = (authority: ObjectiveAuthority, attemptId: string): void => {
  const objective = authority.get("t")
  if (objective === null) throw new Error("objective missing")
  if (objective.attempts.started !== undefined) {
    const abandon = authority.prepare({
      threadId: "t",
      actor: "system",
      mutation: { kind: "abandonAttempt" },
    })
    expect(authority.commit(abandon, { admitted: true }).ok).toBe(true)
  }
  const begin = authority.prepare({
    threadId: "t",
    actor: "system",
    mutation: {
      kind: "beginAttempt",
      attempt: {
        objectiveId: objective.objectiveId,
        attemptId,
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: authority.readDomain("t").revision,
      },
    },
  })
  expect(authority.commit(begin, { admitted: true }).ok).toBe(true)
}

const observe = (
  authority: ObjectiveAuthority,
  input: { ref: string; reason: string; kind?: "tool" | "child-agent" },
) =>
  authority.commit(
    authority.prepare({
      threadId: "t",
      actor: "model",
      mutation: {
        kind: "addBlocker",
        reason: input.reason,
        waitingOn: input.kind === "child-agent" ? "child_agent" : "tool",
        target: { kind: input.kind ?? "tool", ref: input.ref },
      },
    }),
    { admitted: true },
  )

describe("R3 — host registry blocker dependency resolver", () => {
  test("RunLedger identity canonicalizes aliases and rejects unknown, settled, and wrong-thread work", () => {
    const ledger = createRunLedger({ now: () => 11 })
    ledger.start({ id: "build-1", kind: "exec", owner: "t", title: "build" })
    ledger.start({ id: "foreign", kind: "exec", owner: "other", title: "foreign" })
    ledger.start({ id: "done", kind: "exec", owner: "t", title: "done" })
    ledger.settle("done", "completed")
    const resolver = createRegistryBlockerDependencyResolver({ runLedger: () => ledger })

    const exact = resolver.resolve({
      threadId: "t",
      attemptId: "a1",
      waitingOn: "tool",
      target: { kind: "tool", ref: "build-1" },
    })
    const alias = resolver.resolve({
      threadId: "t",
      attemptId: "a1",
      waitingOn: "tool",
      target: { kind: "tool", ref: "run:build-1" },
    })
    expect(exact).toEqual(alias)
    expect(exact).toMatchObject({ kind: "resolved", dependencyId: "run:exec:build-1" })
    for (const [ref, reason] of [
      ["missing", "unknown"],
      ["done", "inactive"],
      ["foreign", "wrong-thread"],
    ] as const) {
      expect(
        resolver.resolve({
          threadId: "t",
          attemptId: "a1",
          waitingOn: "tool",
          target: { kind: "tool", ref },
        }),
      ).toEqual({ kind: "dependency-unresolved", reason })
    }
  })

  test("child-agent resolution requires the same active TaskRegistry and subagent ledger record", () => {
    const tasks = new TaskRegistry()
    tasks.register({ id: "child-1", description: "child", depth: 1 })
    const ledger = createRunLedger({ now: () => 13 })
    ledger.start({ id: "child-1", kind: "subagent", owner: "t", title: "child" })
    const resolver = createRegistryBlockerDependencyResolver({
      runLedger: () => ledger,
      tasks: () => tasks,
    })
    expect(
      resolver.resolve({
        threadId: "t",
        attemptId: "a1",
        waitingOn: "child_agent",
        target: { kind: "child-agent", ref: "task:child-1" },
      }),
    ).toMatchObject({ kind: "resolved", dependencyId: "task:child-1" })
    ledger.settle("child-1", "completed")
    expect(
      resolver.resolve({
        threadId: "t",
        attemptId: "a2",
        waitingOn: "child_agent",
        target: { kind: "child-agent", ref: "child-1" },
      }),
    ).toEqual({ kind: "dependency-unresolved", reason: "inactive" })
  })

  test("same registry dependency with different reason/ref promotes once by dependencyId", () => {
    const ledger = createRunLedger({ now: () => 17 })
    ledger.start({ id: "build-1", kind: "exec", owner: "t", title: "build" })
    const authority = createObjectiveAuthority({
      blockerDependencyResolver: createRegistryBlockerDependencyResolver({
        runLedger: () => ledger,
      }),
    })
    authority.create("t", { goal: "ship" })
    const observations = [
      { ref: "build-1", reason: "build still running" },
      { ref: "run:build-1", reason: "different display copy" },
      { ref: "build-1", reason: "third display copy" },
    ]
    observations.forEach((input, index) => {
      beginAttempt(authority, `a${index + 1}`)
      expect(observe(authority, input).ok).toBe(true)
    })
    expect(authority.get("t")?.blockers).toHaveLength(1)
    expect(authority.get("t")?.blockers[0]).toMatchObject({
      dependencyId: "run:exec:build-1",
      reason: "third display copy",
    })
  })

  test("same reason on distinct registry dependencies promotes two blockers", () => {
    const ledger = createRunLedger({ now: () => 19 })
    for (const id of ["one", "two"]) {
      ledger.start({ id, kind: "exec", owner: "t", title: id })
    }
    const authority = createObjectiveAuthority({
      blockerDependencyResolver: createRegistryBlockerDependencyResolver({
        runLedger: () => ledger,
      }),
    })
    authority.create("t", { goal: "ship" })
    for (const attemptId of ["a1", "a2", "a3"]) {
      beginAttempt(authority, attemptId)
      expect(observe(authority, { ref: "one", reason: "same" }).ok).toBe(true)
      expect(observe(authority, { ref: "two", reason: "same" }).ok).toBe(true)
    }
    expect(
      authority
        .get("t")
        ?.blockers.map((item) => item.dependencyId)
        .sort(),
    ).toEqual(["run:exec:one", "run:exec:two"])
  })

  test("same occurrence evidence replayed in another attempt does not advance hysteresis", () => {
    const resolver: BlockerDependencyResolverPort = {
      resolve: () => ({
        kind: "resolved",
        dependencyId: "run:exec:one",
        occurrenceEvidenceId: "same-occurrence",
      }),
    }
    const authority = createObjectiveAuthority({ blockerDependencyResolver: resolver })
    authority.create("t", { goal: "ship" })
    beginAttempt(authority, "a1")
    expect(observe(authority, { ref: "one", reason: "same" }).ok).toBe(true)
    beginAttempt(authority, "a2")
    expect(observe(authority, { ref: "one", reason: "same" })).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    expect(authority.get("t")?.blockerObservations[0]?.occurrences).toHaveLength(1)
  })

  test("approval, user-input, and external model targets are typed unresolved", () => {
    const ledger = createRunLedger()
    const authority = createObjectiveAuthority({
      blockerDependencyResolver: createRegistryBlockerDependencyResolver({
        runLedger: () => ledger,
      }),
    })
    authority.create("t", { goal: "ship" })
    beginAttempt(authority, "a1")
    for (const kind of ["approval", "user-input", "external"] as const) {
      const result = authority.commit(
        authority.prepare({
          threadId: "t",
          actor: "model",
          mutation: {
            kind: "addBlocker",
            reason: "model cannot own this dependency",
            waitingOn: kind === "external" ? "network" : "user",
            target: { kind, ref: "candidate" },
          },
        }),
        { admitted: true },
      )
      expect(result).toMatchObject({ ok: false, reason: "dependency-unresolved" })
    }
    expect(authority.get("t")?.blockerObservations).toEqual([])
  })

  test("production gated authority reads a lazily-bound canonical RunLedger", () => {
    let ledger: ReturnType<typeof createRunLedger> | undefined
    const port = resolveGatedObjectiveAuthority(
      { QUANTA_OBJECTIVE_TOOLS: "1" },
      {
        confirmationAvailable: true,
        runLedger: () => ledger,
      },
    )
    if (port === undefined) throw new Error("objective authority missing")
    const authority = asObjectiveAuthority(port)
    authority.create("t", { goal: "ship" })
    beginAttempt(authority, "a1")
    expect(observe(authority, { ref: "late", reason: "not bound" })).toMatchObject({
      ok: false,
      reason: "dependency-unresolved",
    })

    ledger = createRunLedger({ now: () => 23 })
    ledger.start({ id: "late", kind: "exec", owner: "t", title: "late-bound" })
    expect(observe(authority, { ref: "late", reason: "bound" }).ok).toBe(true)
    expect(authority.get("t")?.blockerObservations[0]?.dependencyId).toBe("run:exec:late")
  })
})
