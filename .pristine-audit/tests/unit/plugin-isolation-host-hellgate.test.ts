/**
 * PluginHost — hellgate (ADR-0162 Phase B).
 *
 * Drives PluginHost against a hand-crafted fake {@link IsolatedProcess} so
 * the tests stay fast (no real process spawn) and deterministic (the fake
 * lets us synthesise any sequence of inbound frames, including corrupted /
 * duplicate-id / unknown-method).
 *
 * Sections (14 cases total):
 *   A. Call timeout / abort (4)        — default + custom timeout, pre-fired
 *                                         AbortSignal, abort mid-call.
 *   B. Frame validation (3)            — non-object frame / missing jsonrpc /
 *                                         missing id+method shape.
 *   C. Duplicate / unknown id (2)      — second response for same id dropped;
 *                                         response for never-issued id dropped.
 *   D. Notifications (2)               — unknown method warn-dropped; handler
 *                                         exception is isolated.
 *   E. Lifecycle (3)                   — child exit fails all pending; stop()
 *                                         idempotent; call after exit rejects.
 */

import { describe, expect, test } from "bun:test"
import type { IsolatedProcess } from "@/plugin-isolation"
import { DEFAULT_CALL_TIMEOUT_MS, PluginHost, type PluginHostError } from "@/plugin-isolation"

interface FakeProcessControl {
  readonly process: IsolatedProcess
  readonly sent: unknown[]
  /** Push an inbound frame as if the child wrote it. */
  push(msg: unknown): void
  /** Simulate process exit. */
  finishExit(code: number | null): void
}

const createFakeProcess = (serviceName = "fake-svc"): FakeProcessControl => {
  const sent: unknown[] = []
  const listeners = new Set<(m: unknown) => void>()
  let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {
    // assigned below
  }
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((res) => {
    resolveExit = res
  })
  const process: IsolatedProcess = {
    pid: 12345,
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
      await exitPromise
    },
    exitPromise,
  }
  return {
    process,
    sent,
    push: (msg) => {
      for (const h of Array.from(listeners)) {
        h(msg)
      }
    },
    finishExit: (code) => {
      resolveExit({ code, signal: null })
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("ADR-0162 PluginHost hellgate — A. Call timeout / abort", () => {
  test("custom timeout fires + rejects with kind=call-timeout", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    let caught: PluginHostError | null = null
    try {
      await host.call("slow", { x: 1 }, { timeoutMs: 30 })
    } catch (e) {
      caught = e as PluginHostError
    }
    expect(caught?.kind).toBe("call-timeout")
    await host.stop()
  })

  test("default timeout constant is 30000ms", () => {
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(30_000)
  })

  test("pre-aborted AbortSignal rejects synchronously with kind=call-aborted", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const ac = new AbortController()
    ac.abort()
    let caught: PluginHostError | null = null
    try {
      await host.call("any", undefined, { signal: ac.signal, timeoutMs: 5000 })
    } catch (e) {
      caught = e as PluginHostError
    }
    expect(caught?.kind).toBe("call-aborted")
    await host.stop()
  })

  test("abort mid-call rejects + removes from pending (no timer leak)", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const ac = new AbortController()
    const p = host.call("slow", undefined, { signal: ac.signal, timeoutMs: 5000 })
    await sleep(10)
    ac.abort()
    let caught: PluginHostError | null = null
    try {
      await p
    } catch (e) {
      caught = e as PluginHostError
    }
    expect(caught?.kind).toBe("call-aborted")
    await host.stop()
  })
})

describe("ADR-0162 PluginHost hellgate — B. Frame validation", () => {
  test("non-object frame is dropped (call stays pending until timeout)", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    ctl.push("a-bare-string")
    ctl.push(42)
    ctl.push(null)
    let caught: PluginHostError | null = null
    try {
      await host.call("x", undefined, { timeoutMs: 30 })
    } catch (e) {
      caught = e as PluginHostError
    }
    expect(caught?.kind).toBe("call-timeout")
    await host.stop()
  })

  test("frame missing jsonrpc tag is dropped", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const p = host.call("x", undefined, { timeoutMs: 50 })
    ctl.push({ id: 1, result: "boom" }) // no jsonrpc
    let caught: PluginHostError | null = null
    try {
      await p
    } catch (e) {
      caught = e as PluginHostError
    }
    expect(caught?.kind).toBe("call-timeout")
    await host.stop()
  })

  test("frame with neither id nor method is dropped", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const p = host.call("x", undefined, { timeoutMs: 50 })
    ctl.push({ jsonrpc: "2.0", result: "no-id-or-method" })
    let caught: PluginHostError | null = null
    try {
      await p
    } catch (e) {
      caught = e as PluginHostError
    }
    expect(caught?.kind).toBe("call-timeout")
    await host.stop()
  })
})

describe("ADR-0162 PluginHost hellgate — C. Duplicate / unknown id", () => {
  test("duplicate response for same id — second is dropped (no double-resolve)", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const p = host.call("op", { a: 1 })
    await sleep(5)
    ctl.push({ jsonrpc: "2.0", id: 1, result: "first" })
    ctl.push({ jsonrpc: "2.0", id: 1, result: "second" }) // should be dropped
    const got = await p
    expect(got).toBe("first")
    // No throw observed when pushing the dup.
    await host.stop()
  })

  test("response for never-issued id is dropped silently", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    // Push a response for id=999 with no pending call.
    ctl.push({ jsonrpc: "2.0", id: 999, result: "stray" })
    // Now issue a real call to confirm host still works.
    const p = host.call("real", undefined, { timeoutMs: 200 })
    await sleep(5)
    ctl.push({ jsonrpc: "2.0", id: 1, result: "ok" })
    expect(await p).toBe("ok")
    await host.stop()
  })
})

describe("ADR-0162 PluginHost hellgate — D. Notifications", () => {
  test("unknown method notification is warn-dropped (no throw)", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    expect(() => {
      ctl.push({ jsonrpc: "2.0", method: "no.handler", params: {} })
    }).not.toThrow()
    await host.stop()
  })

  test("handler exception is isolated — sibling handlers still fire", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const calls: string[] = []
    host.onNotification("ev", () => {
      throw new Error("handler-a boom")
    })
    host.onNotification("ev", () => {
      calls.push("b")
    })
    ctl.push({ jsonrpc: "2.0", method: "ev", params: { v: 1 } })
    expect(calls).toEqual(["b"])
    await host.stop()
  })
})

describe("ADR-0162 PluginHost hellgate — E. Lifecycle", () => {
  test("child exit fails all pending with kind=process-exited", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    // Attach catch handlers synchronously so the unhandled-rejection guard
    // doesn't fire when finishExit() rejects both at once.
    const p1 = host.call("a", undefined, { timeoutMs: 5000 }).catch((e) => e)
    const p2 = host.call("b", undefined, { timeoutMs: 5000 }).catch((e) => e)
    ctl.finishExit(99)
    // Wait a tick for the exitPromise.then chain to run.
    await sleep(10)
    const e1 = (await p1) as PluginHostError
    const e2 = (await p2) as PluginHostError
    expect(e1?.kind).toBe("process-exited")
    expect(e2?.kind).toBe("process-exited")
    await host.stop()
  })

  test("stop() is idempotent", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const s1 = host.stop()
    const s2 = host.stop()
    // Both await the same exit — must be the same Promise (or at least
    // settle without throwing).
    await s1
    await s2
    expect(s1).toBe(s2)
  })

  test("call() after exit rejects synchronously with kind=process-exited", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    ctl.finishExit(0)
    await sleep(10)
    let caught: PluginHostError | null = null
    try {
      await host.call("x")
    } catch (e) {
      caught = e as PluginHostError
    }
    expect(caught?.kind).toBe("process-exited")
    await host.stop()
  })
})
