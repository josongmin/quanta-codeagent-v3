/**
 * PluginLifecycleManager — happy-path unit (ADR-0162 Phase D).
 *
 * Smoke-level positive assertions: defaults, ping wire format, and basic
 * state-transition observability.
 */

import { describe, expect, test } from "bun:test"
import type { IsolatedProcess, IsolatedProcessSpawnerPort, SpawnOpts } from "@/plugin-isolation"
import {
  DEFAULT_LIFECYCLE_POLICY,
  HEARTBEAT_PING_METHOD,
  PluginLifecycleManager,
} from "@/plugin-isolation"

const makeStubProcess = (serviceName: string): { proc: IsolatedProcess; sent: unknown[] } => {
  const sent: unknown[] = []
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>(() => {
    // never settles unless killed
  })
  const proc: IsolatedProcess = {
    pid: 42,
    serviceName,
    send: (m) => {
      sent.push(m)
    },
    onMessage: () => () => {
      // no-op
    },
    kill: async () => {
      // no-op
    },
    exitPromise,
  }
  return { proc, sent }
}

describe("ADR-0162 lifecycle happy-path", () => {
  test("default policy matches DXT-derived expectations", () => {
    expect(DEFAULT_LIFECYCLE_POLICY).toEqual({
      maxRestarts: 3,
      restartWindowMs: 60_000,
      heartbeatIntervalMs: 10_000,
      heartbeatMissThreshold: 2,
    })
  })

  test("HEARTBEAT_PING_METHOD constant is the agreed-on slash-prefixed name", () => {
    expect(HEARTBEAT_PING_METHOD).toBe("$/ping")
  })

  test("initial state is 'idle' before start", () => {
    let captured: { proc: IsolatedProcess; sent: unknown[] } | null = null
    const port: IsolatedProcessSpawnerPort = {
      spawn: async () => {
        const r = makeStubProcess("svc")
        captured = r
        return r.proc
      },
    }
    const factory = (): SpawnOpts => ({ entry: "/dummy", serviceName: "svc" })
    const lc = new PluginLifecycleManager(port, factory)
    expect(lc.state).toBe("idle")
    expect(captured).toBeNull()
  })

  test("ping is emitted as a $/ping notification (when heartbeat enabled)", async () => {
    const sent: unknown[][] = []
    const port: IsolatedProcessSpawnerPort = {
      spawn: async (opts) => {
        const r = makeStubProcess(opts.serviceName)
        sent.push(r.sent)
        return r.proc
      },
    }
    const factory = (): SpawnOpts => ({ entry: "/dummy", serviceName: "svc" })

    let intervalCb: (() => void) | null = null
    const fakeSet = ((cb: () => void) => {
      intervalCb = cb
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    const fakeClear = (() => {
      intervalCb = null
    }) as typeof clearInterval

    const lc = new PluginLifecycleManager(port, factory, {
      policy: {
        maxRestarts: 3,
        restartWindowMs: 60_000,
        heartbeatIntervalMs: 100,
        heartbeatMissThreshold: 2,
      },
      setIntervalImpl: fakeSet,
      clearIntervalImpl: fakeClear,
    })
    await lc.start()
    intervalCb?.()
    const procSent = sent[0]
    if (!procSent) throw new Error("expected first proc sent buffer")
    const ping = procSent[0] as { jsonrpc: string; method: string }
    expect(ping.method).toBe(HEARTBEAT_PING_METHOD)
    expect(ping.jsonrpc).toBe("2.0")
    await lc.stop()
  })
})
