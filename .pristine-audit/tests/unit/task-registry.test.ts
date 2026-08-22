import { describe, expect, test } from "bun:test"
import { type SubagentResult, TaskRegistry } from "../../src/subagent"

/**
 * Unit tests for `TaskRegistry` — event-driven settle notifier + uuid id
 * generation + abort-controller wiring. These tests assert the SHAPE of the
 * registry's per-task lifecycle: register ⇒ running, complete/fail/stop flip
 * status atomically AND resolve `waitForSettle`, and `stop` aborts the
 * registered AbortController (proving `task_stop` can unwind a runner that
 * listens on the per-task signal).
 */

const okResult = (over: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText: "done",
  turns: 1,
  ...over,
})

/** Probe whether a Promise is already settled within a small number of
 *  micro-task turns. Returns `pLabel` if it is, `tLabel` if it stays pending.
 *
 *  W1-D / W2 audit fix: the previous implementation raced `p` against
 *  `setTimeout(timerMs)` with `timerMs=5`, which is sensitive to GC pause
 *  and CI load — a slow box could fire the 5ms timer before a genuinely-
 *  settled Promise's `.then` callback ran, producing spurious results.
 *  Draining 4 micro-task turns deterministically lets any synchronous
 *  resolution observable propagate; if `p` is genuinely pending (e.g.
 *  awaiting an external event), it stays unresolved across 4 turns and we
 *  return `tLabel`. The `timerMs` parameter is preserved for call-site
 *  source-compat but is no longer wall-clock — it documents intent only.
 */
const raceAgainst = async (
  p: Promise<unknown>,
  _timerMs: number,
  pLabel = "settled",
  tLabel = "timer",
): Promise<string> => {
  let settled = false
  void p.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  // Drain 4 micro-task turns — settle observables propagate via .then, which
  // queues a micro-task. 4 turns is overkill for a single .then chain but
  // guards against nested `Promise.resolve().then(...).then(...)` settle paths.
  for (let i = 0; i < 4; i++) await Promise.resolve()
  return settled ? pLabel : tLabel
}

describe("TaskRegistry — newId", () => {
  test("produces distinct ids on rapid successive calls (≥100 unique)", () => {
    const reg = new TaskRegistry()
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) ids.add(reg.newId())
    expect(ids.size).toBe(200)
    // Shape: task_<uuid> — keep log lines greppable.
    for (const id of ids) expect(id.startsWith("task_")).toBe(true)
  })
})

describe("TaskRegistry — waitForSettle (event-driven)", () => {
  test("unknown id resolves immediately (no listener registered)", async () => {
    const reg = new TaskRegistry()
    const winner = await raceAgainst(reg.waitForSettle("task_nope"), 5)
    expect(winner).toBe("settled")
  })

  test("already-completed task resolves immediately", async () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    reg.complete(id, okResult())
    const winner = await raceAgainst(reg.waitForSettle(id), 5)
    expect(winner).toBe("settled")
  })

  test("already-failed task resolves immediately", async () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    reg.fail(id, "boom")
    const winner = await raceAgainst(reg.waitForSettle(id), 5)
    expect(winner).toBe("settled")
  })

  test("already-stopped task resolves immediately", async () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    reg.forceStop(id)
    const winner = await raceAgainst(reg.waitForSettle(id), 5)
    expect(winner).toBe("settled")
  })

  test("running task blocks; complete() unblocks the settle promise", async () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })

    // Before complete: settle must lose to a 5ms timer (no busy poll, but it
    // is still genuinely pending — the timer wins because the settler is
    // unresolved).
    const stillBlocked = await raceAgainst(reg.waitForSettle(id), 5)
    expect(stillBlocked).toBe("timer")

    // Now arm a fresh waitForSettle, then complete — it must win the race
    // immediately (microtask), beating even a 5ms timer.
    const settle = reg.waitForSettle(id)
    reg.complete(id, okResult())
    const winner = await raceAgainst(settle, 5)
    expect(winner).toBe("settled")
  })

  test("running task: fail() unblocks the settle promise", async () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    const settle = reg.waitForSettle(id)
    reg.fail(id, "kaboom")
    const winner = await raceAgainst(settle, 5)
    expect(winner).toBe("settled")
  })

  test("running task: stop() unblocks the settle promise", async () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    const settle = reg.waitForSettle(id)
    reg.forceStop(id)
    const winner = await raceAgainst(settle, 5)
    expect(winner).toBe("settled")
  })
})

describe("TaskRegistry — stop aborts the registered controller", () => {
  test("subscribers to the registered signal observe the abort", () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    const { abort: ac } = reg.register({ id, description: "x" })
    let aborted = false
    ac.signal.addEventListener("abort", () => {
      aborted = true
    })
    expect(ac.signal.aborted).toBe(false)
    const ok = reg.forceStop(id)
    expect(ok).toBe(true)
    expect(aborted).toBe(true)
    expect(ac.signal.aborted).toBe(true)
  })
})

describe("TaskRegistry — settled tasks are immutable", () => {
  test("complete() on a completed task is a no-op", () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    reg.complete(id, okResult({ finalText: "first" }))
    const firstEndedAt = reg.get(id)?.endedAt
    reg.complete(id, okResult({ finalText: "second" }))
    const rec = reg.get(id)
    expect(rec?.status).toBe("completed")
    expect(rec?.result?.finalText).toBe("first")
    expect(rec?.endedAt).toBe(firstEndedAt)
  })

  test("fail() on a settled task is a no-op", () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    reg.register({ id, description: "x" })
    reg.complete(id, okResult())
    reg.fail(id, "should not stick")
    const rec = reg.get(id)
    expect(rec?.status).toBe("completed")
    expect(rec?.error).toBeUndefined()
  })

  test("stop() on a settled task returns false and does NOT abort retroactively", () => {
    const reg = new TaskRegistry()
    const id = reg.newId()
    const { abort: ac } = reg.register({ id, description: "x" })
    reg.complete(id, okResult())
    // After complete, the registry forgets the controller, so stop() must be
    // a clean no-op (no double-abort, no status change).
    const ret = reg.forceStop(id)
    expect(ret).toBe(false)
    expect(reg.get(id)?.status).toBe("completed")
    // Controller was never aborted (complete doesn't abort, only stop does).
    expect(ac.signal.aborted).toBe(false)
  })

  test("stop() on an unknown id returns false", () => {
    const reg = new TaskRegistry()
    expect(reg.forceStop("task_does_not_exist")).toBe(false)
  })
})

describe("TaskRegistry — trackRunner / drainRunners (deterministic teardown)", () => {
  test("drainRunners() with nothing tracked resolves immediately", async () => {
    const reg = new TaskRegistry()
    const winner = await raceAgainst(reg.drainRunners(), 5)
    expect(winner).toBe("settled")
  })

  test("drainRunners() AWAITS a runner promise that is still in flight", async () => {
    // RED-ON-INJECTION: this is the exact gap the fix closes. `forceStop`
    // resolves the settler synchronously, so a session that only awaits
    // `waitForSettle` returns while the runner promise is still unwinding.
    // `drainRunners` must NOT resolve until the tracked runner promise settles.
    const reg = new TaskRegistry()
    let release!: () => void
    const runner = new Promise<void>((r) => {
      release = r
    })
    reg.trackRunner(runner)

    // Drain must still be pending while the runner is in flight.
    const pending = await raceAgainst(reg.drainRunners(), 5)
    expect(pending).toBe("timer")

    // Once the runner settles, a fresh drain resolves.
    release()
    const done = await raceAgainst(reg.drainRunners(), 5)
    expect(done).toBe("settled")
  })

  test("a tracked runner that REJECTS does not surface an unhandledRejection and drain still resolves", async () => {
    const reg = new TaskRegistry()
    const seen: unknown[] = []
    const onRej = (e: unknown): void => {
      seen.push(e)
    }
    process.on("unhandledRejection", onRej)
    try {
      reg.trackRunner(Promise.reject(new Error("child blew up")))
      // drain awaits the rejection-swallowed marker — resolves, never throws.
      await reg.drainRunners()
      // Let any would-be unhandledRejection fire across a few micro/macro turns.
      for (let i = 0; i < 4; i++) await Promise.resolve()
      await new Promise<void>((r) => setTimeout(r, 0))
      expect(seen).toEqual([])
    } finally {
      process.off("unhandledRejection", onRej)
    }
  })

  test("settled tracked runners self-trim from the set (drain stays bounded)", async () => {
    const reg = new TaskRegistry()
    reg.trackRunner(Promise.resolve())
    // After the marker settles, a subsequent drain takes the empty fast path.
    for (let i = 0; i < 4; i++) await Promise.resolve()
    const winner = await raceAgainst(reg.drainRunners(), 5)
    expect(winner).toBe("settled")
  })
})
