/**
 * ★ HELLGATE — the browser's goal CONTROL verbs through a REAL WebSocket into a
 * REAL `startWebDaemon`, over a REAL objective authority.
 *
 * THE CLAIM THIS PROVES
 * ---------------------
 * That `/goal pause | resume | edit | clear` needs NO new protocol, NO new
 * kernel path and NO permission change — only a caller. Every unit test around
 * this feature proves a piece in isolation (the parser, the verb table, the
 * hook, the palette). None proves that a real `session.objective.mutate` frame,
 * sent by a real client over TCP, reaches the authority bound to the USER actor
 * and to THIS session, and moves the durable state.
 *
 * WHAT THIS DRIVES: a real TCP WS frame → Bun `websocket.message()` → the
 * session bridge → the kernel scheduler → `applyHostObjectiveMutation` → the
 * REAL authority. Ground truth is the authority's own domain snapshot
 * (status, goal text, revision), never an echo.
 *
 * IT ALSO PINS THE REFUSALS, which are the half a caller cannot fake:
 *   - a definition cannot be replaced or cleared under a started attempt, and
 *     that refusal arrives as a `rejected` frame carrying the AUTHORITY's own
 *     tag (`objective:attempt-in-flight`), not a flattened `dispatch_failed`;
 *   - a refused mutation changes nothing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { startWebDaemon } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  createObjectiveAttemptSlot,
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveAuthority,
} from "@/objective"
import type { PermissionContext } from "@/permission"
import { SESSION_PROTOCOL_VERSION, supported } from "@/protocol/session"
import { createRuntimeFromAgentConfigBase, type RuntimeSession } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class EchoLLM implements LLMPort {
  readonly model = "echo"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "ok" } satisfies StreamEvent
    yield { type: "message_stop", stop_reason: "end_turn" } satisfies StreamEvent
  }
}
class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const handles: WebDaemonHandle[] = []
const sockets: WebSocket[] = []

const prevWebDb = process.env.QUANTA_WEB_DB
beforeAll(() => {
  process.env.QUANTA_WEB_DB = "off"
})
afterAll(() => {
  if (prevWebDb === undefined) delete process.env.QUANTA_WEB_DB
  else process.env.QUANTA_WEB_DB = prevWebDb
})

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

const bootDaemon = async () => {
  const authority = createObjectiveAuthority({ now: () => 1 })
  const slot = createObjectiveAttemptSlot()
  const { runtimeContext } = await createRuntimeFromAgentConfigBase({
    base: {
      llm: new EchoLLM(),
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
  return { authority, slot, handle, session: created }
}

const until = async (pred: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return pred()
}

/** Connect and complete the handshake exactly as the browser client does:
 *  a discovery `connect` provokes a `rejected` frame carrying the canonical
 *  session id, then a real `connect` yields the snapshot. */
const connect = async (handle: WebDaemonHandle, sessionId: string) => {
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
  ws.send(JSON.stringify({ version: SESSION_PROTOCOL_VERSION, kind: "connect", sessionId }))
  const ready = await until(() => frames.some((f) => f.kind === "snapshot"))
  if (!ready) throw new Error("no snapshot after connect")
  return {
    ws,
    frames,
    rejected: () => frames.filter((f) => f.kind === "rejected" && f.target === "command"),
    mutate: (mutation: unknown, commandId: string): void => {
      ws.send(
        JSON.stringify({
          version: SESSION_PROTOCOL_VERSION,
          kind: "command",
          payload: {
            sessionId,
            commandId,
            issuedAt: new Date().toISOString(),
            type: "session.objective.mutate",
            mutation,
          },
        }),
      )
    },
  }
}

const domainOf = (authority: ObjectiveAuthority, threadId: string) =>
  createObjectiveCapabilities(authority).read.readDomain(threadId)

describe("web goal control — a real client drives the full lifecycle", () => {
  test("create → pause → resume → edit → clear, each observed on the REAL authority", async () => {
    const { authority, handle, session } = await bootDaemon()
    const thread = session.sessionId
    const client = await connect(handle, thread)

    // CREATE — the browser's only route to a goal (a model `create` is refused
    // on this surface in either gate posture).
    client.mutate({ kind: "create", definition: { goal: "ship the release" } }, "c-create")
    expect(await until(() => authority.get(thread)?.goal === "ship the release")).toBe(true)
    const afterCreate = domainOf(authority, thread).revision
    expect(authority.get(thread)?.status).toBe("active")
    expect(authority.get(thread)?.createdBy).toBe("user")

    // PAUSE
    client.mutate({ kind: "setExplicitStatus", status: "paused" }, "c-pause")
    expect(await until(() => authority.get(thread)?.status === "paused")).toBe(true)
    expect(domainOf(authority, thread).revision).toBeGreaterThan(afterCreate)

    // RESUME
    client.mutate({ kind: "setExplicitStatus", status: "active" }, "c-resume")
    expect(await until(() => authority.get(thread)?.status === "active")).toBe(true)

    // EDIT — a replace mints a NEW generation.
    const generationBefore = authority.get(thread)?.objectiveId
    client.mutate({ kind: "replace", definition: { goal: "ship v2" } }, "c-edit")
    expect(await until(() => authority.get(thread)?.goal === "ship v2")).toBe(true)
    expect(authority.get(thread)?.objectiveId).not.toBe(generationBefore)

    // CLEAR
    client.mutate({ kind: "clear" }, "c-clear")
    expect(await until(() => authority.get(thread) === null)).toBe(true)

    // Nothing was refused along the way.
    expect(client.rejected()).toEqual([])
  }, 30_000)

  test("under a started attempt, edit and clear are REFUSED with the authority's own tag", async () => {
    const { authority, handle, session } = await bootDaemon()
    const thread = session.sessionId
    authority.create(thread, { goal: "ship the release", successCriteria: ["c"] })
    const caps = createObjectiveCapabilities(authority)
    const started = caps.system.commit(thread, {
      kind: "beginAttempt",
      attempt: {
        objectiveId: authority.get(thread)?.objectiveId ?? "",
        attemptId: "a1",
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: domainOf(authority, thread).revision,
      },
    })
    expect(started.ok).toBe(true)

    const client = await connect(handle, thread)
    const before = domainOf(authority, thread).revision

    client.mutate({ kind: "clear" }, "c-blocked-clear")
    expect(await until(() => client.rejected().length >= 1)).toBe(true)

    const frame = client.rejected()[0]
    // The refusal carries WHICH refusal it was — not `dispatch_failed`, which is
    // also what a host crash produces.
    expect(frame?.reason).toBe("protocol_validation")
    expect(String(frame?.issue)).toBe("objective:attempt-in-flight")

    // A refused mutation changes nothing: same goal, same revision.
    expect(authority.get(thread)?.goal).toBe("ship the release")
    expect(domainOf(authority, thread).revision).toBe(before)
  }, 30_000)

  test("abandon frees a stuck attempt, and the edit that was refused then works", async () => {
    const { authority, handle, session } = await bootDaemon()
    const thread = session.sessionId
    authority.create(thread, { goal: "ship the release", successCriteria: ["c"] })
    const caps = createObjectiveCapabilities(authority)
    // A crash between beginAttempt and settlement leaves this behind; from here
    // the definition can be neither replaced nor cleared.
    caps.system.commit(thread, {
      kind: "beginAttempt",
      attempt: {
        objectiveId: authority.get(thread)?.objectiveId ?? "",
        attemptId: "a-stuck",
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: domainOf(authority, thread).revision,
      },
    })
    const client = await connect(handle, thread)

    client.mutate({ kind: "abandonAttempt" }, "c-abandon")
    expect(await until(() => authority.get(thread)?.attempts.started === undefined)).toBe(true)

    // The turn really ran, so the reserved turn is NOT refunded — only the lock
    // is freed. That is the whole contract of abandon.
    expect(authority.get(thread)?.budget.turnsUsed).toBe(1)

    client.mutate({ kind: "replace", definition: { goal: "ship v2" } }, "c-edit-after")
    expect(await until(() => authority.get(thread)?.goal === "ship v2")).toBe(true)
    expect(client.rejected()).toEqual([])
  }, 30_000)

  test("budget amends the cap the operator declared, and the store keeps the number", async () => {
    const { authority, handle, session } = await bootDaemon()
    const thread = session.sessionId
    authority.create(thread, {
      goal: "ship the release",
      successCriteria: ["c"],
      budget: { maxTurns: 3 },
    })
    const client = await connect(handle, thread)

    client.mutate({ kind: "amendBudget", budget: { maxTurns: 50 } }, "c-budget")
    expect(await until(() => authority.get(thread)?.budget.maxTurns === 50)).toBe(true)

    // Stored VERBATIM — the product ceiling is derived at read time, never
    // written into the operator's own number.
    expect(authority.get(thread)?.budget.maxTurns).toBe(50)
    expect(client.rejected()).toEqual([])
  }, 30_000)

  test("a policy refusal names itself: resuming a goal that has no live objective", async () => {
    const { authority, handle, session } = await bootDaemon()
    const thread = session.sessionId
    const client = await connect(handle, thread)

    // No objective on this thread at all.
    client.mutate({ kind: "setExplicitStatus", status: "active" }, "c-no-objective")
    expect(await until(() => client.rejected().length >= 1)).toBe(true)

    expect(String(client.rejected()[0]?.issue)).toMatch(/^objective:/)
    expect(authority.get(thread)).toBeNull()
  }, 30_000)
})
