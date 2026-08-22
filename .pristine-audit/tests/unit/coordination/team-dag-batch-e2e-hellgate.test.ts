/**
 * Hellgate (e2e) — Capability A DAG wiring over the REAL `runBatch` pool.
 *
 * Drives the EXACT composition the tier1 builder produces when `QUANTA_TEAM_DAG`
 * is on: `wrapRunnerWithDagGate(runner, gate, idOf)` handed to the unmodified
 * `runBatch`. A fake spawn captures dispatch ORDER. Asserts:
 *   - knob-ON: linear chain dispatches in dependency order.
 *   - knob-ON: diamond — D dispatches only AFTER both B and C.
 *   - knob-ON: a failed dep ⇒ its dependent is NOT dispatched (dead branch,
 *     no hang) and reports the typed blocked result.
 *   - knob-OFF (plain runner): flat fan-out — all dispatched, NO ordering
 *     constraint = byte-identical to today's batch.
 *
 * No LLM, no disk, no real timers — `runBatch` gets an injected clock + the
 * gated runner; the gate is pure promise plumbing.
 */
import { describe, expect, test } from "bun:test"
import {
  createDagGate,
  DAG_BLOCKED_TEXT,
  type DagRunner,
  type TaskNode,
  wrapRunnerWithDagGate,
} from "../../../src/subagent/coordination"
import {
  type BatchSubagentRunner,
  DEFAULT_BATCH_TIMEOUT_POLICY,
  runBatch,
} from "../../../src/tool/subagent-batch"

const node = (id: string, dependsOn: readonly string[] = []): TaskNode => ({
  id,
  dependsOn,
  state: "pending",
})

/** A controllable fake child: records dispatch order; each id resolves when its
 *  matching `release(id)` is called (so we can interleave deterministically). */
const makeControllableRunner = (): {
  runner: DagRunner
  dispatched: string[]
  release: (id: string, ok?: boolean) => void
} => {
  const dispatched: string[] = []
  const pending = new Map<string, (r: { ok: boolean }) => void>()
  const runner: DagRunner = (req) => {
    const id = req.prompt // prompt IS the id in this fake
    dispatched.push(id)
    return new Promise((resolve) => {
      pending.set(id, ({ ok }) => resolve({ ok, finalText: `R:${id}`, turns: 1 }))
    })
  }
  const release = (id: string, ok = true): void => {
    const r = pending.get(id)
    if (r) {
      pending.delete(id)
      r({ ok })
    }
  }
  return { runner, dispatched, release }
}

const runArgs = (ids: readonly string[]) => ({
  items: ids.map((id) => id),
  promptTemplate: "{{item}}",
})

const deps = (runner: BatchSubagentRunner) => ({
  runner,
  clock: () => 0,
  maxItems: 256,
  schedulerCap: 8, // ample — DAG ordering, not the semaphore, must serialize
  timeoutPolicy: DEFAULT_BATCH_TIMEOUT_POLICY,
})

const noSignal = new AbortController().signal
const tick = () => new Promise((r) => setTimeout(r, 0))

describe("DAG batch e2e — knob ON (gated runner)", () => {
  test("linear chain A→B→C dispatches in dependency order", async () => {
    const { runner, dispatched, release } = makeControllableRunner()
    const made = createDagGate([node("a"), node("b", ["a"]), node("c", ["b"])])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const gated = wrapRunnerWithDagGate(runner, made.gate, (req) => req.prompt)

    const run = runBatch(runArgs(["a", "b", "c"]), deps(gated), noSignal)
    // Only A is ready initially.
    await tick()
    expect(dispatched).toEqual(["a"])
    release("a")
    await tick()
    expect(dispatched).toEqual(["a", "b"])
    release("b")
    await tick()
    expect(dispatched).toEqual(["a", "b", "c"])
    release("c")

    const result = await run
    expect(result.summary).toMatchObject({ total: 3, ok: 3, failed: 0 })
  })

  test("diamond A→{B,C}→D: D dispatches only after BOTH B and C complete", async () => {
    const { runner, dispatched, release } = makeControllableRunner()
    const made = createDagGate([
      node("a"),
      node("b", ["a"]),
      node("c", ["a"]),
      node("d", ["b", "c"]),
    ])
    if (!made.ok) throw new Error("expected valid gate")
    const gated = wrapRunnerWithDagGate(runner, made.gate, (req) => req.prompt)

    const run = runBatch(runArgs(["a", "b", "c", "d"]), deps(gated), noSignal)
    await tick()
    expect(dispatched).toEqual(["a"])
    release("a")
    await tick()
    // B and C both released; D still waiting.
    expect([...dispatched].sort()).toEqual(["a", "b", "c"])
    expect(dispatched).not.toContain("d")
    release("b")
    await tick()
    expect(dispatched).not.toContain("d") // C still pending
    release("c")
    await tick()
    expect(dispatched).toContain("d")
    release("d")

    const result = await run
    expect(result.summary).toMatchObject({ total: 4, ok: 4, failed: 0 })
  })

  test("failed dep ⇒ dependent is NOT dispatched (dead branch, no hang)", async () => {
    const { runner, dispatched, release } = makeControllableRunner()
    const made = createDagGate([node("a"), node("b", ["a"])])
    if (!made.ok) throw new Error("expected valid gate")
    const gated = wrapRunnerWithDagGate(runner, made.gate, (req) => req.prompt)

    const run = runBatch(runArgs(["a", "b"]), deps(gated), noSignal)
    await tick()
    expect(dispatched).toEqual(["a"])
    release("a", false) // A FAILS

    const result = await run // MUST settle — no hang
    expect(dispatched).toEqual(["a"]) // B never dispatched
    // Item "b" is at input index 1 (string items ⇒ id = String(index)).
    const b = result.items[1]
    expect(b?.status).toBe("error")
    expect(b?.error).toContain(DAG_BLOCKED_TEXT)
    expect(result.summary).toMatchObject({ total: 2, ok: 0, failed: 2 })
  })

  test("cyclic graph is rejected at gate construction (never dispatched)", () => {
    const made = createDagGate([node("a", ["b"]), node("b", ["a"])])
    expect(made.ok).toBe(false)
    if (!made.ok) {
      expect(made.reason).toBe("cycle")
      expect(made.cycle.length).toBeGreaterThan(0)
    }
  })

  // Audit #7 (gate contract completeness): a DIRECT markFailed(X) on a node that
  // has its OWN pending waiter must resolve that waiter "blocked" — `blockedTasks`
  // only returns PENDING nodes, so without the directly-dead check in `flush`
  // this waiter would hang forever. (Not reachable in the live consumers, which
  // always resolve awaitReady(id) BEFORE marking that same id — a contract lock.)
  test("gate: direct markFailed(X) resolves X's OWN pending waiter as blocked (no hang)", async () => {
    const made = createDagGate([node("dep"), node("x", ["dep"])])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    // x is pending with an incomplete dep ⇒ not ready, not blocked ⇒ waiter parks.
    const waiting = made.gate.awaitReady("x")
    made.gate.markFailed("x") // fail x ITSELF (not its dep)
    expect(await waiting).toBe("blocked")
  })

  test("gate: direct markFailed(X, 'cancelled') also resolves X's own waiter blocked", async () => {
    const made = createDagGate([node("dep"), node("x", ["dep"])])
    if (!made.ok) throw new Error("gate construction failed")
    const waiting = made.gate.awaitReady("x")
    made.gate.markFailed("x", "cancelled")
    expect(await waiting).toBe("blocked")
  })

  // ADV deadlock (liveness §5): a deep chain where the ROOT fails must resolve
  // EVERY transitively-dependent waiter "blocked" in ONE flush — none may hang.
  // This is the "all-blocked" adversarial graph: B→A, C→B, D→C, with A failing.
  // A regression in the `blockedTasks` fixpoint (e.g. a single-hop-only check)
  // would leave C/D parked forever while their pool slot is freed but never
  // settled — a silent batch hang.
  test("gate: a deep chain whose ROOT fails resolves ALL transitive waiters blocked (no hang)", async () => {
    const made = createDagGate([node("A"), node("B", ["A"]), node("C", ["B"]), node("D", ["C"])])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const g = made.gate
    const waiters = Promise.all([g.awaitReady("B"), g.awaitReady("C"), g.awaitReady("D")])
    g.markFailed("A") // root dies — the whole branch is dead
    expect(await waiters).toEqual(["blocked", "blocked", "blocked"])
  })

  // ADV deadlock: a fan-in node whose deps complete OUT OF ORDER and where one
  // dep is touched LATE must only resolve "ready" once EVERY dep is completed —
  // never a premature ready (which would dispatch a child before its input).
  test("gate: fan-in waiter resolves ready ONLY after the LAST dep completes (no premature dispatch)", async () => {
    const made = createDagGate([
      { id: "A", dependsOn: [], state: "completed" }, // already done at init
      node("B"),
      node("D", ["A", "B"]),
    ])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const g = made.gate
    let outcome: string | undefined
    void g.awaitReady("D").then((o) => {
      outcome = o
    })
    await tick()
    expect(outcome).toBeUndefined() // B not done ⇒ D must keep waiting
    g.markComplete("B")
    await tick()
    expect(outcome).toBe("ready") // now BOTH deps complete ⇒ D releases
  })
})

describe("DAG batch e2e — knob OFF (plain runner = byte-identical flat fan-out)", () => {
  test("all items dispatch immediately with NO ordering constraint", async () => {
    const { runner, dispatched, release } = makeControllableRunner()
    // OFF path: the builder hands runBatch the RAW runner (no gate wrap).
    const plain: BatchSubagentRunner = runner

    const run = runBatch(runArgs(["a", "b", "c", "d"]), deps(plain), noSignal)
    await tick()
    // Flat: every item is in flight at once — no DAG serialization.
    expect([...dispatched].sort()).toEqual(["a", "b", "c", "d"])
    for (const id of ["a", "b", "c", "d"]) release(id)

    const result = await run
    expect(result.summary).toMatchObject({ total: 4, ok: 4, failed: 0 })
    // Per-item array stays input-INDEX ordered (existing slice invariant) —
    // string items derive id = String(index), independent of completion order.
    expect(result.items.map((i) => i.index)).toEqual([0, 1, 2, 3])
  })
})
