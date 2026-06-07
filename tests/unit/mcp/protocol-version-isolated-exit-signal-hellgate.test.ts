/**
 * IsolatedMcpClient fail-closed EXIT-SIGNAL hellgate (ticket misc-jun-7/01, R4).
 *
 * R4 finding (round-3 attack vector #3, never tested): the isolated client's
 * fail-closed catch (`isolated-client.ts start()`) on an unsupported negotiated
 * `protocolVersion` nulls `host` + resets `started`, but never sets `stopped`.
 * It then calls `host.stop()`, which kills the process; the resolved
 * `host.exitPromise` fires the wired `notifyExit("process exit")` — fanning a
 * SPURIOUS crash signal out to the ADR-0435 auto-restart supervisor for a
 * DELIBERATE, permanent (unsupported-version) teardown. The supervisor would
 * then crash-loop-restart a server that will fail-close again every time.
 *
 * Unlike the prior isolated tests (which used a never-resolving `exitPromise`),
 * these use a process whose `exitPromise` RESOLVES on `kill()` — the realistic
 * shape — and wire an `onExit` handler, so the spurious fan-out is observable.
 *
 * Red-on-injection: before the fix the fail-closed catch left `exitNotified`
 * false, so `notifyExit` fired; this test sees a `"process exit"` and fails.
 */
import { describe, expect, test } from "bun:test"
import { IsolatedMcpClient } from "@/mcp/isolated-client"
import type { IsolatedProcess, IsolatedProcessSpawnerPort } from "@/plugin-isolation"

/** Spawner whose process `exitPromise` RESOLVES the moment `kill()` is called —
 *  the realistic lifecycle (a real subprocess reaps on SIGKILL). This is what
 *  exposes the spurious notifyExit on a client-initiated teardown. */
const resolveOnKillSpawner = (
  reply: () => Record<string, unknown> | { error: { code: number; message: string } },
): IsolatedProcessSpawnerPort => ({
  spawn: async (opts) => {
    let handler: ((msg: unknown) => void) | null = null
    let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {}
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((r) => {
      resolveExit = r
    })
    const proc: IsolatedProcess = {
      pid: 1,
      serviceName: opts.serviceName,
      send: (msg: unknown) => {
        const m = msg as { id?: number; method?: string }
        if (m.method === "initialize" && typeof m.id === "number") {
          const out = reply()
          const id = m.id
          queueMicrotask(() => {
            if ("error" in out) handler?.({ jsonrpc: "2.0", id, error: out.error })
            else handler?.({ jsonrpc: "2.0", id, result: out })
          })
        }
      },
      onMessage: (h: (msg: unknown) => void) => {
        handler = h
        return () => {
          handler = null
        }
      },
      kill: async () => {
        resolveExit({ code: null, signal: "SIGKILL" })
      },
      exitPromise,
    }
    return proc
  },
})

const mkClient = (
  reply: () => Record<string, unknown> | { error: { code: number; message: string } },
): IsolatedMcpClient =>
  new IsolatedMcpClient(
    { name: "iso", command: ["bun", "x"] },
    { spawner: resolveOnKillSpawner(reply), requestTimeoutMs: 2000 },
  )

describe("IsolatedMcpClient — fail-closed must not signal a spurious exit to a wired supervisor", () => {
  test("unsupported version ⇒ rejects, but the wired onExit handler is NEVER called", async () => {
    const client = mkClient(() => ({ protocolVersion: "1999-01-01", capabilities: {} }))
    const exitReasons: (string | undefined)[] = []
    client.onExit((r) => exitReasons.push(r))

    await expect(client.start()).rejects.toThrow(/unsupported protocolVersion/)
    // flush the fire-and-forget host.stop() + exitPromise microtasks
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()

    expect(exitReasons).toEqual([])
    await client.stop()
  })

  test("a DELIBERATE stop() also stays silent on the supervisor channel", async () => {
    const client = mkClient(() => ({ protocolVersion: "2025-11-25", capabilities: {} }))
    const exitReasons: (string | undefined)[] = []
    client.onExit((r) => exitReasons.push(r))

    await client.start()
    await client.stop()
    await new Promise((r) => setTimeout(r, 0))
    expect(exitReasons).toEqual([])
  })
})
