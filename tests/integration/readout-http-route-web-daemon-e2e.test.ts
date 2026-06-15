/**
 * SOTA++ hellgate e2e — web-daemon read-only readout HTTP route (W2).
 *
 * The sibling unit hellgate `tests/unit/apps/web-daemon/readout-hellgate.test.ts`
 * pins the PURE `renderReadout(name, snapshot)` core only. It does NOT cross the
 * real HTTP boundary: the actual `GET /readout/:name` route in
 * `src/apps/web-daemon/server.ts` (the `requireAuth` gate, the `result.isError
 * ? 404 : 200` status mapping, and — load-bearing — the LEASE-FREE
 * `sharedSession.snapshot()` read that lets a `/state` readout succeed WHILE the
 * agent holds the session single-writer lease mid-turn) was never exercised
 * end-to-end. This file seals that route against a real ephemeral Bun.serve over
 * a real loopback socket.
 *
 * Teeth (red-on-injection — each asserts a contract that, if the route drops it,
 * turns this suite RED):
 *   HR-01  bearer auth ENFORCED: no token ⇒ 401; bad token ⇒ 401; correct token
 *          (header AND ?token query) ⇒ 200. (drop requireAuth ⇒ the 401 cases go
 *          200 ⇒ RED.)
 *   HR-02  served readout returns 200 + the LIVE snapshot fields as JSON
 *          ({wired:true,isError:false} + rendered body). (a renderer that drops
 *          state fields ⇒ RED.)
 *   HR-03  LEASE-FREE MID-TURN: with a `turn.run` genuinely in-flight (status
 *          "running", the session lease held), `GET /readout/state` still returns
 *          200 with the LIVE "running" snapshot — and resolves BEFORE the turn is
 *          released (proving the route never routed through the lease / never
 *          blocked on the turn). (route the readout through the WS lease ⇒ it
 *          would block / throw ⇒ RED.)
 *   HR-04  recognized-but-PENDING accessor (e.g. /agents) ⇒ HTTP 200 + wired:false
 *          graceful body, NOT 404. (map pending ⇒ 404 ⇒ RED.)
 *   HR-05  UNKNOWN name ⇒ 404 (typo ≠ pending), and a path the route regex does
 *          not match ⇒ plain 404 not-found (no auth bypass surface).
 *
 * Hermetic + offline: a stub RuntimeFacade (no LLM, no FS, no agent loop), real
 * sockets, `port:0` ephemeral. NO timing assertions — the mid-turn window is a
 * deterministic gate the test holds open and releases itself.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type {
  ConnectedSessionTransport,
  SessionTransport,
} from "@/ipc/session"
import type {
  SessionEvent,
  SessionSnapshotLite,
} from "@/protocol/session"
import type { SessionDispatchResult } from "@/sdk/runtime"
import { supported } from "@/protocol/session"
import { startWebDaemon } from "@/apps/web-daemon/server"
import type { WebDaemonServerConfig } from "@/apps/web-daemon/server"
import type { RuntimeFacade, RuntimeSession } from "@/sdk/runtime"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"

const handles: WebDaemonHandle[] = []

// Keep the daemon hermetic: never touch the user's real
// `~/.quanta/web-daemon/threads.db` (these tests don't exercise persistence).
const prevDbGate = process.env.QUANTA_WEB_DB
process.env.QUANTA_WEB_DB = "off"

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) await h.stop().catch(() => undefined)
  }
})

// Restore the persistence gate after the file's tests complete.
afterAll(() => {
  if (prevDbGate === undefined) delete process.env.QUANTA_WEB_DB
  else process.env.QUANTA_WEB_DB = prevDbGate
})

const CAPS = {
  approvals: "operator" as const,
  tools: true,
  memory: false,
  artifacts: true,
  subagents: true,
  automation: false,
  shellSnapshot: true,
  transport: "websocket" as const,
}

const okResult = (snap: SessionSnapshotLite): SessionDispatchResult => ({
  revision: snap.revision,
  seq: snap.seq,
  events: [],
})

/**
 * A controllable stub facade. `createSession` returns a session whose mutable
 * `snapshot` the test reads live (lease-free), and whose `turn.run` BLOCKS on a
 * gate the test releases itself — so the "mid-turn" window is deterministic with
 * zero timing assertions. The created session is captured so the test can drive
 * a real `turn.run` directly (no WS handshake needed: the route reads the
 * snapshot, not the WS channel).
 */
const createControllableFactory = (): {
  factory: () => Promise<RuntimeFacade>
  getSession: () => RuntimeSession
  /** Resolves once a turn has BEGUN running (status flipped to "running"). */
  turnRunning: () => Promise<void>
  /** Release the in-flight turn so it completes back to idle. */
  releaseTurn: () => void
} => {
  let session: RuntimeSession | undefined
  let resolveRunning: () => void = () => undefined
  let runningPromise: Promise<void> = new Promise((r) => {
    resolveRunning = r
  })
  let releaseGate: () => void = () => undefined
  const gate = (): Promise<void> => new Promise<void>((r) => (releaseGate = r))

  const factory = async (): Promise<RuntimeFacade> => ({
    createSession: async (): Promise<RuntimeSession> => {
      let snapshot: SessionSnapshotLite = {
        sessionId: "ctl-session-1",
        revision: 1,
        seq: 0,
        state: {
          status: "idle",
          draftInput: "look at this while running",
          permissionMode: "default",
          identityMode: "build",
          toolProfile: "full",
          modelSlug: "gpt-5",
          messageCount: 0,
        },
        capabilities: CAPS,
        pendingApproval: null,
        openArtifacts: [],
      }
      const listeners = new Set<(event: SessionEvent) => void>()

      const runTurn = async (): Promise<SessionDispatchResult> => {
        // Flip to "running" (this is what a held single-writer lease looks like
        // to a live snapshot read) and signal the test, then BLOCK on the gate.
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          seq: snapshot.seq + 1,
          state: { ...snapshot.state, status: "running", messageCount: 1 },
        }
        resolveRunning()
        await gate() // held open by the test until it has read the readout
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          seq: snapshot.seq + 1,
          state: {
            ...snapshot.state,
            status: "idle",
            lastOutcomeReason: "completed",
          },
        }
        return okResult(snapshot)
      }

      session = {
        sessionId: "ctl-session-1",
        snapshot: async () => snapshot,
        subscribe: (listener: (event: SessionEvent) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        // The daemon attaches a WS transport on connect; we never drive the WS
        // channel in these tests, so a no-op connected transport is enough.
        attachSessionTransport: async (
          _transport: SessionTransport,
        ): Promise<ConnectedSessionTransport> =>
          ({ close: async () => undefined }) as unknown as ConnectedSessionTransport,
        dispatch: async () => okResult(snapshot),
        close: async () => {
          listeners.clear()
        },
        input: { append: async () => okResult(snapshot) },
        turn: { run: async () => await runTurn() },
        identity: { set: async () => okResult(snapshot) },
        toolProfile: { set: async () => okResult(snapshot) },
        permission: { set: async () => okResult(snapshot) },
        approval: { respond: async () => okResult(snapshot) },
        transcript: { replace: async () => okResult(snapshot) },
        side: {
          start: async () =>
            ({
              outcome: {
                messages: [],
                reason: "stop",
                turns: 0,
                tokens: { input: 0, output: 0 },
              },
              answerText: "",
              inputTokens: 0,
              outputTokens: 0,
              toolsAvailable: 0,
            }) as unknown as Awaited<ReturnType<RuntimeSession["side"]["start"]>>,
        },
      } as unknown as RuntimeSession
      return session
    },
    close: async () => {
      await session?.close()
    },
  })

  return {
    factory,
    getSession: () => {
      if (session === undefined) throw new Error("session not created yet")
      return session
    },
    turnRunning: () => runningPromise,
    releaseTurn: () => releaseGate(),
  }
}

const boot = async (over: {
  factory: () => Promise<RuntimeFacade>
  authToken?: string | undefined
}): Promise<WebDaemonHandle> => {
  const config: WebDaemonServerConfig = {
    port: 0,
    bind: "127.0.0.1",
    authToken: over.authToken,
    runtimeFactory: over.factory,
    sessionConfig: {},
    supportedReadModels: {
      session: supported("session.v1"),
      agentState: { status: "unsupported" },
      canvas: { status: "unsupported" },
      observability: { status: "unsupported" },
    },
  }
  const handle = await startWebDaemon(config)
  handles.push(handle)
  return handle
}

interface ReadoutBody {
  name: string
  output: string
  isError: boolean
  wired: boolean
}

describe("GET /readout/:name — real HTTP route (web daemon)", () => {
  test("HR-01: bearer auth is ENFORCED (401 without/with-wrong token, 200 with header AND ?token)", async () => {
    const { factory } = createControllableFactory()
    const handle = await boot({ factory, authToken: "s3cr3t-token" })
    const base = `http://127.0.0.1:${handle.port}/readout/state`

    // No token ⇒ 401 (if requireAuth is dropped this becomes 200 ⇒ RED).
    const noAuth = await fetch(base)
    expect(noAuth.status).toBe(401)

    // Wrong token ⇒ 401.
    const badAuth = await fetch(base, { headers: { authorization: "Bearer nope" } })
    expect(badAuth.status).toBe(401)

    // Correct token via Authorization header ⇒ 200.
    const headerAuth = await fetch(base, {
      headers: { authorization: "Bearer s3cr3t-token" },
    })
    expect(headerAuth.status).toBe(200)

    // Correct token via ?token query (browsers can't set upgrade headers) ⇒ 200.
    const queryAuth = await fetch(`${base}?token=s3cr3t-token`)
    expect(queryAuth.status).toBe(200)
  })

  test("HR-02: served /state returns 200 + the LIVE snapshot fields as JSON", async () => {
    const { factory } = createControllableFactory()
    const handle = await boot({ factory, authToken: undefined })

    const res = await fetch(`http://127.0.0.1:${handle.port}/readout/state`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as ReadoutBody
    expect(body.wired).toBe(true)
    expect(body.isError).toBe(false)
    expect(body.name).toBe("state")
    // The body is rendered from the LIVE snapshot — its concrete fields surface.
    expect(body.output).toContain("idle") // status before any turn
    expect(body.output).toContain("build") // identityMode
    expect(body.output).toContain("gpt-5") // modelSlug

    // /capabilities is the other served readout — also 200 + wired.
    const caps = await fetch(`http://127.0.0.1:${handle.port}/readout/capabilities`)
    const capsBody = (await caps.json()) as ReadoutBody
    expect(caps.status).toBe(200)
    expect(capsBody.wired).toBe(true)
    expect(capsBody.output).toContain("websocket")
  })

  test("HR-03: LEASE-FREE mid-turn — /readout/state returns 200 + LIVE 'running' snapshot WHILE a turn is in flight", async () => {
    const ctl = createControllableFactory()
    const handle = await boot({ factory: ctl.factory, authToken: undefined })

    // Kick off a turn that BLOCKS on the gate; do NOT await it (it holds the
    // lease open). Drive it directly on the captured session — the readout route
    // reads the snapshot, never the WS channel, so no handshake is needed.
    const turnDone = ctl.getSession().turn.run()
    let turnSettled = false
    void turnDone.then(() => {
      turnSettled = true
    })

    // Wait (deterministically — a gate signal, NOT a timer) until the turn has
    // actually entered "running" and is parked on the gate.
    await ctl.turnRunning()
    expect(turnSettled).toBe(false) // the turn is still in flight (lease held)

    // Hit the readout route WHILE the turn is mid-flight. If the route routed
    // through the WS single-writer lease, this would block or 5xx; lease-free it
    // returns 200 with the LIVE "running" snapshot.
    const res = await fetch(`http://127.0.0.1:${handle.port}/readout/state`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReadoutBody
    expect(body.wired).toBe(true)
    expect(body.isError).toBe(false)
    expect(body.output).toContain("running") // LIVE mid-turn status

    // The readout resolved while the turn was STILL blocked (never released yet)
    // — the strongest proof the route did not wait on / contend with the turn.
    expect(turnSettled).toBe(false)

    // Now release the turn and let it complete back to idle.
    ctl.releaseTurn()
    await turnDone
    expect(turnSettled).toBe(true)

    // Post-turn the live snapshot moved to idle — the lease-free read tracks it.
    const after = await fetch(`http://127.0.0.1:${handle.port}/readout/state`)
    const afterBody = (await after.json()) as ReadoutBody
    expect(afterBody.output).toContain("idle")
  })

  test("HR-04: recognized-but-PENDING accessor ⇒ HTTP 200 + wired:false graceful (NOT 404)", async () => {
    const { factory } = createControllableFactory()
    const handle = await boot({ factory, authToken: undefined })

    for (const name of ["agents", "plan", "branches", "skills", "mcp", "memory", "why", "cost", "context"]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}/readout/${name}`)
      // Pending ≠ error: graceful 200, NOT 404 (mapping pending → 404 ⇒ RED).
      expect(res.status, `${name} pending ⇒ 200`).toBe(200)
      const body = (await res.json()) as ReadoutBody
      expect(body.wired, `${name} not wired here yet`).toBe(false)
      expect(body.isError, `${name} graceful, not an error`).toBe(false)
      expect(body.output).toContain("not wired")
    }
  })

  test("HR-05: UNKNOWN readout name ⇒ 404 (typo); a non-matching path ⇒ plain 404", async () => {
    const { factory } = createControllableFactory()
    const handle = await boot({ factory, authToken: undefined })

    // A name the regex matches but renderReadout rejects ⇒ isError ⇒ 404.
    const unknown = await fetch(`http://127.0.0.1:${handle.port}/readout/doesnotexist`)
    expect(unknown.status).toBe(404)
    const body = (await unknown.json()) as ReadoutBody
    expect(body.isError).toBe(true)
    expect(body.output).toContain("unknown")

    // A path that does NOT match the `/^\/readout\/([a-z-]+)$/` route (digits /
    // nested segment) is not a readout at all ⇒ falls through to plain 404.
    const nested = await fetch(`http://127.0.0.1:${handle.port}/readout/state/extra`)
    expect(nested.status).toBe(404)
  })
})
