/** ADR-0435 — auto-restart supervisor hellgate (RFC §9 cases 1–8).
 *
 *  Fully on a fake clock + fake timer queue — there are ZERO real timers, ZERO
 *  real RNG/Date.now. Each case drives the state machine deterministically. */

import { describe, expect, it } from "bun:test"
import type { McpCallResult, McpServerConfig, McpToolDef } from "../../types"
import { type BackoffPolicy, DEFAULT_BACKOFF_POLICY } from "../policy"
import type { SupervisableMcpClient } from "../port"
import { McpReconnectSupervisor, type SupervisorDeps } from "../supervisor"

// --- fake clock + timer queue (RFC §9 idiom) --------------------------------

interface FakeClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => () => void
  advance: (ms: number) => void
  pending: () => number
}

const makeClock = (): FakeClock => {
  let now = 0
  let seq = 0
  const timers: Array<{ at: number; seq: number; fn: () => void }> = []
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const e = { at: now + ms, seq: seq++, fn }
      timers.push(e)
      return () => {
        const i = timers.indexOf(e)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    advance: (ms) => {
      now += ms
      // Fire due timers FIFO. Re-scan after each fire so timers scheduled by a
      // fired callback are also considered within this advance.
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = due[0]
        if (next === undefined) break
        const i = timers.indexOf(next)
        timers.splice(i, 1)
        next.fn()
      }
    },
    pending: () => timers.length,
  }
}

// --- fake supervisable client ----------------------------------------------

interface FakeClientControl {
  client: SupervisableMcpClient
  crash: (reason?: string) => void
  started: boolean
  stopped: boolean
  startCalls: number
  listCalls: number
  callCalls: number
}

interface FakeClientOpts {
  startThrows?: boolean
  listThrows?: boolean
  tools?: McpToolDef[]
  callResult?: McpCallResult
}

const makeFakeClient = (opts: FakeClientOpts = {}): FakeClientControl => {
  const handlers = new Set<(reason?: string) => void>()
  const ctl: FakeClientControl = {
    started: false,
    stopped: false,
    startCalls: 0,
    listCalls: 0,
    callCalls: 0,
    crash: (reason) => {
      for (const h of handlers) h(reason)
    },
    client: {
      async start() {
        ctl.startCalls += 1
        if (opts.startThrows) throw new Error("start failed")
        ctl.started = true
      },
      async listTools() {
        ctl.listCalls += 1
        if (opts.listThrows) throw new Error("list failed")
        return opts.tools ?? [{ name: "echo", description: "", inputSchema: { type: "object" } }]
      },
      async callTool(_name, _args) {
        ctl.callCalls += 1
        return opts.callResult ?? { ok: true, content: "ok" }
      },
      async stop() {
        ctl.stopped = true
      },
      onExit(handler) {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    },
  }
  return ctl
}

/** Drain enough microtask turns to settle a multi-await async restart path
 *  (start → listTools → swap, or start-reject → stop → onStartFailure). */
const flush = async (turns = 6): Promise<void> => {
  for (let n = 0; n < turns; n += 1) await Promise.resolve()
}

const CONFIG: McpServerConfig = { name: "srv", command: ["x"] }

const policy = (over: Partial<BackoffPolicy> = {}): BackoffPolicy => ({
  ...DEFAULT_BACKOFF_POLICY,
  ...over,
})

const baseDeps = (
  clock: FakeClock,
  factory: SupervisorDeps["factory"],
  over: Partial<SupervisorDeps> = {},
): SupervisorDeps => ({
  factory,
  policy: policy(),
  now: clock.now,
  setTimer: clock.setTimer,
  random: () => 0, // deterministic: delay === base for every attempt
  ...over,
})

// --- §9.1 crash → restart → tool works again --------------------------------

describe("ADR-0435 §9.1 crash → restart → tool works again", () => {
  it("transitions healthy→crashed→backing-off→restarting→healthy and swaps client", async () => {
    const clock = makeClock()
    const first = makeFakeClient()
    const second = makeFakeClient()
    const seq = [first, second]
    let i = 0
    const states: string[] = []
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (seq[i++] ?? second).client, {
        onStateChange: (s) => states.push(s.state),
      }),
    )
    expect(sup.snapshot().state).toBe("healthy")
    expect(sup.current()).toBe(first.client)

    first.crash("boom")
    expect(sup.snapshot().state).toBe("backing-off")
    expect(sup.snapshot().lastDiagnostic).toBe("boom")

    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    // Restart is async (start+listTools); flush microtasks.
    await Promise.resolve()
    await Promise.resolve()

    expect(sup.snapshot().state).toBe("healthy")
    expect(sup.current()).toBe(second.client)
    expect(second.startCalls).toBe(1)
    expect(second.listCalls).toBe(1)

    const res = await sup.callTool("echo", {})
    expect(res.ok).toBe(true)
    expect(second.callCalls).toBe(1)
    expect(states).toContain("crashed")
    expect(states).toContain("backing-off")
    expect(states).toContain("restarting")
  })
})

// --- §9.2 backoff timing (jitter injected) ----------------------------------

describe("ADR-0435 §9.2 backoff timing", () => {
  it("does not restart before delay elapses; restarts exactly at delay", async () => {
    const clock = makeClock()
    const first = makeFakeClient()
    const second = makeFakeClient()
    const seq = [first, second]
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (seq[i++] ?? second).client),
    )
    first.crash()
    const delay = DEFAULT_BACKOFF_POLICY.fastRetryBaseMs // attempt0, random=0 ⇒ base
    expect(sup.snapshot().nextRetryInMs).toBe(delay)

    clock.advance(delay - 1)
    await Promise.resolve()
    expect(sup.snapshot().state).toBe("backing-off")
    expect(second.startCalls).toBe(0)

    clock.advance(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(sup.snapshot().state).toBe("healthy")
    expect(second.startCalls).toBe(1)
  })
})

// --- §9.3 storm cap → give-up ----------------------------------------------

describe("ADR-0435 §9.3 restart storm → DEGRADED give-up", () => {
  it("after maxFastAttempts + maxPeriodicCycles the supervisor stops trying", async () => {
    const clock = makeClock()
    // Every restart client throws on start.
    const factory = (): SupervisableMcpClient => makeFakeClient({ startThrows: true }).client
    let factoryCalls = 0
    const countingFactory = (): SupervisableMcpClient => {
      factoryCalls += 1
      return factory()
    }
    const p = policy({ maxFastAttempts: 3, maxPeriodicCycles: 2 })
    const first = makeFakeClient()
    let firstUsed = false
    const sup = await McpReconnectSupervisor.create(CONFIG, {
      ...baseDeps(clock, () => {
        if (!firstUsed) {
          firstUsed = true
          return first.client
        }
        return countingFactory()
      }),
      policy: p,
    })
    expect(sup.snapshot().state).toBe("healthy")
    first.crash()

    // Drive through fast + periodic phases. Each backoff uses delays up to the
    // periodic max; advance generously and flush.
    for (let n = 0; n < 30; n += 1) {
      clock.advance(p.periodicMaxMs)
      // flush microtasks generated by the async restart
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
      if (sup.snapshot().state === "degraded") break
    }
    expect(sup.snapshot().state).toBe("degraded")

    const callsAtDegraded = factoryCalls
    expect(clock.pending()).toBe(0) // no timer left running
    clock.advance(p.periodicMaxMs * 100)
    await Promise.resolve()
    expect(factoryCalls).toBe(callsAtDegraded) // no further restart attempts
  })
})

// --- §9.4 startup-instant-death server --------------------------------------

describe("ADR-0435 §9.4 server that dies on first start", () => {
  it("first start failure enters backoff; tool calls fail with byte-identical message", async () => {
    const clock = makeClock()
    let n = 0
    const sup = await McpReconnectSupervisor.create(CONFIG, {
      ...baseDeps(clock, () => {
        n += 1
        return makeFakeClient({ startThrows: true }).client
      }),
      policy: policy({ maxFastAttempts: 2, maxPeriodicCycles: 1 }),
    })
    // First start failed ⇒ not healthy ⇒ backing-off.
    expect(sup.snapshot().state).toBe("backing-off")

    await expect(sup.callTool("echo", {})).rejects.toThrow(`mcp server "srv" is not running`)

    // Exhaust caps → DEGRADED, still same message (today's behavior).
    for (let k = 0; k < 20; k += 1) {
      clock.advance(DEFAULT_BACKOFF_POLICY.periodicMaxMs)
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
      if (sup.snapshot().state === "degraded") break
    }
    expect(sup.snapshot().state).toBe("degraded")
    await expect(sup.callTool("echo", {})).rejects.toThrow(`mcp server "srv" is not running`)
    expect(n).toBeGreaterThan(1)
  })
})

// --- §9.5 stability reset ---------------------------------------------------

describe("ADR-0435 §9.5 stability reset vs accumulation", () => {
  it("crash after stabilityThresholdMs resets attempt to 0 (fresh fast base delay)", async () => {
    const clock = makeClock()
    const clients = [makeFakeClient(), makeFakeClient(), makeFakeClient()]
    const fallback = makeFakeClient()
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (clients[i++] ?? fallback).client),
    )
    // Crash #1 (attempt 0) → restart succeeds.
    clients[0]?.crash()
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    expect(sup.snapshot().state).toBe("healthy")
    expect(sup.snapshot().fastAttempt).toBe(0)

    // Stay up past the stability threshold, THEN crash → attempt resets to 0.
    clock.advance(DEFAULT_BACKOFF_POLICY.stabilityThresholdMs)
    clients[1]?.crash()
    expect(sup.snapshot().fastAttempt).toBe(0)
    expect(sup.snapshot().nextRetryInMs).toBe(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
  })

  it("crash within stabilityThresholdMs accumulates attempt (longer delay)", async () => {
    const clock = makeClock()
    const clients = [makeFakeClient(), makeFakeClient({ startThrows: true }), makeFakeClient()]
    const fallback = makeFakeClient()
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (clients[i++] ?? fallback).client, {
        // random=1 so accumulated attempts produce strictly larger delays.
        random: () => 0.999999,
      }),
    )
    // Crash, restart FAILS (start throws) → fastAttempt increments to 1.
    clients[0]?.crash()
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await flush()
    expect(sup.snapshot().fastAttempt).toBe(1)
    // The newly scheduled backoff for attempt=1 has delay > base (capped-exp).
    const delay = sup.snapshot().nextRetryInMs ?? 0
    expect(delay).toBeGreaterThan(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
  })
})

// --- §9.6 stop during backing-off -------------------------------------------

describe("ADR-0435 §9.6 stop() during backing-off", () => {
  it("cancels the backoff timer and stops the live client; no restart afterward", async () => {
    const clock = makeClock()
    const first = makeFakeClient()
    let factoryCalls = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => {
        factoryCalls += 1
        return factoryCalls === 1 ? first.client : makeFakeClient().client
      }),
    )
    first.crash()
    expect(sup.snapshot().state).toBe("backing-off")
    expect(clock.pending()).toBe(1)

    await sup.stop()
    expect(clock.pending()).toBe(0) // backoff timer canceled
    expect(first.stopped).toBe(true)

    const before = factoryCalls
    clock.advance(DEFAULT_BACKOFF_POLICY.periodicMaxMs)
    await Promise.resolve()
    expect(factoryCalls).toBe(before) // no restart after stop
  })

  it("stop() is idempotent", async () => {
    const clock = makeClock()
    const first = makeFakeClient()
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => first.client),
    )
    await sup.stop()
    await sup.stop()
    expect(first.stopped).toBe(true)
  })
})

// --- §9.7 queue mode --------------------------------------------------------

describe("ADR-0435 §9.7 queue pending-policy", () => {
  it("queues a call during restart and resolves it on HEALTHY recovery", async () => {
    const clock = makeClock()
    const first = makeFakeClient()
    const second = makeFakeClient()
    const seq = [first, second]
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (seq[i++] ?? second).client, {
        pendingPolicy: "queue",
        queueWaitMaxMs: 10 * DEFAULT_BACKOFF_POLICY.fastRetryBaseMs,
      }),
    )
    first.crash()
    // Issue a call while not HEALTHY — it parks.
    const callP = sup.callTool("echo", {})
    let settled = false
    void callP.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    const res = await callP
    expect(res.ok).toBe(true)
    expect(second.callCalls).toBe(1)
  })

  it("fails fast after queueWaitMaxMs elapses without recovery", async () => {
    const clock = makeClock()
    const first = makeFakeClient()
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => makeFakeClient({ startThrows: true }).client, {
        pendingPolicy: "queue",
        queueWaitMaxMs: 1_000,
        factory: () => first.client,
      }),
    )
    first.crash()
    const callP = sup.callTool("echo", {})
    const rejected = callP.then(
      () => "resolved",
      () => "rejected",
    )
    clock.advance(1_000)
    await Promise.resolve()
    expect(await rejected).toBe("rejected")
  })

  it("DEGRADED fails immediately with no wait", async () => {
    const clock = makeClock()
    const sup = await McpReconnectSupervisor.create(CONFIG, {
      ...baseDeps(clock, () => makeFakeClient({ startThrows: true }).client),
      policy: policy({ maxFastAttempts: 1, maxPeriodicCycles: 1 }),
      pendingPolicy: "queue",
      queueWaitMaxMs: 10_000,
    })
    // Drive to degraded.
    for (let k = 0; k < 20; k += 1) {
      clock.advance(DEFAULT_BACKOFF_POLICY.periodicMaxMs)
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve()
      if (sup.snapshot().state === "degraded") break
    }
    expect(sup.snapshot().state).toBe("degraded")
    await expect(sup.callTool("echo", {})).rejects.toThrow(`mcp server "srv" is not running`)
  })
})

// --- §9.8 restart epoch stale guard -----------------------------------------

describe("ADR-0435 §9.8 epoch stale guard", () => {
  it("bumps restartEpoch on each restart attempt and on stop()", async () => {
    const clock = makeClock()
    const first = makeFakeClient()
    const second = makeFakeClient()
    const seq = [first, second]
    let i = 0
    const sup = await McpReconnectSupervisor.create(
      CONFIG,
      baseDeps(clock, () => (seq[i++] ?? second).client),
    )
    expect(sup.snapshot().restartEpoch).toBe(0)
    first.crash()
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    expect(sup.snapshot().restartEpoch).toBe(1)
    const beforeStop = sup.snapshot().restartEpoch
    await sup.stop()
    expect(sup.snapshot().restartEpoch).toBe(beforeStop + 1)
  })
})
