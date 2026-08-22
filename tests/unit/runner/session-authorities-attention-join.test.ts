/**
 * RFC-01 A2 — session-authorities question/attention join (composition RED).
 *
 * A2 wires A1's PURE `@/attention` resolver + the `@/session/user-question`
 * `UserQuestionBroker` into the session-authority graph so a LIVE fleet-attention
 * view can be resolved from the real `TaskRegistry` + broker. A2 adds NO new
 * state (the resolver stays pure; the reader derives its snapshot from the live
 * authorities each call) and NO parallel authority (the injected registry is the
 * one the graph carries).
 *
 * Hellgate rails pinned here:
 *   1. LIVE JOIN — with the gate ON, a task-owned pending question is joined
 *      with its live `TaskRecord` (id/label/lineage rootId) and resolved via the
 *      A1 pure resolver. This is the non-vacuous composition RED for the
 *      FOUNDATION packet (board §2).
 *   2. DEFAULT-OFF CONSTRUCTOR PARITY — gate unset ⇒ the graph is byte-identical
 *      to the baseline `{ tasks }`: no `questions`, no `attention`, and the SAME
 *      registry instance (no parallel/duplicate authority). Red-on-injection: a
 *      broker constructed on the OFF path flips this RED.
 *   3. LINEAGE GATE — a foreign-lineage awaiting task is NEVER selected, even
 *      when it is the globally oldest (jul-15 sibling-leak class).
 *   4. ANTI-VACUUM ORDERING — MIXED fixture (own-old + own-new awaiting, own
 *      non-awaiting, foreign-oldest awaiting) makes both lineage AND oldest-first
 *      ordering load-bearing.
 *   5. ROOT-OWNED EXCLUSION — a `{ kind: "root" }` question is a session-level
 *      question, not a subagent fleet row, so it never enters the snapshot.
 */

import { describe, expect, test } from "bun:test"
import {
  buildSessionAuthorities,
  type SessionAuthorities,
} from "@/runner/assemble/session-authorities"
import { createUserQuestionBroker, type UserQuestionBroker } from "@/session/user-question"
import { TaskRegistry } from "@/subagent"

/** Deterministic broker: counter clock + counter ids so `askedAt`/`requestId`
 *  ordering is stable and oldest-first is observable. */
const deterministicBroker = (): UserQuestionBroker => {
  let clock = 0
  let seq = 0
  return createUserQuestionBroker({ now: () => ++clock, mintId: () => `q${seq++}` })
}

/** Register a task record (explicit id + lineage edge) and return its id. */
const registerTask = (
  reg: TaskRegistry,
  id: string,
  description: string,
  parentTaskId?: string,
  mailboxLabel?: string,
): string => {
  reg.register({
    id,
    description,
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    ...(mailboxLabel !== undefined ? { mailboxLabel } : {}),
  })
  return id
}

const ON = { QUANTA_ATTENTION_NAV: "1" } as const

describe("RFC-01 A2 — session-authorities question/attention join", () => {
  test("1. LIVE JOIN: task-owned question resolves a real fleet row via the pure resolver", () => {
    const tasks = new TaskRegistry()
    // Lineage: root R -> child C. ownRootId scope = R.
    registerTask(tasks, "R", "root task")
    registerTask(tasks, "C", "child task", "R", "root/0")
    const questions = deterministicBroker()

    const auth = buildSessionAuthorities({ tasks, env: ON, questions })
    expect(auth.attention).toBeDefined()
    expect(auth.questions).toBe(questions)

    // A real question emitted for child C (fire-and-forget; published sync).
    void questions.request({ owner: { kind: "task", taskId: "C" }, prompt: "which file?" })

    const snap = auth.attention!.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({
      id: "C",
      label: "root/0", // mailboxLabel preferred over description
      rootId: "R", // derived by walking the parentTaskId chain
      pendingQuestion: { requestId: "q0", askedAt: 1, summary: "which file?" },
    })

    const pick = auth.attention!.next("R")
    expect(pick?.id).toBe("C")
    expect(pick?.pendingQuestion?.requestId).toBe("q0")

    questions.cancelAll("teardown")
  })

  test("2. DEFAULT-OFF: gate unset ⇒ baseline graph (no question/attention authority; store always present)", () => {
    const tasks = new TaskRegistry()
    const off: SessionAuthorities = buildSessionAuthorities({ tasks, env: {} })

    // Same registry instance — no parallel/duplicate authority.
    expect(off.tasks).toBe(tasks)
    // No attention/question authority is constructed on the OFF path.
    expect(off.questions).toBeUndefined()
    expect(off.attention).toBeUndefined()
    // RFC-04 D4 — the ONE session activity store is ALWAYS present (not gated),
    // so the OFF-path graph carries exactly {activity, tasks} and nothing else.
    expect(off.activity).toBeDefined()
    expect(Object.keys(off).sort()).toEqual(["activity", "tasks"])
    expect(off).toEqual({ activity: off.activity, tasks })
  })

  test("3. LINEAGE GATE: a foreign-lineage awaiting task is never selected", () => {
    const tasks = new TaskRegistry()
    registerTask(tasks, "R", "own root")
    registerTask(tasks, "C", "own child", "R")
    registerTask(tasks, "S", "sibling root") // different lineage entirely
    const questions = deterministicBroker()
    const auth = buildSessionAuthorities({ tasks, env: ON, questions })

    // Foreign (S) asks FIRST (globally oldest); own (C) asks later.
    void questions.request({ owner: { kind: "task", taskId: "S" }, prompt: "foreign?" })
    void questions.request({ owner: { kind: "task", taskId: "C" }, prompt: "own?" })

    const pick = auth.attention!.next("R")
    // Despite S being globally oldest, lineage gate forces C (rootId === R).
    expect(pick?.id).toBe("C")
    expect(pick?.rootId).toBe("R")
    // And S is never selectable from R's scope (after C ⇒ nothing else in lineage).
    expect(auth.attention!.next("R", "q1")).toBeUndefined()

    questions.cancelAll("teardown")
  })

  test("4. ANTI-VACUUM: mixed fixture — oldest-first within own lineage, ignores foreign & idle", () => {
    const tasks = new TaskRegistry()
    registerTask(tasks, "R", "own root")
    registerTask(tasks, "C1", "own child 1", "R")
    registerTask(tasks, "C2", "own child 2", "R")
    registerTask(tasks, "Cidle", "own child idle", "R") // never asks
    registerTask(tasks, "S", "sibling root")
    const questions = deterministicBroker()
    const auth = buildSessionAuthorities({ tasks, env: ON, questions })

    void questions.request({ owner: { kind: "task", taskId: "S" }, prompt: "foreign oldest" }) // q0 askedAt1
    void questions.request({ owner: { kind: "task", taskId: "C2" }, prompt: "own newer" }) // q1 askedAt2
    void questions.request({ owner: { kind: "task", taskId: "C1" }, prompt: "own older" }) // q2 askedAt3

    // Snapshot carries only task rows that are actually pending & joinable.
    const snap = auth.attention!.snapshot()
    expect(snap.map((a) => a.id).sort()).toEqual(["C1", "C2", "S"]) // Cidle absent

    // Within R's lineage, oldest-first ⇒ C2 (askedAt2) before C1 (askedAt3).
    expect(auth.attention!.next("R")?.id).toBe("C2")
    // Cursor advance: after C2 ⇒ C1; after C1 ⇒ nothing.
    expect(auth.attention!.next("R", "q1")?.id).toBe("C1")
    expect(auth.attention!.next("R", "q2")).toBeUndefined()

    questions.cancelAll("teardown")
  })

  test("5. ROOT-OWNED question is a session-level question, never a fleet row", () => {
    const tasks = new TaskRegistry()
    registerTask(tasks, "R", "own root")
    const questions = deterministicBroker()
    const auth = buildSessionAuthorities({ tasks, env: ON, questions })

    void questions.request({ owner: { kind: "root" }, prompt: "root-level question" })

    expect(auth.attention!.snapshot()).toHaveLength(0)
    expect(auth.attention!.next("R")).toBeUndefined()

    questions.cancelAll("teardown")
  })

  test("6. UNKNOWN task binding (settled/unregistered) never fabricates a row", () => {
    const tasks = new TaskRegistry()
    registerTask(tasks, "R", "own root")
    const questions = deterministicBroker()
    const auth = buildSessionAuthorities({ tasks, env: ON, questions })

    void questions.request({ owner: { kind: "task", taskId: "ghost" }, prompt: "no such task" })

    expect(auth.attention!.snapshot()).toHaveLength(0)

    questions.cancelAll("teardown")
  })
})
