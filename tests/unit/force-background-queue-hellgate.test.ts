/**
 * force_background — Phase 1 (admission queue) hellgate (ADR-0487).
 *
 * Seals the opt-in `queued` admission state: default-OFF byte-identity,
 * queue admission, FIFO auto-drain, queue boundedness, cancel-a-queued, and
 * serialize/hydrate "lost across restart". All in-memory; injected fake
 * runner + pinned now/idGen/maxConcurrent (closed-port seams).
 */

import { describe, expect, test } from "bun:test"
import {
  defaultBackgroundSubagentScheduler,
  SubagentBackgroundError,
} from "@/agent/subagent-background"
import type { SubagentResult as SliceResult, SubagentRequest, SubagentRunner } from "@/subagent"

/** A runner that captures EVERY request and lets the test resolve each by
 *  insertion order. `tasks` records the spec.prompt of every started run so a
 *  test can assert WHICH specs the runner actually saw (queued specs never
 *  reach it until promoted). */
const multiRunner = (): {
  runner: SubagentRunner
  resolveNext: (out?: Partial<SliceResult>) => boolean
  startedTasks: () => string[]
  pending: () => number
} => {
  const resolvers: Array<{ prompt: string; res: (out: SliceResult) => void }> = []
  const started: string[] = []
  let head = 0
  const runner: SubagentRunner = (req: SubagentRequest) => {
    started.push(req.prompt)
    return new Promise<SliceResult>((res) => {
      resolvers.push({ prompt: req.prompt, res })
    })
  }
  return {
    runner,
    resolveNext: (out) => {
      if (head >= resolvers.length) return false
      const r = resolvers[head]
      if (r === undefined) return false
      head += 1
      r.res({ ok: true, finalText: out?.finalText ?? "done", turns: out?.turns ?? 1 })
      return true
    },
    startedTasks: () => [...started],
    pending: () => resolvers.length - head,
  }
}

const yieldMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let seq = 0
const idGen = (): string => {
  seq += 1
  return seq.toString(16).padStart(4, "0")
}
const fixedNow = (): number => 1_000

describe("force_background Phase 1 — A. default-OFF byte-identity", () => {
  test("HELL-1: queue absent ⇒ 4th fork over cap THROWS cap-exceeded; no queued status", () => {
    const { runner } = multiRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 3, idGen })
    sched.fork({ task: "a" })
    sched.fork({ task: "b" })
    sched.fork({ task: "c" })
    let caught: unknown = null
    try {
      sched.fork({ task: "d" })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SubagentBackgroundError)
    expect((caught as SubagentBackgroundError).code).toBe("cap-exceeded")
    // No queued entry can exist on the default path.
    for (const h of sched.list()) expect(h.result.status).not.toBe("queued")
    expect(sched.list().length).toBe(3)
  })

  test("HELL-1b: queue absent ⇒ forceBackground(any) returns queue_disabled (no-throw)", () => {
    const { runner } = multiRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner, maxConcurrent: 1 })
    const id = sched.fork({ task: "a" })
    expect(sched.forceBackground(id)).toBe("queue_disabled")
    expect(sched.forceBackground("bogus")).toBe("queue_disabled")
  })
})

describe("force_background Phase 1 — B. queue admission", () => {
  test("HELL-2: admissionQueue ⇒ over-cap fork enters queued; poll+list surface it", () => {
    const { runner, startedTasks } = multiRunner()
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 3,
      admissionQueue: true,
      idGen,
      now: fixedNow,
    })
    sched.fork({ task: "a" })
    sched.fork({ task: "b" })
    sched.fork({ task: "c" })
    const q = sched.fork({ task: "d" })
    expect(sched.poll(q)?.status).toBe("queued")
    expect(sched.list().some((h) => h.id === q && h.result.status === "queued")).toBe(true)
    // The runner never saw the queued spec — it has NOT started.
    expect(startedTasks()).not.toContain("d")
    expect(startedTasks().sort()).toEqual(["a", "b", "c"])
  })
})

describe("force_background Phase 1 — C. auto-drain FIFO", () => {
  test("HELL-3: completing a running child auto-promotes the OLDEST queued (FIFO)", async () => {
    const { runner, resolveNext, startedTasks } = multiRunner()
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 2,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "r1" })
    sched.fork({ task: "r2" })
    const q1 = sched.fork({ task: "q1" })
    const q2 = sched.fork({ task: "q2" })
    expect(sched.poll(q1)?.status).toBe("queued")
    expect(sched.poll(q2)?.status).toBe("queued")

    // Free one slot → q1 (oldest queued) auto-promotes, NOT q2.
    resolveNext()
    await yieldMicrotasks()
    expect(sched.poll(q1)?.status).toBe("running")
    expect(sched.poll(q2)?.status).toBe("queued")
    expect(startedTasks()).toContain("q1")
    expect(startedTasks()).not.toContain("q2")

    // Free another slot → q2 promotes.
    resolveNext()
    await yieldMicrotasks()
    expect(sched.poll(q2)?.status).toBe("running")
  })

  test("HELL-3b: countRunning never exceeds maxConcurrent during auto-drain", async () => {
    const { runner, resolveNext } = multiRunner()
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "r" })
    sched.fork({ task: "q1" })
    sched.fork({ task: "q2" })
    const running = (): number => sched.list().filter((h) => h.result.status === "running").length
    expect(running()).toBe(1)
    resolveNext()
    await yieldMicrotasks()
    expect(running()).toBe(1) // q1 took the freed slot, never 2
    resolveNext()
    await yieldMicrotasks()
    expect(running()).toBe(1)
  })
})

describe("force_background Phase 1 — D. boundedness", () => {
  test("HELL-Q: queue is bounded ⇒ over maxQueued fork throws typed queue-full", () => {
    const { runner } = multiRunner()
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      maxQueued: 2,
      idGen,
    })
    sched.fork({ task: "r" }) // running
    sched.fork({ task: "q1" }) // queued 1
    sched.fork({ task: "q2" }) // queued 2 (at maxQueued)
    let caught: unknown = null
    try {
      sched.fork({ task: "q3" })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SubagentBackgroundError)
    expect((caught as SubagentBackgroundError).code).toBe("queue-full")
    // No unbounded growth — exactly 2 queued.
    expect(sched.list().filter((h) => h.result.status === "queued").length).toBe(2)
  })
})

describe("force_background Phase 1 — E. cancel a queued handle", () => {
  test("HELL-8: cancel before promotion ⇒ cancelled, never runs, out of FIFO", async () => {
    const { runner, resolveNext, startedTasks } = multiRunner()
    const sched = defaultBackgroundSubagentScheduler({
      runner,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    sched.fork({ task: "r" })
    const q1 = sched.fork({ task: "q1" })
    const q2 = sched.fork({ task: "q2" })
    expect(sched.cancel(q1)).toBe(true)
    expect(sched.poll(q1)?.status).toBe("cancelled")

    // Freeing the slot promotes q2 (q1 is out of the FIFO), q1 never runs.
    resolveNext()
    await yieldMicrotasks()
    expect(sched.poll(q2)?.status).toBe("running")
    expect(startedTasks()).not.toContain("q1")
    // forceBackground on the cancelled (terminal) handle ⇒ already_running.
    expect(sched.forceBackground(q1)).toBe("already_running")
  })
})

describe("force_background Phase 1 — F. serialize/hydrate", () => {
  test("HELL-9: a queued entry reborn as failed 'lost across restart'; never re-runs", () => {
    const { runner: r1 } = multiRunner()
    const a = defaultBackgroundSubagentScheduler({
      runner: r1,
      maxConcurrent: 1,
      admissionQueue: true,
      idGen,
    })
    a.fork({ task: "r" })
    const q = a.fork({ task: "q" })
    expect(a.poll(q)?.status).toBe("queued")
    const json = a.serialize()

    // Restart: a fresh runner that records any start (must NOT be invoked for q).
    const { runner: r2, startedTasks } = multiRunner()
    const b = defaultBackgroundSubagentScheduler({ runner: r2, admissionQueue: true })
    const restored = b.hydrate(json)
    expect(restored).toBeGreaterThanOrEqual(1)
    const snap = b.poll(q)
    expect(snap?.status).toBe("failed")
    expect(snap?.errorMessage).toBe("lost across restart")
    expect(startedTasks()).toEqual([]) // no silent re-run of a side-effecting task
  })
})
