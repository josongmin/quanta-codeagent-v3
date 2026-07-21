/**
 * DOF-10 — AUTHENTICATED operator flow closeout (real daemon, real WS, real
 * DOF-05 bind/auth gate).
 *
 * This is the END-TO-END closure proof for the web operator surface. It boots a
 * REAL `Bun.serve` daemon via `startWebDaemon` with an `authToken` set (so the
 * DOF-05 bearer gate is LIVE, not bypassed by a loopback-only carve-out) and
 * drives ONE authenticated operator flow across every frame/verb on ONE
 * revision through the REAL WebSocket transport:
 *
 *   auth handshake (?token=)          → DOF-05 gate (makeTryUpgrade)
 *     → session create/use            → connect ⇒ snapshot frame
 *       → turn streaming              → input.append + turn.run ⇒ delta/completed
 *         → approval verb             → approval.respond command ⇒ host resolver
 *           → observability frame     → observability.snapshot (real run-ledger)
 *             → canvas frame          → context.usage (real usage source)
 *
 * The real consumer for each side-channel frame is the frontend `SessionClient`
 * envelope decoder — we assert the EXACT wire bytes the daemon emits decode
 * through the SAME `@/protocol/*` codecs that `apps/web-frontend/src/ws/client.ts`
 * calls (`decodeObservabilityFrame` / `decodeCanvasFrame` / the session
 * transport decoder). A stubbed emitter that sent nothing would fail these.
 *
 * AUTH IS EXERCISED, NOT BYPASSED:
 *   - the authenticated flow connects with `?token=<secret>` and gets a snapshot
 *   - the negative control connects with a WRONG token and is REJECTED (the WS
 *     `open` never fires; the upgrade 401s)
 *   - the "unauthorized reconnect" edge reconnects with a MISSING token ⇒ reject
 *   - red-on-injection: a mutated (wrong) token presented against the live gate
 *     is rejected — proving the compare is load-bearing, not vacuous
 *
 * 4 EXPLICIT-BEHAVIOR EDGE CASES (each asserts REAL behavior, not no-throw):
 *   1. disconnect/backpressure — after ws.close(), the daemon's per-connection
 *      sinks stop and the session count returns to 0 (no frame targets a dead
 *      socket); a fresh authed reconnect still streams a turn.
 *   2. stale approval id — an `approval.respond` for an id the host never minted
 *      is handled by the resolver and does NOT crash the session; a subsequent
 *      real turn still streams (the wire stayed live).
 *   3. unauthorized reconnect — a reconnect with a bad/missing token is rejected
 *      at the gate (paired negative control).
 *   4. dropped canvas event — a canvas frame emitted to a DEAD socket is dropped
 *      WITHOUT breaking the shared source's fan-out to a LIVE sibling connection.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { ContextUsageBreakdown } from "@/agent/context/usage-breakdown"
import { createRunLedger } from "@/agent/run-ledger"
import type { AgentStatePorts, CanvasPorts, ObservabilityPorts } from "@/apps/web-daemon/server"
import { startWebDaemon } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import type { SessionTransportMessage } from "@/ipc/session"
import { encodeSessionTransportMessage, tryDecodeSessionTransportMessage } from "@/ipc/session"
import { decodeCanvasFrame } from "@/protocol/canvas"
import { decodeObservabilityFrame } from "@/protocol/observability"
import { supported } from "@/protocol/session"
import type { RuntimeFacade } from "@/sdk/runtime"
import { createStubRuntimeFactory } from "./fixture"

const SECRET = "operator-secret-token-abc123"

const handles: WebDaemonHandle[] = []
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) await h.stop().catch(() => undefined)
  }
})

const waitForOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true })
  })

const waitForMessage = (
  ws: WebSocket,
  predicate: (msg: SessionTransportMessage) => boolean,
  timeoutMs = 2000,
): Promise<SessionTransportMessage> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage)
      reject(new Error("waitForMessage: timed out"))
    }, timeoutMs)
    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") return
      const msg = tryDecodeSessionTransportMessage(event.data)
      if (msg === undefined) return
      if (!predicate(msg)) return
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage)
      resolve(msg)
    }
    ws.addEventListener("message", onMessage)
  })

/** Collect EVERY raw text frame (side-channel envelopes are NOT session-transport
 *  frames, so `tryDecode` returns undefined — we keep the raw string). */
const collectRaw = (ws: WebSocket): string[] => {
  const frames: string[] = []
  ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") frames.push(event.data)
  })
  return frames
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A captured-timer bundle so the test can fire the observability emitter's tick
 *  DETERMINISTICALLY (the per-connection emitter forwards its tick's snapshot to
 *  ws.send). One shared object ⇒ a single-connection e2e captures exactly one cb. */
const captureTimer = (): {
  timer: NonNullable<ObservabilityPorts["timer"]>
  fire: () => void
} => {
  let captured: (() => void) | undefined
  return {
    timer: {
      setInterval: (cb: () => void): unknown => {
        captured = cb
        return 1
      },
      clearInterval: (): void => undefined,
    },
    fire: () => captured?.(),
  }
}

/** A canvas usage source whose `latest()` returns a REAL breakdown (⇒ the
 *  connection forwards a `context.usage` frame on connect) and whose `subscribe`
 *  fan-out we can push through for the dropped-event edge case. */
const makeUsageSource = (
  initial: ContextUsageBreakdown,
): {
  ports: CanvasPorts
  push: (view: ContextUsageBreakdown) => void
} => {
  const listeners = new Set<(v: ContextUsageBreakdown) => void>()
  return {
    ports: {
      usageSource: {
        subscribe(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
        latest: () => initial,
      },
    },
    push: (view) => {
      for (const l of [...listeners]) l(view)
    },
  }
}

const REAL_USAGE: ContextUsageBreakdown = {
  segments: [{ id: "System", tokens: 42, chars: 42, color: "cyan" }],
  total: 42,
  max: 1000,
  model: "stub-model",
}

const bootAuthed = async (opts?: {
  observabilityPorts?: ObservabilityPorts
  canvasPorts?: CanvasPorts
  agentStatePorts?: AgentStatePorts
  factory?: () => Promise<RuntimeFacade>
}): Promise<{ handle: WebDaemonHandle; port: number }> => {
  const { factory } = createStubRuntimeFactory()
  const handle = await startWebDaemon({
    port: 0,
    bind: "127.0.0.1",
    authToken: SECRET,
    runtimeFactory: opts?.factory ?? factory,
    sessionConfig: {},
    supportedReadModels: {
      session: supported("session.v1"),
      agentState: supported("agent-state.v1"),
      canvas: supported("canvas.v1"),
      observability: supported("observability.v1"),
    },
    ...(opts?.observabilityPorts !== undefined
      ? { observabilityPorts: opts.observabilityPorts }
      : {}),
    ...(opts?.canvasPorts !== undefined ? { canvasPorts: opts.canvasPorts } : {}),
    ...(opts?.agentStatePorts !== undefined ? { agentStatePorts: opts.agentStatePorts } : {}),
  })
  handles.push(handle)
  return { handle, port: handle.port }
}

const authedUrl = (port: number, token = SECRET): string =>
  `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`

const drainTurn = async (ws: WebSocket): Promise<SessionTransportMessage> => {
  const issuedAt = new Date().toISOString()
  ws.send(
    encodeSessionTransportMessage({
      kind: "command",
      command: {
        sessionId: "stub-session-1",
        commandId: `append-${Math.random()}`,
        issuedAt,
        type: "input.append",
        text: "hello",
      },
    }),
  )
  ws.send(
    encodeSessionTransportMessage({
      kind: "command",
      command: {
        sessionId: "stub-session-1",
        commandId: `run-${Math.random()}`,
        issuedAt,
        type: "turn.run",
      },
    }),
  )
  return await waitForMessage(ws, (m) => m.kind === "event" && m.event.type === "turn.completed")
}

describe("DOF-10 authenticated operator flow — ONE revision, real daemon + DOF-05 gate", () => {
  test("AUTHENTICATED E2E: token→session→turn→approval→observability→canvas all light up on ONE connection", async () => {
    const { timer, fire } = captureTimer()
    // REAL observability port: a run-ledger holding one running entry ⇒ the
    // emitter's first tick is a genuine `observability.snapshot` carrying it.
    const ledger = createRunLedger()
    ledger.start({ id: "run-1", kind: "shell", owner: "op", title: "ls -la" })
    const observabilityPorts: ObservabilityPorts = { runLedger: ledger, timer }
    const usage = makeUsageSource(REAL_USAGE)
    const approvalPrompt = "request operator approval"
    const { factory } = createStubRuntimeFactory({ approvalOnPrompt: approvalPrompt })

    const { port } = await bootAuthed({
      observabilityPorts,
      canvasPorts: usage.ports,
      factory,
    })

    // ---- AUTH: connect WITH the token (DOF-05 gate must ALLOW) ----
    const ws = new WebSocket(authedUrl(port))
    await waitForOpen(ws)
    const raw = collectRaw(ws)
    await wait(30)

    // ---- SESSION CREATE/USE: connect ⇒ snapshot ----
    ws.send(encodeSessionTransportMessage({ kind: "connect", sessionId: "stub-session-1" }))
    const snapshot = await waitForMessage(ws, (m) => m.kind === "snapshot")
    expect(snapshot.kind).toBe("snapshot")
    if (snapshot.kind !== "snapshot") throw new Error("narrow")
    expect(snapshot.snapshot.sessionId).toBe("stub-session-1")

    // ---- CANVAS: snapshot-on-connect ⇒ a real context.usage frame ----
    // (feedUsage on attach forwards latest() synchronously during open())
    const canvasDecoded = raw
      .map((r) => decodeCanvasFrame(r))
      .find((m) => m?.kind === "context.usage")
    expect(canvasDecoded?.kind).toBe("context.usage")
    if (canvasDecoded?.kind === "context.usage") {
      expect(canvasDecoded.total).toBe(42)
      expect(canvasDecoded.segments).toEqual([
        { id: "System", tokens: 42 },
      ])
    }

    // ---- OBSERVABILITY: fire the captured tick ⇒ a real observability.snapshot ----
    fire()
    await wait(20)
    const obsDecoded = raw
      .map((r) => decodeObservabilityFrame(r))
      .find((m) => m?.kind === "observability.snapshot")
    expect(obsDecoded?.kind).toBe("observability.snapshot")
    if (obsDecoded?.kind === "observability.snapshot") {
      expect(obsDecoded.runs.map((r) => r.id)).toContain("run-1")
    }

    // ---- TURN STREAMING: input.append + turn.run ⇒ delta + completed ----
    const completed = await drainTurn(ws)
    if (completed.kind !== "event" || completed.event.type !== "turn.completed") {
      throw new Error("narrow")
    }
    expect(completed.event.assistantText).toBe("stub: hello")
    const sawDelta = raw
      .map((r) => tryDecodeSessionTransportMessage(r))
      .some((m) => m?.kind === "event" && m.event.type === "turn.output.delta")
    expect(sawDelta).toBe(true)

    // ---- APPROVAL VERB: mint a REAL pending approval, then resolve it over
    //      the SAME wire. An arbitrary/unminted id is intentionally absorbed
    //      (pinned by the stale-id edge below), so this positive rail first
    //      drives input.append → turn.run → approval.requested and answers the
    //      exact id the runtime published.
    const requestedPromise = waitForMessage(
      ws,
      (m) => m.kind === "event" && m.event.type === "approval.requested",
    )
    const approvalIssuedAt = new Date().toISOString()
    ws.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "approval-append",
          issuedAt: approvalIssuedAt,
          type: "input.append",
          text: approvalPrompt,
        },
      }),
    )
    ws.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "approval-run",
          issuedAt: approvalIssuedAt,
          type: "turn.run",
        },
      }),
    )
    const requested = await requestedPromise
    if (requested.kind !== "event" || requested.event.type !== "approval.requested") {
      throw new Error("narrow")
    }
    const approvalId = requested.event.approval.approvalId
    expect(approvalId).toStartWith("stub-approval-")

    const resolvedPromise = waitForMessage(
      ws,
      (m) =>
        m.kind === "event" &&
        m.event.type === "approval.resolved" &&
        m.event.approvalId === approvalId,
    )
    ws.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "approve-1",
          issuedAt: new Date().toISOString(),
          type: "approval.respond",
          approvalId,
          decision: "approve",
        },
      }),
    )
    const resolved = await resolvedPromise
    if (resolved.kind !== "event" || resolved.event.type !== "approval.resolved") {
      throw new Error("narrow")
    }
    expect(resolved.event.decision).toBe("approve")

    ws.close()
    await wait(30)
  })

  // ---- NEGATIVE AUTH CONTROL (paired): wrong / missing token ⇒ rejected ----
  test("NEGATIVE CONTROL: a WRONG bearer token is rejected by the DOF-05 gate (no snapshot, upgrade 401)", async () => {
    const { port } = await bootAuthed()

    // HTTP upgrade probe with a wrong token ⇒ 401 (the gate rejects before upgrade).
    const res = await fetch(`http://127.0.0.1:${port}/?token=wrong`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    })
    expect(res.status).toBe(401)

    // And the WS constructor with a wrong token never reaches OPEN.
    const ws = new WebSocket(authedUrl(port, "wrong-token"))
    const opened = await Promise.race([
      waitForOpen(ws)
        .then(() => "open" as const)
        .catch(() => "error" as const),
      wait(500).then(() => "timeout" as const),
    ])
    expect(opened).not.toBe("open")
    try {
      ws.close()
    } catch {
      // already closed
    }
    await wait(20)
  })

  // ---- RED-ON-INJECTION on the auth gate: a matching token DOES open, a
  //      one-char mutation does NOT — proving the compare is load-bearing. ----
  test("RED-ON-INJECTION: the exact token opens; a one-character-off token is rejected", async () => {
    const { port } = await bootAuthed()

    const good = new WebSocket(authedUrl(port, SECRET))
    const goodResult = await Promise.race([
      waitForOpen(good)
        .then(() => "open" as const)
        .catch(() => "error" as const),
      wait(800).then(() => "timeout" as const),
    ])
    expect(goodResult).toBe("open")
    good.close()

    const mutated = `${SECRET.slice(0, -1)}X`
    const badRes = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(mutated)}`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    })
    expect(badRes.status).toBe(401)
    await wait(20)
  })

  // ---- EDGE 1: disconnect/backpressure — sinks stop; session count → 0; a
  //      fresh AUTHED reconnect still streams a turn. ----
  test("EDGE disconnect: after close, session count returns to 0 and a fresh authed reconnect still streams", async () => {
    const { handle, port } = await bootAuthed()

    const ws1 = new WebSocket(authedUrl(port))
    await waitForOpen(ws1)
    await wait(40)
    expect(handle.activeSessions()).toBe(1)

    ws1.close()
    await wait(80)
    expect(handle.activeSessions()).toBe(0)

    // Reconnect (re-authenticated) and prove the wire is still fully alive.
    const ws2 = new WebSocket(authedUrl(port))
    await waitForOpen(ws2)
    await wait(30)
    ws2.send(encodeSessionTransportMessage({ kind: "connect", sessionId: "stub-session-1" }))
    await waitForMessage(ws2, (m) => m.kind === "snapshot")
    const completed = await drainTurn(ws2)
    expect(completed.kind === "event" && completed.event.type === "turn.completed").toBe(true)
    ws2.close()
    await wait(30)
  })

  // ---- EDGE 2: stale approval id — respond for an unminted id does NOT crash
  //      the session; a subsequent real turn still streams. ----
  test("EDGE stale approval id: an approval.respond for an unknown id is absorbed and the session stays live", async () => {
    const { port } = await bootAuthed()

    const ws = new WebSocket(authedUrl(port))
    await waitForOpen(ws)
    const raw = collectRaw(ws)
    await wait(30)
    ws.send(encodeSessionTransportMessage({ kind: "connect", sessionId: "stub-session-1" }))
    await waitForMessage(ws, (m) => m.kind === "snapshot")

    // Respond to an id no host ever minted. The stub resolver absorbs it (no
    // minted-id ACL in the v1 shared-session daemon); the EXPLICIT behavior we
    // pin is that the WIRE + session SURVIVE it — no `rejected`, no
    // `session.closed`, and the socket stays OPEN for the next turn.
    ws.send(
      encodeSessionTransportMessage({
        kind: "command",
        command: {
          sessionId: "stub-session-1",
          commandId: "stale-approve",
          issuedAt: new Date().toISOString(),
          type: "approval.respond",
          approvalId: "ghost-approval-999",
          decision: "deny",
        },
      }),
    )
    await wait(60)

    // Explicit behavior: no rejection frame + no session-close event from the
    // stale id, and the socket is still OPEN.
    const decodedRaw = raw.map((r) => tryDecodeSessionTransportMessage(r))
    expect(decodedRaw.some((m) => m?.kind === "rejected")).toBe(false)
    expect(decodedRaw.some((m) => m?.kind === "event" && m.event.type === "session.closed")).toBe(
      false,
    )
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // A real turn AFTER the stale respond must still complete — the wire is live.
    const completed = await drainTurn(ws)
    expect(completed.kind === "event" && completed.event.type === "turn.completed").toBe(true)
    ws.close()
    await wait(30)
  })

  // ---- EDGE 3: unauthorized reconnect — a reconnect with a MISSING token is
  //      rejected at the gate (distinct from EDGE 1's re-authenticated one). ----
  test("EDGE unauthorized reconnect: reconnect WITHOUT a token is rejected (paired against an authed one that succeeds)", async () => {
    const { port } = await bootAuthed()

    // First: an authed connection succeeds.
    const authed = new WebSocket(authedUrl(port))
    expect(
      await Promise.race([
        waitForOpen(authed)
          .then(() => "open" as const)
          .catch(() => "error" as const),
        wait(800).then(() => "timeout" as const),
      ]),
    ).toBe("open")
    authed.close()
    await wait(20)

    // Reconnect WITHOUT a token ⇒ 401, never reaches OPEN.
    const noToken = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    })
    expect(noToken.status).toBe(401)

    const wsNoToken = new WebSocket(`ws://127.0.0.1:${port}/`)
    expect(
      await Promise.race([
        waitForOpen(wsNoToken)
          .then(() => "open" as const)
          .catch(() => "error" as const),
        wait(500).then(() => "timeout" as const),
      ]),
    ).not.toBe("open")
    try {
      wsNoToken.close()
    } catch {
      // already closed
    }
    await wait(20)
  })

  // ---- EDGE 4: dropped canvas event — a canvas frame to a DEAD socket is
  //      dropped WITHOUT breaking the shared source's fan-out to a LIVE sibling. ----
  test("EDGE dropped canvas event: a push to a dead socket does not starve a live sibling", async () => {
    const usage = makeUsageSource(REAL_USAGE)
    const { port } = await bootAuthed({ canvasPorts: usage.ports })

    // Two authed connections share the SAME usage source.
    const dead = new WebSocket(authedUrl(port))
    await waitForOpen(dead)
    const live = new WebSocket(authedUrl(port))
    await waitForOpen(live)
    const liveRaw = collectRaw(live)
    await wait(40)

    // Kill one socket at the transport layer, THEN push a new usage view. The
    // dead connection's sink send throws internally (swallowed); the live
    // sibling MUST still receive the pushed frame.
    dead.close()
    await wait(60)

    const nextView: ContextUsageBreakdown = {
      segments: [{ id: "System", tokens: 99, chars: 99, color: "cyan" }],
      total: 99,
      max: 1000,
      model: "stub-model",
    }
    usage.push(nextView)
    await wait(60)

    const got = liveRaw
      .map((r) => decodeCanvasFrame(r))
      .filter((m) => m?.kind === "context.usage")
      .map((m) => (m?.kind === "context.usage" ? m.total : -1))
    // The live sibling saw BOTH the snapshot-on-connect (42) and the post-drop
    // push (99) — the dead socket's throw did not break the fan-out.
    expect(got).toContain(99)

    live.close()
    await wait(30)
  })
})
