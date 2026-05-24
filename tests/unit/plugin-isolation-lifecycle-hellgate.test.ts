/**
 * PluginLifecycleManager — hellgate (ADR-0162 Phase D).
 *
 * No real processes: a controllable stub spawner lets us simulate crashes,
 * pong drops, restart-budget exhaustion, and clock advancement deterministically.
 *
 * Sections (12 cases):
 *   A. Restart budget (4)        — happy restart < budget; budget exceeded
 *                                   → state=dead; rolling window trims; stop
 *                                   after dead is no-op.
 *   B. Heartbeat (3)             — pong silence triggers stop+restart; pong
 *                                   resets liveness; heartbeatIntervalMs=0
 *                                   disables ping entirely.
 *   C. stop() (3)                — stop during running; stop during restarting
 *                                   prevents next spawn; idempotent.
 *   D. Initial spawn failure (2) — spawner throws → start() rejects + state=dead;
 *                                   stop() before start is safe.
 */

import { describe, expect, test } from "bun:test"
import type {
  IsolatedProcess,
  IsolatedProcessSpawnerPort,
  LifecycleOpts,
  SpawnOpts,
} from "@/plugin-isolation"
import {
  HEARTBEAT_PONG_METHOD,
  type LifecycleError,
  PluginLifecycleManager,
} from "@/plugin-isolation"

interface StubProcessControl {
  readonly process: IsolatedProcess
  /** Force the child to exit. */
  fireExit(code: number | null): void
  /** Push an inbound message (used to inject pong replies). */
  push(msg: unknown): void
  /** Inspect sent messages. */
  readonly sent: unknown[]
}

const makeStubProcess = (serviceName: string): StubProcessControl => {
  const sent: unknown[] = []
  const listeners = new Set<(m: unknown) => void>()
  let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {
    // assigned below
  }
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((res) => {
    resolveExit = res
  })
  const process: IsolatedProcess = {
    pid: Math.floor(Math.random() * 1_000_000),
    serviceName,
    send: (m) => {
      sent.push(m)
    },
    onMessage: (h) => {
      listeners.add(h)
      return () => {
        listeners.delete(h)
      }
    },
    kill: async () => {
      resolveExit({ code: 0, signal: "SIGTERM" })
    },
    exitPromise,
  }
  return {
    process,
    fireExit: (code) => resolveExit({ code, signal: null }),
    push: (msg) => {
      for (const h of Array.from(listeners)) h(msg)
    },
    sent,
  }
}

interface StubSpawnerControl {
  readonly port: IsolatedProcessSpawnerPort
  /** All processes spawned, in order. */
  readonly procs: StubProcessControl[]
  /** Pre-set the spawn function to throw on next call. */
  failNext(err: Error): void
}

const makeStubSpawner = (): StubSpawnerControl => {
  const procs: StubProcessControl[] = []
  let pendingErr: Error | null = null
  const port: IsolatedProcessSpawnerPort = {
    spawn: async (opts: SpawnOpts) => {
      if (pendingErr) {
        const e = pendingErr
        pendingErr = null
        throw e
      }
      const p = makeStubProcess(opts.serviceName)
      procs.push(p)
      return p.process
    },
  }
  return {
    port,
    procs,
    failNext: (e) => {
      pendingErr = e
    },
  }
}

const noopFactory: () => SpawnOpts = () => ({
  entry: "/dummy",
  serviceName: "stub",
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe("ADR-0162 PluginLifecycleManager — A. Restart budget", () => {
  test("happy restart within budget transitions back to running", async () => {
    const s = makeStubSpawner()
    const now = 1000
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
      clock: () => now,
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    expect(lc.state).toBe("running")
    // First crash
    s.procs[0]?.fireExit(1)
    await tick()
    await tick()
    expect(lc.state).toBe("running")
    expect(s.procs.length).toBe(2)
    await lc.stop()
  })

  test("budget exceeded → state=dead, no further restart", async () => {
    const s = makeStubSpawner()
    const now = 1000
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 2,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
      clock: () => now,
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    // Crash 3 times within the window — first 2 OK, 3rd exceeds budget.
    s.procs[0]?.fireExit(1)
    await tick()
    await tick()
    s.procs[1]?.fireExit(1)
    await tick()
    await tick()
    s.procs[2]?.fireExit(1)
    await tick()
    await tick()
    expect(lc.state).toBe("dead")
    await lc.stop()
  })

  test("rolling window trims old crashes — allows restart after window passes", async () => {
    const s = makeStubSpawner()
    let now = 1000
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 1,
        restartWindowMs: 1_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
      clock: () => now,
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    // First crash uses the budget.
    s.procs[0]?.fireExit(1)
    await tick()
    await tick()
    expect(lc.state).toBe("running")
    // Move past the window.
    now = 10_000
    // Second crash — budget refreshed by trimming the old timestamp.
    s.procs[1]?.fireExit(1)
    await tick()
    await tick()
    expect(lc.state).toBe("running")
    await lc.stop()
  })

  test("stop() after dead is safe + idempotent", async () => {
    const s = makeStubSpawner()
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 1,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    s.procs[0]?.fireExit(1)
    await tick()
    await tick()
    s.procs[1]?.fireExit(1)
    await tick()
    await tick()
    expect(lc.state).toBe("dead")
    await lc.stop()
    await lc.stop()
    expect(lc.state).toBe("stopped")
  })
})

describe("ADR-0162 PluginLifecycleManager — B. Heartbeat", () => {
  test("pong silence beyond deadline triggers child kill (restart cycle)", async () => {
    const s = makeStubSpawner()
    let now = 1000
    const cbBox: { current: (() => void) | null } = { current: null }
    const fakeSet = ((cb: () => void) => {
      cbBox.current = cb
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    const fakeClear = ((_: ReturnType<typeof setInterval>) => {
      cbBox.current = null
    }) as typeof clearInterval
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 100,
        heartbeatMissThreshold: 2,
      },
      clock: () => now,
      setIntervalImpl: fakeSet,
      clearIntervalImpl: fakeClear,
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    expect(cbBox.current).not.toBeNull()
    // Advance clock past deadline (interval * threshold = 200ms).
    now = 1500
    cbBox.current?.()
    await tick()
    await tick()
    await tick()
    // The host was killed and a new child spawned.
    expect(s.procs.length).toBeGreaterThanOrEqual(2)
    await lc.stop()
  })

  test("pong arrival resets liveness (no kill)", async () => {
    const s = makeStubSpawner()
    let now = 1000
    const cbBox: { current: (() => void) | null } = { current: null }
    const fakeSet = ((cb: () => void) => {
      cbBox.current = cb
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    const fakeClear = ((_: ReturnType<typeof setInterval>) => {
      cbBox.current = null
    }) as typeof clearInterval
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 100,
        heartbeatMissThreshold: 2,
      },
      clock: () => now,
      setIntervalImpl: fakeSet,
      clearIntervalImpl: fakeClear,
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    // Pong arrives; clock advances; deadline NOT exceeded because of the pong.
    now = 1050
    s.procs[0]?.push({ jsonrpc: "2.0", method: HEARTBEAT_PONG_METHOD })
    await tick()
    now = 1150
    cbBox.current?.()
    await tick()
    expect(s.procs.length).toBe(1) // no restart
    await lc.stop()
  })

  test("heartbeatIntervalMs=0 disables ping entirely", async () => {
    const s = makeStubSpawner()
    let intervalCalls = 0
    const fakeSet = ((_cb: () => void) => {
      intervalCalls++
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
      setIntervalImpl: fakeSet,
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    expect(intervalCalls).toBe(0)
    await lc.stop()
  })
})

describe("ADR-0162 PluginLifecycleManager — C. stop()", () => {
  test("stop() during running awaits child reaping + transitions to stopped", async () => {
    const s = makeStubSpawner()
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    await lc.stop()
    expect(lc.state).toBe("stopped")
  })

  test("stop() during restarting prevents the next spawn from becoming active", async () => {
    const s = makeStubSpawner()
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    s.procs[0]?.fireExit(1)
    // Don't await the restart — request stop in the same tick.
    await lc.stop()
    expect(lc.state).toBe("stopped")
    // Even if a restart spawn lands afterwards, lifecycle stays stopped.
    await tick()
    await tick()
    expect(lc.state).toBe("stopped")
  })

  test("stop() is idempotent + start() after stop rejects", async () => {
    const s = makeStubSpawner()
    const opts: LifecycleOpts = {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
    }
    const lc = new PluginLifecycleManager(s.port, noopFactory, opts)
    await lc.start()
    await lc.stop()
    await lc.stop()
    let caught: LifecycleError | null = null
    try {
      await lc.start()
    } catch (e) {
      caught = e as LifecycleError
    }
    expect(caught?.kind).toBe("stopped")
  })
})

describe("ADR-0162 PluginLifecycleManager — D. Initial spawn failure", () => {
  test("spawner throws → start rejects with kind=spawn-failed + state=dead", async () => {
    const s = makeStubSpawner()
    s.failNext(new Error("spawn-boom"))
    const lc = new PluginLifecycleManager(s.port, noopFactory, {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 0,
        heartbeatMissThreshold: 2,
      },
    })
    let caught: LifecycleError | null = null
    try {
      await lc.start()
    } catch (e) {
      caught = e as LifecycleError
    }
    expect(caught?.kind).toBe("spawn-failed")
    expect(lc.state).toBe("dead")
  })

  test("stop() without prior start is safe", async () => {
    const s = makeStubSpawner()
    const lc = new PluginLifecycleManager(s.port, noopFactory)
    await lc.stop()
    expect(lc.state).toBe("stopped")
  })
})
