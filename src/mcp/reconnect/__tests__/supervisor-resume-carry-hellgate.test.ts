/** §1.2 (ticket-09) — the reconnect supervisor carries the dying client's last
 *  SSE event id into the replacement (as `resumeFromEventId`) so the new GET
 *  sends `Last-Event-ID`. A client without `getLastEventId` ⇒ no resume hint
 *  (byte-identical fresh restart). */
import { describe, expect, it } from "bun:test"
import type { McpServerConfig } from "../../types"
import { DEFAULT_BACKOFF_POLICY } from "../policy"
import type { SupervisableMcpClient } from "../port"
import { McpReconnectSupervisor, type SupervisorDeps } from "../supervisor"

const makeClock = () => {
  let now = 0
  let seq = 0
  const timers: Array<{ at: number; seq: number; fn: () => void }> = []
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const e = { at: now + ms, seq: seq++, fn }
      timers.push(e)
      return () => {
        const i = timers.indexOf(e)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    advance: (ms: number) => {
      now += ms
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = due[0]
        if (next === undefined) break
        timers.splice(timers.indexOf(next), 1)
        next.fn()
      }
    },
  }
}

const makeClient = (lastEventId: string | null, hasGetter = true) => {
  const handlers = new Set<(r?: string) => void>()
  const client: SupervisableMcpClient = {
    async start() {},
    async listTools() {
      return [{ name: "echo", description: "", inputSchema: { type: "object" } }]
    },
    async callTool() {
      return { ok: true, content: "ok" }
    },
    async stop() {},
    onExit(h) {
      handlers.add(h)
      return () => handlers.delete(h)
    },
    ...(hasGetter ? { getLastEventId: () => lastEventId } : {}),
  }
  return { client, crash: (r?: string) => handlers.forEach((h) => h(r)) }
}

const CONFIG: McpServerConfig = { name: "srv", command: [], url: "https://mcp.example" }
const deps = (
  factory: SupervisorDeps["factory"],
  clock: ReturnType<typeof makeClock>,
): SupervisorDeps => ({
  factory,
  policy: DEFAULT_BACKOFF_POLICY,
  now: clock.now,
  setTimer: clock.setTimer,
  random: () => 0,
})

describe("§1.2 — supervisor carries SSE resume cursor across restart", () => {
  it("stamps the dying client's getLastEventId into the restart config", async () => {
    const clock = makeClock()
    const first = makeClient("314")
    const second = makeClient(null)
    const seen: Array<string | undefined> = []
    let i = 0
    const factory = (cfg: McpServerConfig): SupervisableMcpClient => {
      seen.push(cfg.resumeFromEventId)
      return (i++ === 0 ? first : second).client
    }
    await McpReconnectSupervisor.create(CONFIG, deps(factory, clock))

    first.crash("drop")
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()

    // first build = fresh (no seed); restart build = seeded with the cursor.
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toBe("314")
  })

  it("null cursor ⇒ no resume hint (fresh restart, byte-identical)", async () => {
    const clock = makeClock()
    const first = makeClient(null)
    const second = makeClient(null)
    const seen: Array<string | undefined> = []
    let i = 0
    const factory = (cfg: McpServerConfig): SupervisableMcpClient => {
      seen.push(cfg.resumeFromEventId)
      return (i++ === 0 ? first : second).client
    }
    await McpReconnectSupervisor.create(CONFIG, deps(factory, clock))
    first.crash("drop")
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    expect(seen[1]).toBeUndefined()
  })

  it("client without getLastEventId ⇒ no resume hint (byte-identical)", async () => {
    const clock = makeClock()
    const first = makeClient(null, false)
    const second = makeClient(null, false)
    const seen: Array<string | undefined> = []
    let i = 0
    const factory = (cfg: McpServerConfig): SupervisableMcpClient => {
      seen.push(cfg.resumeFromEventId)
      return (i++ === 0 ? first : second).client
    }
    await McpReconnectSupervisor.create(CONFIG, deps(factory, clock))
    first.crash("drop")
    clock.advance(DEFAULT_BACKOFF_POLICY.fastRetryBaseMs)
    await Promise.resolve()
    await Promise.resolve()
    expect(seen[1]).toBeUndefined()
  })
})
