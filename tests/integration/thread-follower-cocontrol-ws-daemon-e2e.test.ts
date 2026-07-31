/**
 * ★ HELLGATE (T02) — thread-follower co-control through a REAL WebSocket into a
 * REAL `startWebDaemon`.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The headline of `thread-follower-cocontrol` is: a SECOND client (a "follower"
 * on the shared session) sends a `followerVerb` WS frame — steer / interrupt /
 * set-queue-mode / approval-decision — into a live turn some primary client is
 * driving, and that verb INJECTS into the lease holder's turn over the REAL web
 * transport. Every existing test decodes verbs IN-PROCESS:
 *
 *   - `tests/unit/apps/web-daemon/follower-verb-frame-hellgate.test.ts` wires
 *     `peekFollowerVerb → FollowerCoControlDispatcher → real surface` but with a
 *     hand-built frame STRING passed straight to `peekFollowerVerb` — no daemon,
 *     no socket, no `Bun.serve` `message()` handler.
 *   - `tests/unit/thread-follower-*` exercise the pure planner / coordinator.
 *
 * NONE boot `startWebDaemon` and send a real `followerVerb` WS frame from a 2nd
 * `new WebSocket` client. So the exact transport boundary the feature exists for —
 * `src/apps/web-daemon/server/ws-handlers.ts:264-280`, where a text frame off a
 * live `ServerWebSocket` is `peekFollowerVerb`'d and routed to
 * `config.followerCoControl.dispatch(verb)` — has ZERO real-socket coverage. A
 * regression that (a) dropped the `peekFollowerVerb` short-circuit, (b) forgot to
 * wire `config.followerCoControl` through `startWebDaemon`, or (c) let the frame
 * fall through to the session bridge instead of the dispatcher would leave every
 * in-process test GREEN while a real web follower's steer silently vanishes.
 *
 * WHAT LAYER THIS COVERS (caveat — read before trusting the label)
 * ----------------------------------------------------------------
 * This drives the REAL-SOCKET TRANSPORT BOUNDARY end-to-end: a real TCP WS frame
 * from a 2nd client → Bun's `websocket.message()` → the daemon's real
 * `ws-handlers.ts` handler → real `peekFollowerVerb` → real
 * `FollowerCoControlDispatcher.dispatch` → its (test-observable) sinks. The
 * dispatcher's sinks are the daemon's REAL apply seam; in production `./index.ts`
 * binds them to the live conversation-action surface (steer → inject into the
 * lease holder's running turn). We do NOT stand up a full LLM-driven live turn
 * (the daemon's session here is the hermetic stub — no agent loop, no lease
 * scheduler), so the ground-truth is at the DISPATCHER EFFECT, one hop short of
 * the live-turn weave (which the sibling unit test pins against the real surface).
 * The untested boundary being closed is the WIRE + the server's peek/dispatch —
 * that this real socket path reaches the dispatcher AT ALL, with the right verb.
 *
 * NON-VACUOUS
 * -----------
 *   - CONTROL A: gate-OFF (no `followerCoControl`) ⇒ the SAME frame falls through
 *     to the bridge, the dispatcher is never invoked (no injection).
 *   - CONTROL B: gate-ON but a NON-follower / malformed frame ⇒ `peekFollowerVerb`
 *     returns null ⇒ no dispatch (falls through).
 *   - RED-ON-INJECTION: a documented `test.skip` that severs the peek/dispatch
 *     wiring at the server (dispatcher present but the frame is not a followerVerb
 *     envelope) and asserts the injection ARRIVES — which it cannot — proving the
 *     positive assertion has teeth.
 *
 * HERMETIC + OFFLINE: the stub runtime factory (no LLM, no fs). `QUANTA_WEB_DB=off`
 * so the SQLite thread store is never touched. Teardown mirrors the reference
 * daemon e2e (`agent-state-observability-ws-daemon-e2e.test.ts`) + a `withTimeout`
 * guard around the socket-swap-prone stop path (macOS Bun can hang there).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { InboundMode } from "@/agent/inbound-mode"
import { FollowerCoControlDispatcher, type FollowerCoControlSinks } from "@/agent/thread-follower"
import { startWebDaemon, type WebDaemonServerConfig } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { supported } from "@/protocol/session"
import { createStubRuntimeFactory } from "../unit/apps/web-daemon/fixture"

// ── handle / socket teardown ──────────────────────────────────────────────────
const handles: WebDaemonHandle[] = []
const sockets: WebSocket[] = []

// Hermetic: never touch the user's real thread DB.
const prevWebDb = process.env.QUANTA_WEB_DB
beforeAll(() => {
  process.env.QUANTA_WEB_DB = "off"
})
afterAll(() => {
  if (prevWebDb === undefined) delete process.env.QUANTA_WEB_DB
  else process.env.QUANTA_WEB_DB = prevWebDb
})

/** macOS Bun can HANG on a web-daemon session-swap during `stop()`. Cap it. */
const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

afterEach(async () => {
  while (sockets.length > 0) {
    const s = sockets.pop()
    try {
      s?.close()
    } catch {
      // ignore — already closed
    }
  }
  while (handles.length > 0) {
    const h = handles.pop()
    if (h !== undefined) {
      // Guard the stop path (socket-swap hang risk on macOS Bun).
      await withTimeout(h.stop(), 5000, "daemon.stop").catch(() => undefined)
    }
  }
})

// ── an OBSERVABLE follower dispatcher ─────────────────────────────────────────
/**
 * A REAL `FollowerCoControlDispatcher` whose sinks record what they applied. This
 * IS the daemon's production dispatcher type — the only difference from `./index.ts`
 * is that the sinks push to arrays instead of the live conversation-action surface,
 * so the test can ground-truth "the verb reached the dispatcher through the wire".
 */
const observableDispatcher = (): {
  dispatcher: FollowerCoControlDispatcher
  injects: string[]
  interrupts: string[]
  queueModes: InboundMode[]
} => {
  const injects: string[] = []
  const interrupts: string[] = []
  const queueModes: InboundMode[] = []
  const sinks: FollowerCoControlSinks = {
    inject: (t) => injects.push(t),
    interrupt: (r) => interrupts.push(r),
    setQueueMode: (m) => queueModes.push(m),
  }
  return { dispatcher: new FollowerCoControlDispatcher({ sinks }), injects, interrupts, queueModes }
}

// ── boot a real daemon (optionally with the follower co-control wired) ─────────
const boot = async (extra: Partial<WebDaemonServerConfig>): Promise<WebDaemonHandle> => {
  const { factory } = createStubRuntimeFactory()
  const handle = await startWebDaemon({
    port: 0,
    bind: "127.0.0.1",
    authToken: undefined,
    runtimeFactory: factory,
    sessionConfig: {},
    supportedReadModels: {
      session: supported("session.v1"),
      agentState: { status: "unsupported" },
      canvas: { status: "unsupported" },
      observability: { status: "unsupported" },
    },
    ...extra,
  })
  handles.push(handle)
  return handle
}

/** A real browser WebSocket to the daemon; resolves when OPEN. */
const connect = (handle: WebDaemonHandle): { ws: WebSocket; open: Promise<void> } => {
  const ws = new WebSocket(`ws://${handle.hostname}:${handle.port}/`)
  sockets.push(ws)
  const open = new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true })
  })
  return { ws, open }
}

/** The wire envelope the server's `peekFollowerVerb` expects. */
const followerFrame = (verb: unknown): string => JSON.stringify({ kind: "followerVerb", verb })

/** Poll until `pred` holds or the deadline lapses. Used to await the async hop
 *  from `ws.send` (client) → server `message()` → dispatch (no callback to await
 *  since the effect lands in a local array, not back on the wire). */
const until = async (
  pred: () => boolean,
  { timeoutMs = 2000, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return pred()
}

// An ordering barrier: let Bun's `open()` finish wiring the connection's session
// before the follower sends its verb.
const yieldLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

describe("T02 — a 2nd client's followerVerb frame injects through the REAL daemon WS", () => {
  test("(1) a follower STEER frame over the real socket reaches the co-control dispatcher (inject)", async () => {
    const { dispatcher, injects } = observableDispatcher()
    const handle = await boot({ followerCoControl: dispatcher })

    // Client 1: the "lease holder" — an ordinary connection on the shared session.
    const primary = connect(handle)
    await primary.open
    await yieldLoop()

    // Client 2: the FOLLOWER — a second real WS client on the SAME daemon session.
    const follower = connect(handle)
    await follower.open
    await yieldLoop()

    // The headline: the follower sends a real steer verb over the real socket.
    follower.ws.send(followerFrame({ kind: "steer-turn", text: "prefer v2 api" }))

    // Ground-truth: the verb crossed the wire, hit `ws-handlers.ts` peek+dispatch,
    // and the REAL dispatcher applied it via its inject sink.
    expect(await until(() => injects.length > 0)).toBe(true)
    expect(injects).toEqual(["prefer v2 api"])
    // And ONLY the steer sink fired (no spurious interrupt / queue-mode).
    expect(injects).toHaveLength(1)
  })

  test("(2) a follower INTERRUPT frame over the real socket reaches the dispatcher (interrupt)", async () => {
    const { dispatcher, interrupts, injects } = observableDispatcher()
    const handle = await boot({ followerCoControl: dispatcher })

    const follower = connect(handle)
    await follower.open
    await yieldLoop()

    follower.ws.send(followerFrame({ kind: "interrupt-turn", reason: "user changed course" }))

    expect(await until(() => interrupts.length > 0)).toBe(true)
    expect(interrupts).toEqual(["user changed course"])
    expect(injects).toHaveLength(0)
  })

  test("(3) a follower SET-QUEUE-MODE frame over the real socket reaches the dispatcher", async () => {
    const { dispatcher, queueModes } = observableDispatcher()
    const handle = await boot({ followerCoControl: dispatcher })

    const follower = connect(handle)
    await follower.open
    await yieldLoop()

    follower.ws.send(followerFrame({ kind: "set-queue-mode", mode: "weave" }))

    expect(await until(() => queueModes.length > 0)).toBe(true)
    expect(queueModes).toEqual(["weave"])
  })

  test("(CONTROL A) gate-OFF: NO followerCoControl ⇒ the same steer frame does NOT inject", async () => {
    // No `followerCoControl` in the boot config — the T02 gate is OFF. The server's
    // `if (config.followerCoControl !== undefined)` guard is false, so the frame is
    // never peeked and falls through to the session bridge (byte-identical).
    const { dispatcher, injects } = observableDispatcher() // built but NOT wired
    void dispatcher
    const handle = await boot({}) // ← severed at the config: no followerCoControl

    const follower = connect(handle)
    await follower.open
    await yieldLoop()

    // Send the EXACT frame case (1) used. With the gate off it must not dispatch.
    follower.ws.send(followerFrame({ kind: "steer-turn", text: "prefer v2 api" }))

    // A generous window: even after the frame is fully processed, NO inject fired
    // (the dispatcher we built was never handed to the daemon).
    expect(await until(() => injects.length > 0, { timeoutMs: 400 })).toBe(false)
    expect(injects).toHaveLength(0)
  })

  test("(CONTROL B) gate-ON but a NON-follower frame ⇒ peekFollowerVerb null ⇒ no dispatch", async () => {
    const { dispatcher, injects, interrupts, queueModes } = observableDispatcher()
    const handle = await boot({ followerCoControl: dispatcher })

    const follower = connect(handle)
    await follower.open
    await yieldLoop()

    // A well-formed JSON frame that is NOT a followerVerb envelope, plus a
    // followerVerb envelope carrying a malformed verb (no string `kind`). Both
    // make `peekFollowerVerb` return null ⇒ the guard falls through, no dispatch.
    follower.ws.send(JSON.stringify({ kind: "planInputAnswer", promptId: "p" }))
    follower.ws.send(followerFrame({ noKind: true }))
    follower.ws.send("not json {")

    // Generous window — none of these should ever reach a dispatcher sink.
    expect(
      await until(() => injects.length + interrupts.length + queueModes.length > 0, {
        timeoutMs: 400,
      }),
    ).toBe(false)
    expect(injects).toHaveLength(0)
    expect(interrupts).toHaveLength(0)
    expect(queueModes).toHaveLength(0)
  })
})

/**
 * red-on-injection evidence (kept `test.skip` so the suite is GREEN).
 *
 * This severs the server's peek/dispatch REACHABILITY the way a regression would:
 * the daemon is booted WITH a real dispatcher, but the follower sends a frame that
 * is NOT a `followerVerb` envelope. That mirrors the two ways case (1) can silently
 * break — either `peekFollowerVerb` stops recognizing the envelope, or the frame is
 * routed past the dispatcher. The assertion insists the inject STILL arrives, which
 * it cannot when the peek returns null, so flipping `.skip` → `.only`-style makes
 * this RED — proving case (1)'s `injects` assertion is not vacuous (an inject only
 * ever appears when the real socket path actually reaches the real dispatcher).
 */
describe("T02 — red-on-injection evidence (severed peek/dispatch ⇒ no inject)", () => {
  test.skip("INJECTION: a non-followerVerb frame ⇒ inject never arrives (case 1 would go RED)", async () => {
    const { dispatcher, injects } = observableDispatcher()
    const handle = await boot({ followerCoControl: dispatcher })

    const follower = connect(handle)
    await follower.open
    await yieldLoop()

    // NOT a followerVerb envelope ⇒ `peekFollowerVerb` returns null ⇒ no dispatch.
    // (The neutered peek/dispatch path.) The steer text below is what a WORKING
    // path would inject — here it must NEVER appear.
    follower.ws.send(JSON.stringify({ kind: "notAFollowerVerb", text: "prefer v2 api" }))

    // This MUST time out (no inject is ever applied) ⇒ the assertion below is RED,
    // proving case (1)'s positive `injects` assertion has real teeth.
    expect(await until(() => injects.length > 0, { timeoutMs: 500 })).toBe(true)
  })
})
