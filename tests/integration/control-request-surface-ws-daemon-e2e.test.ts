/**
 * ★ HELLGATE — the OUT-OF-BAND INBOUND control-request surface through a REAL
 * WebSocket into a REAL `startWebDaemon` (ADR-0496 A1 live wire).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The headline of `control-request-surface` is: a browser/IDE client sends a
 * `controlRequest` WS frame mid-session; the server peeks it BEFORE the session
 * bridge (`peekControlRequest`, mirror of `peekPlanInputAnswer`/`peekFollowerVerb`),
 * `enqueue`s it onto the live session's control-request port, and the turn loop
 * drains + applies it — the LOAD-BEARING `set_permission_mode` mutating the live
 * `permission.mode` cell the per-turn gate reads FRESH.
 *
 * Every EXISTING test of this path is IN-PROCESS or drives a DIFFERENT command:
 *
 *   - `tests/integration/permission-set-web-daemon-e2e.test.ts` drives
 *     `session.permission.set` — a KERNEL `SessionCommand` on the session verb
 *     surface. That is a DIFFERENT wire: it never sends a `controlRequest` frame,
 *     never exercises `peekControlRequest` / `consumeControlRequestFrame`, and
 *     never touches the `WebControlRequestPortHandle` drain path.
 *   - `tests/unit/**` control-request tests exercise the pure `peekControlRequest`
 *     decoder, the pure `planControlRequest` planner, and the port's `enqueue`/
 *     `drainControlRequests` with hand-built requests — no daemon, no socket, no
 *     `Bun.serve` `message()` handler.
 *
 * NONE boot `startWebDaemon` and send a real `controlRequest` WS frame from a real
 * `new WebSocket` client. So the exact transport boundary the feature exists for —
 * `src/apps/web-daemon/server/ws-handlers.ts:254-263`, where a text frame off a
 * live `ServerWebSocket` is routed through `consumeControlRequestFrame` →
 * `peekControlRequest` → `ports.handle.enqueue(req)` — has ZERO real-socket
 * coverage. A regression that (a) dropped the `consumeControlRequestFrame`
 * short-circuit in `message()`, (b) forgot to wire `config.controlRequestPorts`
 * through `startWebDaemon`, or (c) let `peekControlRequest` stop recognizing the
 * envelope would leave every in-process test GREEN while a real client's
 * `set_permission_mode` silently vanishes and the gate never flips.
 *
 * WHAT LAYER THIS COVERS (caveat — read before trusting the label)
 * ----------------------------------------------------------------
 * This drives the REAL-SOCKET TRANSPORT BOUNDARY end-to-end: a real TCP WS frame
 * from a real client → Bun's `websocket.message()` → the daemon's real
 * `ws-handlers.ts` handler → real `consumeControlRequestFrame` → real
 * `peekControlRequest` → the REAL `WebControlRequestPortHandle.enqueue`. We then
 * DRAIN the enqueued request with the REAL `await drainControlRequests(handle.port,
 * handle.context, handle.applier)` — byte-for-byte the call the turn loop's
 * `pollControlRequests` makes each turn — so the applier lands its effect on the
 * REAL live `permission.mode` cell.
 *
 * We do NOT stand up a full LLM-driven agent loop here (the daemon session is the
 * hermetic stub — no agent loop, no `pollControlRequests` tick). The ground-truth
 * is therefore at the DRAIN EFFECT, one hop short of the loop's own poll tick
 * (which the sibling `permission-set-web-daemon-e2e.test.ts` pins for the OTHER
 * command via a live turn). The untested boundary being closed is the WIRE + the
 * server's peek/enqueue — that this real socket path reaches the real port AT ALL,
 * with the right request — and that the drain of THAT enqueued request flips the
 * live gate cell. To make the flip OBSERVABLE the way production is, we read it
 * through the REAL permission `evaluate()` gate (a mutating tool action goes from
 * `ask` under `default` to `allow` under `acceptEdits`), not just by peeking the
 * cell.
 *
 * WHY `acceptEdits` AND NOT `bypass` FOR THE HEADLINE
 * ---------------------------------------------------
 * `bypass` turns the approval gate off entirely, and the port's allowlist
 * (`WEB_CONTROL_PERMISSION_MODES`) deliberately SUBTRACTS it: a frame off the
 * wire may narrow to a non-escalating mode, never escalate. This file used to
 * drive the headline with `bypass` — i.e. it pinned the escalation as the
 * feature — so the fence landing turned a security fix into a red. The wire
 * property being proven is unchanged (`ask` → `allow` on the live cell);
 * `acceptEdits` produces the identical observation without being the escalation.
 * Case (1b) then pins the fence AT THIS SAME TRANSPORT BOUNDARY, which the unit
 * hellgate (`tests/unit/apps/web-daemon/control-request-bypass-fence-hellgate.test.ts`,
 * allowlist SHAPE only) cannot reach.
 *
 * NON-VACUOUS
 * -----------
 *   - CONTROL A (gate-OFF): NO `controlRequestPorts` in the boot config ⇒ the
 *     server's `consumeControlRequestFrame` sees `ports === undefined` and returns
 *     false ⇒ the frame falls through to the bridge, NOTHING is enqueued ⇒ the
 *     drain is empty ⇒ the gate NEVER flips (byte-identical).
 *   - CONTROL B (gate-ON, malformed): a well-formed JSON frame that is NOT a
 *     `controlRequest` envelope, plus a `controlRequest` envelope carrying a
 *     malformed request ⇒ `peekControlRequest` returns null ⇒ nothing enqueued.
 *   - RED-ON-INJECTION: a documented `test.skip` that severs the server's
 *     peek/enqueue reachability the way a regression would (the frame is NOT a
 *     `controlRequest` envelope, so the peek returns null and nothing enqueues)
 *     and asserts the mode STILL flips — which it cannot — proving the positive
 *     `permission.mode` assertion has teeth.
 *
 * HERMETIC + OFFLINE: the stub runtime factory (no LLM, no fs). `QUANTA_WEB_DB=off`
 * so the SQLite thread store is never touched. Teardown mirrors the reference
 * daemon e2e (`agent-state-observability-ws-daemon-e2e.test.ts`) + a `withTimeout`
 * guard around the socket-swap-prone stop path (macOS Bun can hang there).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { ControlEffect } from "@/agent/control-request"
import { drainControlRequests } from "@/agent/control-request"
import { startWebDaemon, type WebDaemonServerConfig } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import {
  createWebControlRequestPort,
  type WebControlRequestPortHandle,
} from "@/apps/web-daemon/web-control-request-port"
import {
  ALL_PERMISSION_MODES,
  evaluate,
  type PermissionContext,
  type PermissionDecision,
  type ToolAction,
} from "@/permission"
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

// ── the LIVE permission cell (the load-bearing effect target) ─────────────────
/**
 * The web daemon's live permission proxy (mirror of
 * `runtime-factory.ts` / `permission-set-web-daemon-e2e.test.ts`): a mutable
 * getter/setter pair. `set_permission_mode`'s applier writes `.mode` here; the
 * per-turn gate reads it FRESH so the change lands mid-session.
 */
const liveProxy = (): PermissionContext => {
  let mode: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return mode
    },
    set mode(next) {
      mode = next
    },
  }
}

/** A mutating tool action (isReadOnly:false, no shellCommand ⇒ no HARD_DENY). The
 *  real gate answers `ask` under `default` and `allow` under `acceptEdits` — so
 *  the gate's VERDICT is the ground-truth observation of the live-cell flip. */
const mutatingAction: ToolAction = {
  tool: "danger",
  input: {},
  isReadOnly: false,
  shellCommand: null,
}

/** Read the flip THROUGH the real permission gate (production semantics), not by
 *  peeking the cell: a mutating action is `ask` under `default`, `allow` under
 *  `acceptEdits`. */
const gateDecision = (permission: PermissionContext): PermissionDecision =>
  evaluate(mutatingAction, permission)

// ── an OBSERVABLE control-request port (the daemon's production port type) ─────
/**
 * A REAL `WebControlRequestPortHandle` built via `createWebControlRequestPort` —
 * the EXACT type `index.ts` mints under `QUANTA_CONTROL_REQUEST`. The only
 * difference from production is that the non-permission `observe` sink pushes to
 * an array so the test can ground-truth "the model/thinking effect reached the
 * observe-only sink". The `permission` cell is the real live proxy the applier
 * mutates.
 */
const observablePort = (
  permission: PermissionContext,
): {
  handle: WebControlRequestPortHandle
  observed: { kind: string; value: string }[]
} => {
  const observed: { kind: string; value: string }[] = []
  const handle = createWebControlRequestPort({
    permission,
    // Host opts INTO gating these axes so an off-list value is rejected (the
    // planner validates against these). The values below are the allowlist.
    modelAllowlist: ["gpt-5", "claude-opus"],
    thinkingLevels: ["low", "high"],
    observe: (effect) => observed.push({ kind: effect.kind, value: effect.value }),
  })
  return { handle, observed }
}

/** DRAIN the enqueued requests EXACTLY as the turn loop's `pollControlRequests`
 *  does: pull every pending request off the port, plan each against the live
 *  allowlists, and apply the effect via the applier (mutating the live cell for
 *  `set_permission_mode`). Returns the applied effects for assertions. */
const drain = async (handle: WebControlRequestPortHandle): Promise<ControlEffect[]> =>
  await drainControlRequests(handle.port, handle.context, handle.applier)

// ── boot a real daemon (optionally with the control-request port wired) ────────
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

/** The wire envelope the server's `peekControlRequest` expects:
 *  `{ kind: "controlRequest", request: <ControlRequest> }`. */
const controlFrame = (request: unknown): string =>
  JSON.stringify({ kind: "controlRequest", request })

/** Poll until `pred` holds or the deadline lapses. The `ws.send` → server
 *  `message()` → enqueue hop is async with no callback back on the wire, so we
 *  await the observable side-effect (a pending request appearing on the port). */
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
// before the client sends its control frame.
const yieldLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

describe("control-request-surface — a controlRequest frame flips the live gate through the REAL daemon WS", () => {
  test("(1) a set_permission_mode frame over the real socket enqueues + drains ⇒ the LIVE gate flips default→acceptEdits", async () => {
    const permission = liveProxy()
    const { handle } = observablePort(permission)
    const daemon = await boot({ controlRequestPorts: { handle } })

    const client = connect(daemon)
    await client.open
    await yieldLoop()

    // BEFORE: default mode ⇒ the real gate ASKS for the mutating action.
    expect(gateDecision(permission).kind).toBe("ask")

    // The headline: the client sends a real set_permission_mode control frame.
    // `acceptEdits`, not `bypass` — see "WHY acceptEdits AND NOT bypass" above;
    // the observable (`ask` → `allow`) is identical.
    client.ws.send(controlFrame({ kind: "set_permission_mode", mode: "acceptEdits" }))

    // Ground-truth #1: the frame crossed the wire, hit `ws-handlers.ts`
    // consumeControlRequestFrame → peekControlRequest → enqueue, so the REAL port
    // now has a pending request. (Nothing has drained yet ⇒ cell unchanged.)
    expect(await until(() => handle.pendingCount() > 0)).toBe(true)
    expect(permission.mode).toBe("default") // enqueue alone does NOT mutate the cell

    // The turn loop's drain: plan + apply the enqueued request ⇒ the applier
    // writes the live cell.
    const applied = await drain(handle)
    expect(applied).toEqual([{ kind: "permission-mode-set", mode: "acceptEdits" }])
    expect(handle.pendingCount()).toBe(0) // fully drained

    // Ground-truth #2 (the LOAD-BEARING effect): the live gate now ALLOWS the
    // same mutating action it asked about before — the flip landed on the cell
    // the per-turn gate reads.
    expect(permission.mode).toBe("acceptEdits")
    expect(gateDecision(permission).kind).toBe("allow")
  })

  test("(1b) FENCE — the SAME wire carrying `bypass` is REJECTED at the drain; the live cell never escalates", async () => {
    // The paired control for (1). Everything is identical except the mode, so a
    // green here can only mean the allowlist refused the escalation — not that
    // the frame failed to arrive (the `pendingCount` assertion below proves it
    // crossed the socket and reached the real port exactly as (1)'s did).
    const permission = liveProxy()
    const { handle } = observablePort(permission)
    const daemon = await boot({ controlRequestPorts: { handle } })

    const client = connect(daemon)
    await client.open
    await yieldLoop()

    expect(gateDecision(permission).kind).toBe("ask")

    client.ws.send(controlFrame({ kind: "set_permission_mode", mode: "bypass" }))

    // Reached the real port — the refusal is the PLANNER's, not a lost frame.
    expect(await until(() => handle.pendingCount() > 0)).toBe(true)

    const applied = await drain(handle)
    expect(applied).toEqual([
      { kind: "rejected", reason: 'permission mode "bypass" not recognized' },
    ])
    expect(handle.pendingCount()).toBe(0)

    // The load-bearing assertion: the live cell the per-turn gate reads is
    // untouched, so a mutating action still ASKS.
    expect(permission.mode).toBe("default")
    expect(gateDecision(permission).kind).toBe("ask")
  })

  test("(2) a set_model + set_thinking frame over the real socket reaches the observe-only sink", async () => {
    const permission = liveProxy()
    const { handle, observed } = observablePort(permission)
    const daemon = await boot({ controlRequestPorts: { handle } })

    const client = connect(daemon)
    await client.open
    await yieldLoop()

    // Two non-permission control frames — the observe-only axes (no live swap
    // cell on the daemon today; they surface via the observe sink).
    client.ws.send(controlFrame({ kind: "set_model", model: "gpt-5" }))
    client.ws.send(controlFrame({ kind: "set_thinking", level: "high" }))

    // Both crossed the wire + enqueued.
    expect(await until(() => handle.pendingCount() >= 2)).toBe(true)

    // Drain: plan + apply ⇒ the observe sink SAW each effect (the applier routes
    // model/thinking to `safeObserve`, not the live permission cell).
    const applied = await drain(handle)
    expect(applied).toEqual([
      { kind: "model-set", model: "gpt-5" },
      { kind: "thinking-set", level: "high" },
    ])
    expect(observed).toEqual([
      { kind: "model", value: "gpt-5" },
      { kind: "thinking", value: "high" },
    ])
    // And the permission axis was NEVER touched by these frames.
    expect(permission.mode).toBe("default")
    expect(gateDecision(permission).kind).toBe("ask")
  })

  test("(CONTROL A) gate-OFF: NO controlRequestPorts ⇒ the same frame does NOT enqueue and the gate never flips", async () => {
    // No `controlRequestPorts` in the boot config — the QUANTA_CONTROL_REQUEST
    // gate is OFF. The server's `consumeControlRequestFrame(undefined, raw)`
    // returns false, so the frame is never peeked/enqueued and falls through to
    // the session bridge (byte-identical).
    const permission = liveProxy()
    const { handle } = observablePort(permission) // built but NOT wired
    const daemon = await boot({}) // ← severed at the config: no controlRequestPorts

    const client = connect(daemon)
    await client.open
    await yieldLoop()

    // Send the EXACT frame case (1) used — `acceptEdits`, a mode the allowlist
    // ACCEPTS. Using `bypass` here would confound the control: the drain would be
    // empty either way (gate-off OR fenced), so a green would no longer be
    // evidence that the CONFIG severance is what stopped it.
    client.ws.send(controlFrame({ kind: "set_permission_mode", mode: "acceptEdits" }))

    // A generous window: even after the frame is fully processed, NOTHING was
    // enqueued (the port we built was never handed to the daemon).
    expect(await until(() => handle.pendingCount() > 0, { timeoutMs: 400 })).toBe(false)
    expect(handle.pendingCount()).toBe(0)

    // And even if the loop DID drain, there is nothing to apply ⇒ the gate stays
    // at `default` (asks), byte-identical to the legacy surface.
    expect(await drain(handle)).toEqual([])
    expect(permission.mode).toBe("default")
    expect(gateDecision(permission).kind).toBe("ask")
  })

  test("(CONTROL B) gate-ON but a NON-controlRequest / malformed frame ⇒ peekControlRequest null ⇒ nothing enqueued", async () => {
    const permission = liveProxy()
    const { handle } = observablePort(permission)
    const daemon = await boot({ controlRequestPorts: { handle } })

    const client = connect(daemon)
    await client.open
    await yieldLoop()

    // (a) a well-formed JSON frame that is NOT a controlRequest envelope;
    // (b) a controlRequest envelope carrying a malformed request (no string
    //     `mode`); (c) a garbage-discriminant request; (d) non-JSON. All make
    // `peekControlRequest` return null ⇒ the guard falls through, no enqueue.
    client.ws.send(JSON.stringify({ kind: "planInputAnswer", promptId: "p" }))
    client.ws.send(controlFrame({ kind: "set_permission_mode" })) // missing `mode`
    client.ws.send(controlFrame({ kind: "not_a_real_control" }))
    client.ws.send("not json {")

    // Generous window — none of these should ever reach the port.
    expect(await until(() => handle.pendingCount() > 0, { timeoutMs: 400 })).toBe(false)
    expect(handle.pendingCount()).toBe(0)
    // Nothing to drain ⇒ the gate is untouched.
    expect(await drain(handle)).toEqual([])
    expect(permission.mode).toBe("default")
  })

  test("(CONTROL C) fail-closed axis: an off-allowlist / unknown permission mode drains to a REJECTED effect (no flip)", async () => {
    // The planner fail-closes the permission axis: a mode NOT in the closed SSOT
    // allowlist is REJECTED, never written to the live cell. The frame IS
    // well-shaped (a string `mode`), so it peeks + enqueues — but the DRAIN
    // yields `rejected`, so the gate stays at `default`. Proves the effect that
    // lands is content-validated, not just shape-validated.
    const permission = liveProxy()
    const { handle } = observablePort(permission)
    const daemon = await boot({ controlRequestPorts: { handle } })

    const client = connect(daemon)
    await client.open
    await yieldLoop()

    // "root" is a string mode (peeks fine) but is NOT a real PermissionMode.
    expect((ALL_PERMISSION_MODES as readonly string[]).includes("root")).toBe(false)
    client.ws.send(controlFrame({ kind: "set_permission_mode", mode: "root" }))

    // It DID cross the wire + enqueue (shape is valid).
    expect(await until(() => handle.pendingCount() > 0)).toBe(true)

    // But the drain plans it as `rejected` (off the closed SSOT allowlist) ⇒ the
    // applier NEVER mutates the live cell.
    const applied = await drain(handle)
    expect(applied).toHaveLength(1)
    expect(applied[0]?.kind).toBe("rejected")
    expect(permission.mode).toBe("default")
    expect(gateDecision(permission).kind).toBe("ask")
  })
})

/**
 * red-on-injection evidence (kept `test.skip` so the suite is GREEN).
 *
 * This severs the server's peek/enqueue REACHABILITY the way a regression would:
 * the daemon is booted WITH a real port, but the client sends a frame that is NOT
 * a `controlRequest` envelope. That mirrors the two ways case (1) can silently
 * break — either `peekControlRequest` stops recognizing the envelope, or the
 * frame is routed past `consumeControlRequestFrame`. The assertion insists the
 * gate STILL flips to `acceptEdits`, which it cannot when the peek returns null
 * and nothing is enqueued (so the drain is empty and the applier never writes the
 * cell), so flipping `.skip` → `.only`-style makes this RED — proving case (1)'s
 * `permission.mode === "acceptEdits"` / gate `allow` assertion is not vacuous (the
 * cell only ever flips when the real socket path actually reaches the real port
 * AND the enqueued request is drained).
 */
describe("control-request-surface — red-on-injection evidence (severed peek/enqueue ⇒ no flip)", () => {
  test.skip("INJECTION: a non-controlRequest frame ⇒ the gate never flips (case 1 would go RED)", async () => {
    const permission = liveProxy()
    const { handle } = observablePort(permission)
    const daemon = await boot({ controlRequestPorts: { handle } })

    const client = connect(daemon)
    await client.open
    await yieldLoop()

    // NOT a `controlRequest` envelope ⇒ `peekControlRequest` returns null ⇒
    // nothing enqueued. (The neutered peek/enqueue path.) The `acceptEdits` mode
    // below is what a WORKING path would apply — here it must NEVER land.
    client.ws.send(JSON.stringify({ kind: "notAControlRequest", mode: "acceptEdits" }))

    // Nothing enqueued ⇒ the drain is a no-op ⇒ the cell stays `default`. This
    // assertion MUST fail (the gate never flips) ⇒ the test is RED, proving case
    // (1)'s positive flip assertion has real teeth.
    await until(() => handle.pendingCount() > 0, { timeoutMs: 500 })
    await drain(handle)
    expect(permission.mode).toBe("acceptEdits")
    expect(gateDecision(permission).kind).toBe("allow")
  })
})
