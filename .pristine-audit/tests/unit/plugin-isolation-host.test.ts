/**
 * PluginHost — happy-path unit (ADR-0162 Phase B).
 *
 * Validates the JSON-RPC 2.0 wire format that PluginHost emits and the
 * notification-handler registry, using a fake IsolatedProcess.
 */

import { describe, expect, test } from "bun:test"
import type { IsolatedProcess } from "@/plugin-isolation"
import { PluginHost } from "@/plugin-isolation"

interface FakeProcessControl {
  readonly process: IsolatedProcess
  readonly sent: unknown[]
  push(msg: unknown): void
}

const createFakeProcess = (): FakeProcessControl => {
  const sent: unknown[] = []
  const listeners = new Set<(m: unknown) => void>()
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>(() => {
    // never settles unless kill is called
  })
  const process: IsolatedProcess = {
    pid: 1,
    serviceName: "svc",
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
      // resolve nothing — the test will not await this
    },
    exitPromise,
  }
  return {
    process,
    sent,
    push: (msg) => {
      for (const h of Array.from(listeners)) h(msg)
    },
  }
}

describe("ADR-0162 PluginHost happy-path", () => {
  test("call emits a valid JSON-RPC 2.0 request envelope", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const p = host.call("op", { a: 1 })
    // Reply so the call resolves and we don't leak a pending entry.
    ctl.push({ jsonrpc: "2.0", id: 1, result: "ok" })
    await p
    expect(ctl.sent[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "op", params: { a: 1 } })
  })

  test("call without params omits the params key (smaller wire)", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const p = host.call("ping")
    ctl.push({ jsonrpc: "2.0", id: 1, result: null })
    await p
    expect(ctl.sent[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" })
  })

  test("notify emits a notification envelope (no id)", () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    host.notify("event", { v: 1 })
    expect(ctl.sent[0]).toEqual({ jsonrpc: "2.0", method: "event", params: { v: 1 } })
  })

  test("notify without params omits the params key", () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    host.notify("noop")
    expect(ctl.sent[0]).toEqual({ jsonrpc: "2.0", method: "noop" })
  })

  test("ids increment per call (1, 2, 3, ...)", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const p1 = host.call("a")
    const p2 = host.call("b")
    const p3 = host.call("c")
    ctl.push({ jsonrpc: "2.0", id: 1, result: 1 })
    ctl.push({ jsonrpc: "2.0", id: 2, result: 2 })
    ctl.push({ jsonrpc: "2.0", id: 3, result: 3 })
    expect(await p1).toBe(1)
    expect(await p2).toBe(2)
    expect(await p3).toBe(3)
    expect(ctl.sent.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3])
  })

  test("remote error rejects with kind=remote-error", async () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const p = host.call("op").catch((e) => e)
    ctl.push({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method not found" },
    })
    const err = (await p) as { kind: string; message: string }
    expect(err.kind).toBe("remote-error")
    expect(err.message).toContain("-32601")
    expect(err.message).toContain("method not found")
  })

  test("onNotification handler receives params; unsubscribe stops delivery", () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const got: unknown[] = []
    const unsub = host.onNotification("ev", (p) => got.push(p))
    ctl.push({ jsonrpc: "2.0", method: "ev", params: { x: 1 } })
    expect(got).toEqual([{ x: 1 }])
    unsub()
    ctl.push({ jsonrpc: "2.0", method: "ev", params: { x: 2 } })
    expect(got).toEqual([{ x: 1 }])
  })

  test("multiple handlers for the same method all fire", () => {
    const ctl = createFakeProcess()
    const host = new PluginHost(ctl.process)
    const a: unknown[] = []
    const b: unknown[] = []
    host.onNotification("ev", (p) => a.push(p))
    host.onNotification("ev", (p) => b.push(p))
    ctl.push({ jsonrpc: "2.0", method: "ev", params: 42 })
    expect(a).toEqual([42])
    expect(b).toEqual([42])
  })
})
