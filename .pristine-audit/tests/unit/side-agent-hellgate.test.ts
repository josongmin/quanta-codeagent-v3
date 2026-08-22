/**
 * Hellgate for N1 — background side-agent daemon (RFC §6.1).
 *
 * Drives the pure supervise-loop registry over FAKE ports (runner / mailbox /
 * sink / events / timers / clock) — no real timers, no Date.now, deterministic.
 * Pins every runaway guard + the no-block-main + result-surfacing invariants.
 */

import { describe, expect, test } from "bun:test"
import {
  createSideAgentDaemonRegistry,
  type SideAgentDaemonOpts,
  SideAgentError,
  type SideAgentFinding,
  type SideAgentRunnerPort,
  type SideAgentSpec,
} from "@/side-agent"

// ── fakes ─────────────────────────────────────────────────────────────────────

/** A manual interval clock: `setInterval` registers a handler; `fire(handle)`
 *  invokes it once (a "tick"); cleared handles are recorded. */
const mkTimers = () => {
  const handlers = new Map<number, () => void>()
  const cleared = new Set<number>()
  let next = 0
  return {
    setInterval: (h: () => void, _ms: number): unknown => {
      const id = ++next
      handlers.set(id, h)
      return id
    },
    clearInterval: (handle: unknown): void => {
      cleared.add(handle as number)
    },
    fire: (handle: unknown): void => {
      const h = handlers.get(handle as number)
      if (h !== undefined) h()
    },
    /** Fire the most-recently-armed interval (the single daemon's). */
    fireLatest: (): void => {
      const h = handlers.get(next)
      if (h !== undefined) h()
    },
    isCleared: (handle: unknown): boolean => cleared.has(handle as number),
    handleCount: (): number => handlers.size,
  }
}

const mkClock = () => {
  let t = 1000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const mkMailbox = () => {
  const sent: { from: string; to: string; summary: string; detail?: string }[] = []
  return {
    port: {
      send: (m: { from: string; to: string; kind: "finding"; summary: string; detail?: string }) =>
        void sent.push({
          from: m.from,
          to: m.to,
          summary: m.summary,
          ...(m.detail !== undefined ? { detail: m.detail } : {}),
        }),
    },
    sent,
  }
}

const mkSink = () => {
  const emitted: SideAgentFinding[] = []
  return { port: { emit: (f: SideAgentFinding) => void emitted.push(f) }, emitted }
}

/** A runner whose behavior per-wake is scripted via a queue of outcomes. */
const mkRunner = (
  outcomes: Array<{ summary: string; detail?: string } | null | "throw" | "hang">,
): { port: SideAgentRunnerPort } => {
  const port: SideAgentRunnerPort = {
    run: async ({ wake }) => {
      const o = outcomes[wake - 1] ?? null
      if (o === "throw") throw new Error("pass blew up")
      if (o === "hang") return new Promise(() => {}) // never resolves
      return o
    },
  }
  return { port }
}

const baseOpts = (over: Partial<SideAgentDaemonOpts> = {}): SideAgentDaemonOpts => {
  const timers = mkTimers()
  const clock = mkClock()
  const mailbox = mkMailbox()
  return {
    runner: { run: async () => null },
    mailbox: mailbox.port,
    mainRecipient: "main",
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: clock.now,
    ...over,
  }
}

const intervalSpec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
  task: "watch the build",
  trigger: { kind: "interval", everyMs: 1000 },
  maxWakes: 100,
  maxTurnsPerWake: 3,
  ...over,
})

const flush = () => new Promise((r) => setTimeout(r, 0))

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe("side-agent — lifecycle FSM", () => {
  test("spawn → running; stop → stopped; double-stop idempotent; unknown id → false", () => {
    const reg = createSideAgentDaemonRegistry(baseOpts())
    const id = reg.spawn(intervalSpec())
    expect(reg.list()[0]?.status).toBe("running")
    expect(reg.stop(id)).toBe(true)
    expect(reg.list()[0]?.status).toBe("stopped")
    expect(reg.stop(id)).toBe(true) // idempotent
    expect(reg.stop("sa-nope")).toBe(false)
  })

  test("stop clears the interval timer (no leaked timer)", () => {
    const timers = mkTimers()
    const reg = createSideAgentDaemonRegistry(
      baseOpts({ setInterval: timers.setInterval, clearInterval: timers.clearInterval }),
    )
    const id = reg.spawn(intervalSpec())
    reg.stop(id)
    // The single armed interval handle (id 1) must have been cleared.
    expect(timers.isCleared(1)).toBe(true)
  })

  test("maxWakes is a HARD ceiling → auto-stopped (no over-run)", async () => {
    const timers = mkTimers()
    const runner = mkRunner([{ summary: "1" }, { summary: "2" }, { summary: "SHOULD-NOT-RUN" }])
    let calls = 0
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        runner: {
          run: async (a) => {
            calls++
            return runner.port.run(a)
          },
        },
      }),
    )
    reg.spawn(intervalSpec({ maxWakes: 2 }))
    timers.fireLatest()
    await flush()
    timers.fireLatest()
    await flush()
    timers.fireLatest() // 3rd tick — must NOT run a pass (capped at 2)
    await flush()
    expect(calls).toBe(2)
    expect(reg.list()[0]?.status).toBe("stopped")
    expect(reg.list()[0]?.wakesDone).toBe(2)
  })

  test("idleReapMs elapsed with no finding → idle-reaped", async () => {
    const timers = mkTimers()
    const clock = mkClock()
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        now: clock.now,
        runner: { run: async () => null }, // never finds anything
      }),
    )
    reg.spawn(intervalSpec({ idleReapMs: 5000 }))
    clock.advance(6000) // wall-idle past the reap window
    timers.fireLatest()
    await flush()
    expect(reg.list()[0]?.status).toBe("idle-reaped")
  })

  test("a runner throw mid-pass → daemon 'failed', not propagated", async () => {
    const timers = mkTimers()
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        runner: {
          run: async () => {
            throw new Error("boom")
          },
        },
      }),
    )
    reg.spawn(intervalSpec())
    timers.fireLatest()
    await flush() // must not reject the test
    expect(reg.list()[0]?.status).toBe("failed")
    expect(timers.isCleared(1)).toBe(true)
  })
})

// ── bounds ────────────────────────────────────────────────────────────────────

describe("side-agent — runaway guards", () => {
  test("spawn past maxConcurrent → SideAgentError('cap-exceeded') (only throw)", () => {
    const reg = createSideAgentDaemonRegistry(baseOpts({ maxConcurrent: 2 }))
    reg.spawn(intervalSpec())
    reg.spawn(intervalSpec())
    expect(() => reg.spawn(intervalSpec())).toThrow(SideAgentError)
    try {
      reg.spawn(intervalSpec())
    } catch (e) {
      expect((e as SideAgentError).code).toBe("cap-exceeded")
    }
    // A stopped daemon frees a slot.
    const ids = reg.list().map((d) => d.id)
    reg.stop(ids[0] as string)
    expect(() => reg.spawn(intervalSpec())).not.toThrow()
  })

  test("overlapping ticks during an in-flight pass are coalesced (no double-fire)", async () => {
    const timers = mkTimers()
    let calls = 0
    let resolvePass: (() => void) | undefined
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        runner: {
          run: async () => {
            calls++
            await new Promise<void>((r) => {
              resolvePass = r
            })
            return { summary: "done" }
          },
        },
      }),
    )
    reg.spawn(intervalSpec())
    timers.fireLatest() // starts pass 1 (in-flight, hanging)
    await flush()
    timers.fireLatest() // lands during in-flight → must be DROPPED
    timers.fireLatest()
    await flush()
    expect(calls).toBe(1) // only one pass ran despite 3 ticks
    resolvePass?.()
    await flush()
  })
})

// ── no-block-main ─────────────────────────────────────────────────────────────

describe("side-agent — no-block-main (headline invariant)", () => {
  test("spawn returns synchronously even with a never-resolving runner", async () => {
    const timers = mkTimers()
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        runner: { run: () => new Promise(() => {}) }, // hangs forever
      }),
    )
    const id = reg.spawn(intervalSpec()) // must return immediately
    expect(typeof id).toBe("string")
    timers.fireLatest() // fire a wake (the pass hangs)
    // list()/findings() must still return synchronously — the loop never awaits
    // on the main path.
    expect(reg.list()[0]?.status).toBe("running")
    expect(reg.findings()).toEqual([])
    await flush()
    expect(reg.list()[0]?.status).toBe("running") // still resident, not crashed
  })
})

// ── result-surfacing ──────────────────────────────────────────────────────────

describe("side-agent — result surfacing", () => {
  test("each finding → one mailbox msg to main; findings({since}) filters; null = no msg", async () => {
    const timers = mkTimers()
    const clock = mkClock()
    const mailbox = mkMailbox()
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        now: clock.now,
        mailbox: mailbox.port,
        runner: mkRunner([{ summary: "found A" }, null, { summary: "found B", detail: "d" }]).port,
      }),
    )
    reg.spawn(intervalSpec({ maxWakes: 3 }))
    timers.fireLatest()
    await flush()
    const afterFirst = clock.now()
    clock.advance(10)
    timers.fireLatest() // null — no finding, no mailbox msg
    await flush()
    clock.advance(10)
    timers.fireLatest()
    await flush()
    // Two findings (A, B); the null wake sent nothing.
    expect(mailbox.sent.map((m) => m.summary)).toEqual(["found A", "found B"])
    expect(mailbox.sent.every((m) => m.to === "main")).toBe(true)
    // findings({since}) returns only the newer one.
    const recent = reg.findings({ since: afterFirst })
    expect(recent.map((f) => f.summary)).toEqual(["found B"])
    expect(recent[0]?.detail).toBe("d")
  })

  test("stream sink is emitted iff injected", async () => {
    const timers = mkTimers()
    const sink = mkSink()
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        sink: sink.port,
        runner: mkRunner([{ summary: "x" }]).port,
      }),
    )
    reg.spawn(intervalSpec({ maxWakes: 1 }))
    timers.fireLatest()
    await flush()
    expect(sink.emitted.map((f) => f.summary)).toEqual(["x"])
  })
})

// ── teardown ──────────────────────────────────────────────────────────────────

describe("side-agent — teardown", () => {
  test("stopAll stops every running daemon + clears their timers", () => {
    const timers = mkTimers()
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        maxConcurrent: 3,
      }),
    )
    reg.spawn(intervalSpec())
    reg.spawn(intervalSpec())
    const n = reg.stopAll()
    expect(n).toBe(2)
    expect(reg.list().every((d) => d.status === "stopped")).toBe(true)
    expect(timers.isCleared(1)).toBe(true)
    expect(timers.isCleared(2)).toBe(true)
    expect(reg.stopAll()).toBe(0) // nothing left running
  })

  test("event-trigger daemon: a published event wakes it; stop unsubscribes", async () => {
    let handler: (() => void) | undefined
    let unsubscribed = false
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        events: {
          subscribe: (_topic, h) => {
            handler = h
            return () => {
              unsubscribed = true
            }
          },
        },
        runner: mkRunner([{ summary: "evt" }]).port,
      }),
    )
    const id = reg.spawn(
      intervalSpec({ trigger: { kind: "event", topic: "fs.change" }, maxWakes: 5 }),
    )
    handler?.() // publish the event
    await flush()
    expect(reg.findings().map((f) => f.summary)).toEqual(["evt"])
    reg.stop(id)
    expect(unsubscribed).toBe(true)
  })
})

// ── self-audit remediation (R1/R2): spec validation + bounded memory ──────────

describe("side-agent — spec validation (no zombies / no CPU spin)", () => {
  test("event trigger with NO event source injected → invalid-spec (no zombie slot)", () => {
    const reg = createSideAgentDaemonRegistry(baseOpts()) // no `events`
    expect(() => reg.spawn(intervalSpec({ trigger: { kind: "event", topic: "x" } }))).toThrow(
      SideAgentError,
    )
    try {
      reg.spawn(intervalSpec({ trigger: { kind: "event", topic: "x" } }))
    } catch (e) {
      expect((e as SideAgentError).code).toBe("invalid-spec")
    }
    // Crucially: the rejected spawn occupied NO slot.
    expect(reg.list()).toEqual([])
  })

  test("interval everyMs<=0 → invalid-spec (no setInterval(_,0) spin)", () => {
    const reg = createSideAgentDaemonRegistry(baseOpts())
    expect(() => reg.spawn(intervalSpec({ trigger: { kind: "interval", everyMs: 0 } }))).toThrow(
      SideAgentError,
    )
    expect(() => reg.spawn(intervalSpec({ trigger: { kind: "interval", everyMs: -5 } }))).toThrow(
      SideAgentError,
    )
  })

  test("maxWakes<1 / maxTurnsPerWake<1 / empty task / idleReapMs<=0 → invalid-spec", () => {
    const reg = createSideAgentDaemonRegistry(baseOpts())
    expect(() => reg.spawn(intervalSpec({ maxWakes: 0 }))).toThrow(SideAgentError)
    expect(() => reg.spawn(intervalSpec({ maxTurnsPerWake: 0 }))).toThrow(SideAgentError)
    expect(() => reg.spawn(intervalSpec({ task: "   " }))).toThrow(SideAgentError)
    expect(() => reg.spawn(intervalSpec({ idleReapMs: 0 }))).toThrow(SideAgentError)
    // A valid spec still spawns.
    expect(() => reg.spawn(intervalSpec())).not.toThrow()
  })
})

describe("side-agent — bounded memory (no unbounded growth)", () => {
  test("findingsLog is ring-buffer capped at maxFindings (oldest evicted)", async () => {
    const timers = mkTimers()
    const clock = mkClock()
    const outcomes = Array.from({ length: 6 }, (_, i) => ({ summary: `f${i + 1}` }))
    const reg = createSideAgentDaemonRegistry(
      baseOpts({
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        now: clock.now,
        maxFindings: 3,
        runner: mkRunner(outcomes).port,
      }),
    )
    reg.spawn(intervalSpec({ maxWakes: 6 }))
    for (let i = 0; i < 6; i++) {
      clock.advance(10)
      timers.fireLatest()
      await flush()
    }
    const all = reg.findings()
    expect(all.length).toBe(3) // capped
    expect(all.map((f) => f.summary)).toEqual(["f4", "f5", "f6"]) // oldest evicted
  })

  test("terminal daemons are pruned past maxRetained; running are NEVER pruned", () => {
    const reg = createSideAgentDaemonRegistry(baseOpts({ maxConcurrent: 100, maxRetained: 2 }))
    // Spawn + immediately stop 5 daemons → 5 terminal, capped to the newest 2.
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = reg.spawn(intervalSpec())
      ids.push(id)
      reg.stop(id)
    }
    const list = reg.list()
    expect(list.length).toBe(2) // only the 2 newest terminal retained
    expect(list.every((d) => d.status === "stopped")).toBe(true)
    // Now spawn 3 LIVE daemons + 1 terminal — the running ones are never pruned.
    const live = [reg.spawn(intervalSpec()), reg.spawn(intervalSpec()), reg.spawn(intervalSpec())]
    const t = reg.spawn(intervalSpec())
    reg.stop(t)
    const after = reg.list()
    const running = after.filter((d) => d.status === "running").map((d) => d.id)
    expect(running.sort()).toEqual([...live].sort()) // all 3 live retained
    expect(after.filter((d) => d.status !== "running").length).toBeLessThanOrEqual(2)
  })
})
