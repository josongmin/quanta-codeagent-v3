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
import type { WebDaemonServerConfig } from "@/apps/web-daemon/server"
import { startWebDaemon } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import type { ConnectedSessionTransport, SessionTransport } from "@/ipc/session"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { supported } from "@/protocol/session"
import type { RuntimeFacade, RuntimeSession, SessionDispatchResult } from "@/sdk/runtime"
import { capabilitiesFor, makeSnapshotLite } from "../support/session-fixtures"

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

const CAPS = capabilitiesFor({
  approvals: "operator",
  tools: true,
  artifacts: true,
  subagents: true,
  shellSnapshot: true,
  transport: "websocket",
})

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
  /** UUX-1-11 — push a SessionEvent to every live subscriber (feeds the
   *  server-side `/cost` fold exactly the way the real session would). */
  emitEvent: (event: SessionEvent) => void
} => {
  let session: RuntimeSession | undefined
  let resolveRunning: () => void = () => undefined
  const runningPromise: Promise<void> = new Promise((r) => {
    resolveRunning = r
  })
  let releaseGate: () => void = () => undefined
  const gate = (): Promise<void> => new Promise<void>((r) => (releaseGate = r))
  const listenersRef: { current: Set<(event: SessionEvent) => void> } = { current: new Set() }

  const factory = async (): Promise<RuntimeFacade> => ({
    createSession: async (): Promise<RuntimeSession> => {
      let snapshot: SessionSnapshotLite = makeSnapshotLite({
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
      })
      const listeners = listenersRef.current

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
    emitEvent: (event: SessionEvent) => {
      for (const listener of listenersRef.current) listener(event)
    },
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

  test("HR-04: recognized name WITHOUT a composed source ⇒ HTTP 200 + wired:false copy naming the gap (NOT 404)", async () => {
    const { factory } = createControllableFactory()
    const handle = await boot({ factory, authToken: undefined })

    // UUX-1-11 — this stub facade exposes NO `readoutSources`, so every
    // facade-backed readout degrades to the honest missing-source line. `/cost`
    // is SERVER-owned (the daemon folds `turn.completed` usage itself) so it is
    // wired even against a stub facade — asserted separately below.
    for (const name of [
      "agents",
      "plan",
      "branches",
      "skills",
      "mcp",
      "memory",
      "why",
      "context",
    ]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}/readout/${name}`)
      // Source-absent ≠ error: graceful 200, NOT 404 (mapping it → 404 ⇒ RED).
      expect(res.status, `${name} source absent ⇒ 200`).toBe(200)
      const body = (await res.json()) as ReadoutBody
      expect(body.wired, `${name} not wired here`).toBe(false)
      expect(body.isError, `${name} graceful, not an error`).toBe(false)
      expect(body.output, `${name} copy names itself`).toContain(name)
      expect(body.output.length, `${name} real copy, not a stub token`).toBeGreaterThan(20)
    }

    // `/cost` — server-owned fold: wired with honest zero totals (no turns yet).
    const cost = await fetch(`http://127.0.0.1:${handle.port}/readout/cost`)
    expect(cost.status).toBe(200)
    const costBody = (await cost.json()) as ReadoutBody
    expect(costBody.wired).toBe(true)
    expect(costBody.isError).toBe(false)
    expect(costBody.output).toContain("no completed turns yet")
  })

  test("HR-06 UUX-1-11: a facade with readout sources serves LIVE data; a THROWING source degrades to 200 (never 500)", async () => {
    const { factory } = createControllableFactory()
    // Wrap the stub factory so the returned facade ALSO exposes readoutSources —
    // one healthy accessor (plan) and one that throws host-side (agents).
    const sourcedFactory = async (): Promise<RuntimeFacade> => {
      const facade = await factory()
      Object.defineProperty(facade, "readoutSources", {
        get: () => ({
          plan: () => null,
          agents: () => {
            throw new Error("registry exploded mid-read")
          },
        }),
        enumerable: true,
      })
      return facade
    }
    const handle = await boot({ factory: sourcedFactory, authToken: undefined })

    // Healthy source ⇒ wired:true live body (the stub-era "not wired" line is dead).
    const plan = await fetch(`http://127.0.0.1:${handle.port}/readout/plan`)
    expect(plan.status).toBe(200)
    const planBody = (await plan.json()) as ReadoutBody
    expect(planBody.wired).toBe(true)
    expect(planBody.isError).toBe(false)
    expect(planBody.output).toContain("no plan yet")

    // Throwing source ⇒ graceful 200 payload carrying the failure, NEVER a 500.
    const agents = await fetch(`http://127.0.0.1:${handle.port}/readout/agents`)
    expect(agents.status).toBe(200)
    const agentsBody = (await agents.json()) as ReadoutBody
    expect(agentsBody.wired).toBe(false)
    expect(agentsBody.isError).toBe(false)
    expect(agentsBody.output).toContain("registry exploded mid-read")
  })

  test("HR-07 UUX-1-11: the server-owned /cost fold accumulates turn.completed usage", async () => {
    const ctl = createControllableFactory()
    const handle = await boot({ factory: ctl.factory, authToken: undefined })

    // Feed the shared session two completed turns the way the real kernel
    // emits them (the daemon subscribed at boot — the fold sees these).
    ctl.emitEvent({
      type: "turn.completed",
      eventId: "tc-1",
      seq: 10,
      revision: 2,
      emittedAt: "2026-07-10T00:00:01.000Z",
      outcomeReason: "completed",
      tokenUsage: { promptTokens: 100, completionTokens: 40, totalTokens: 140, costMicroUsd: 700 },
      modelSlug: "gpt-5",
    })
    ctl.emitEvent({
      type: "turn.completed",
      eventId: "tc-2",
      seq: 11,
      revision: 3,
      emittedAt: "2026-07-10T00:00:02.000Z",
      outcomeReason: "completed",
      tokenUsage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    })
    // Non-usage events must NOT count as turns.
    ctl.emitEvent({
      type: "turn.output.delta",
      eventId: "d-1",
      seq: 12,
      revision: 3,
      emittedAt: "2026-07-10T00:00:03.000Z",
      delta: "x",
    })

    const res = await fetch(`http://127.0.0.1:${handle.port}/readout/cost`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReadoutBody
    expect(body.wired).toBe(true)
    expect(body.output).toMatch(/turns\s+2/)
    expect(body.output).toMatch(/prompt tokens\s+150/)
    expect(body.output).toMatch(/completion tokens\s+50/)
    expect(body.output).toMatch(/total tokens\s+200/)
    expect(body.output).toContain("0.0007") // 700 µUSD
    expect(body.output).toContain("gpt-5")
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
