/**
 * ★ HELLGATE — GOAL-08 rail 15 (web half) through a REAL WebSocket into a REAL
 * `startWebDaemon`, over a REAL runtime (real objective authority + attempt
 * slot + host adapter + kernel claim + turn runner).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `submitGoalWork` (the host verb that mints `user-requested-goal-work`
 * provenance) had ZERO production callers: the web surface could not ask for a
 * user goal turn at all. The in-process tests around this feature prove the
 * decoder, the composed handler, and the `message()` routing separately — none
 * proves that `startWebDaemon` COMPOSES the handler from the runtime's ports
 * and WIRES it into the connection config. A regression that dropped either
 * (composition or wiring) leaves every in-process test green while a real
 * client's `/goal work` frame silently falls through to the session bridge.
 *
 * WHAT THIS DRIVES: a real TCP WS frame → Bun `websocket.message()` → the
 * daemon's real `ws-handlers` → `consumeGoalWorkFrame` → the REAL composed
 * handler → `RuntimeSession.turn.submitGoalWork` → kernel claim → host turn →
 * settlement on the REAL authority. Ground truth is the authority's own budget
 * + receipts (a user turn, never the autonomous hard-cap counter) and the ack
 * frame that comes back on the same socket.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { startWebDaemon } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"
import type { PermissionContext } from "@/permission"
import { supported } from "@/protocol/session"
import { createRuntimeFromAgentConfigBase, type RuntimeSession } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class EchoLLM implements LLMPort {
  readonly model = "echo"
  readonly seen: string[] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(JSON.stringify(input.messages))
    yield { type: "text_delta", delta: "ok" } satisfies StreamEvent
    yield { type: "usage", inputTokens: 4, outputTokens: 2, model: "echo" } as never
    yield { type: "message_stop", stop_reason: "end_turn" } satisfies StreamEvent
  }
}
class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const handles: WebDaemonHandle[] = []
const sockets: WebSocket[] = []

// Hermetic: never touch the developer's real thread DB (the daemon's SQLite
// persistence is DEFAULT-ON, so an unguarded boot appends to ~/.quanta).
const prevWebDb = process.env.QUANTA_WEB_DB
beforeAll(() => {
  process.env.QUANTA_WEB_DB = "off"
})
afterAll(() => {
  if (prevWebDb === undefined) delete process.env.QUANTA_WEB_DB
  else process.env.QUANTA_WEB_DB = prevWebDb
})

/** macOS Bun can HANG on a web-daemon session-swap during `stop()`. Cap it so a
 *  hang fails this file instead of wedging the whole run (sibling precedent). */
const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close()
    } catch {
      // already closed
    }
  }
  for (const handle of handles.splice(0)) await withTimeout(handle.stop(), 10_000, "daemon.stop")
})

/** A REAL runtime facade (the production composition of authority + attempt
 *  slot + host adapter), exposed on the facade exactly as the daemon's own
 *  production factory exposes it (`objectivePorts`). */
const bootDaemon = async () => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  const slot = createObjectiveAttemptSlot()
  const llm = new EchoLLM()
  const { runtimeContext } = await createRuntimeFromAgentConfigBase({
    base: {
      llm,
      registry: new ToolRegistry([]),
      stream: new NullStream(),
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [],
      system: "test",
      cwd: "/tmp",
      maxTurns: 8,
      signal: new AbortController().signal,
      objective: authority,
      objectiveAttemptSlot: slot,
    },
    turnAssembler: buildInteractiveTurnAssembler({}, {}),
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  const runtime = await runtimeContext.createRuntimeFacade({
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
    mcpClients: [],
  })
  let created: RuntimeSession | undefined
  const handle = await startWebDaemon({
    port: 0,
    bind: "127.0.0.1",
    authToken: undefined,
    runtimeFactory: async () =>
      ({
        ...runtime,
        objectiveAuthority: authority,
        objectiveAttemptSlot: slot,
        createSession: async (config: Parameters<typeof runtime.createSession>[0]) => {
          created = await runtime.createSession(config)
          return created
        },
      }) as never,
    sessionConfig: { cwd: "/tmp", permissionMode: "acceptEdits" } as never,
    supportedReadModels: {
      session: supported("session.v1"),
      agentState: { status: "unsupported" },
      canvas: { status: "unsupported" },
      observability: { status: "unsupported" },
    },
  })
  handles.push(handle)
  if (created === undefined) throw new Error("daemon did not create a session")
  return { authority, slot, llm, handle, session: created }
}

const connect = async (handle: WebDaemonHandle) => {
  const ws = new WebSocket(`ws://${handle.hostname}:${handle.port}/`)
  sockets.push(ws)
  const frames: Record<string, unknown>[] = []
  ws.addEventListener("message", (event) => {
    try {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>)
    } catch {
      // non-JSON frames are not this test's business
    }
  })
  await new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true })
  })
  // No settle-wait needed: `open()` attaches the adapter synchronously before
  // its first await, and the goal-work handler is composed at daemon boot.
  return { ws, frames, results: () => frames.filter((f) => f.kind === "goalWorkResult") }
}

const until = async (pred: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return pred()
}

describe("GOAL-08 rail 15 — a real client's /goal work frame runs an attributed turn", () => {
  test("active goal: the daemon accepts on the socket and the turn charges the USER budget only", async () => {
    const { authority, slot, llm, handle, session } = await bootDaemon()
    authority.create(session.sessionId, { goal: "ship", successCriteria: ["c"] })
    const client = await connect(handle)

    client.ws.send(JSON.stringify({ kind: "goalWork", text: "fix the flake" }))
    expect(await until(() => client.results().length > 0)).toBe(true)
    expect(client.results()[0]).toMatchObject({ ok: true, status: "accepted" })

    // Wait for SETTLEMENT (the receipt), not just the durable start.
    expect(
      await until(
        () => (authority.readDomain(session.sessionId).progressReceipts ?? []).length > 0,
      ),
    ).toBe(true)
    const objective = authority.get(session.sessionId)
    expect(objective?.budget.turnsUsed).toBe(1)
    expect(objective?.attempts.autonomousTurnsStarted).toBe(0)
    const receipts = authority.readDomain(session.sessionId).progressReceipts ?? []
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.turnOutcome).toBe("completed")
    expect(llm.seen.some((m) => m.includes("fix the flake"))).toBe(true)
    expect(await until(() => slot.status().kind === "empty")).toBe(true)
    // EXACTLY one frame for a turn that ran: the accept, and nothing else.
    expect(client.results()).toEqual([{ kind: "goalWorkResult", ok: true, status: "accepted" }])
  }, 30_000)

  test("no goal yet: the client is told WHY on the same socket and no turn runs", async () => {
    const { authority, llm, handle, session } = await bootDaemon()
    const client = await connect(handle)

    client.ws.send(JSON.stringify({ kind: "goalWork", text: "anything" }))
    expect(await until(() => client.results().length > 0)).toBe(true)
    expect(client.results()).toHaveLength(1)
    expect(client.results()[0]).toMatchObject({ ok: false })
    expect(String(client.results()[0]?.reason)).toContain("not active")
    expect(llm.seen).toEqual([])
    expect(authority.readDomain(session.sessionId).progressReceipts ?? []).toHaveLength(0)
  }, 30_000)
})
