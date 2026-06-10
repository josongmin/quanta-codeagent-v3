/**
 * SOTA++ hellgate (W4) — agent-state + observability events through the REAL
 * web daemon to a REAL WebSocket client.
 *
 * The sibling `tests/unit/agent-state-daemon-e2e-flow-hellgate.test.ts` proves
 * the in-process fan-out chain (source → sink subscriber → mapper → codec →
 * fake-ws) but it MOCKS the wire: it pushes a `fakeWs` object straight into
 * `attachAgentStateSink`. It never boots `startWebDaemon`, never opens a TCP
 * socket, and never exercises `Bun.serve`'s `open()` handler — the exact place
 * where `config.observabilityPorts` / `config.agentStatePorts` get attached to a
 * live `ServerWebSocket`. A regression that (a) forgot to call
 * `attachObservabilitySink`/`attachAgentStateSink` in `open()`, (b) dropped the
 * `ports` plumbing from `WebDaemonServerConfig`, or (c) broke the snapshot-on-
 * first-tick emitter contract would leave that unit test GREEN while the real
 * frontend renders an empty pane.
 *
 * This test closes that gap. It:
 *   - boots the REAL `startWebDaemon` (real `Bun.serve`, real WS upgrade),
 *   - hands it REAL closed ports (`createRunLedger` / `createApprovalStateMachine`
 *     / `createObjectiveStore`) plus a REAL `createAgentStateSource`,
 *   - connects a REAL browser `WebSocket` client, and
 *   - asserts the decoded frames the wire actually carried.
 *
 * Hermetic + offline: the runtime is the stub factory (no LLM, no fs); turns are
 * synthesized by the stub. No timing assertions — the observability emitter's
 * timer is replaced by a captured-callback seam so the test drives each tick as
 * an explicit barrier, and every wire assertion awaits the matching frame.
 *
 * Cases:
 *   1. fresh-connection FIRST observability frame is a `observability.snapshot`
 *      carrying the seeded run + approval + objective state.
 *   2. a ledger/approval mutation produces an `observability.delta` frame.
 *   3. agentState events (`plan_created` / `mode_changed` / `tool_progress`)
 *      arrive as decoded `AgentStateMessage`s of the matching kind.
 *   4. fault isolation: a DEAD sibling socket (closed mid-connect) does NOT
 *      block a healthy connection from receiving frames.
 *   5. gate-OFF byte-identical: with NO ports configured, NO observability /
 *      agentState frame is ever sent (only the in-band session protocol).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createApprovalStateMachine } from "@/agent/approval-state-machine"
import { createObjectiveStore } from "@/agent/objective"
import { createRunLedger } from "@/agent/run-ledger"
import { createAgentStateSource } from "@/apps/web-daemon/agent-state-source"
import {
  type AgentStatePorts,
  type ObservabilityPorts,
  startWebDaemon,
  type WebDaemonServerConfig,
} from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { type AgentStateMessage, decodeAgentStateFrame } from "@/protocol/agent-state"
import { type ObservabilityMessage, decodeObservabilityFrame } from "@/protocol/observability"
import { createStubRuntimeFactory } from "../unit/apps/web-daemon/fixture"

// ── handle teardown ───────────────────────────────────────────────────────────
const handles: WebDaemonHandle[] = []
const sockets: WebSocket[] = []

// Hermetic: never touch the user's real `~/.quanta/web-daemon/threads.db`. The
// daemon's SQLite thread store is orthogonal to what we're testing (out-of-band
// observability / agent-state frames), so disable it for the whole file.
const prevWebDb = process.env.QUANTA_WEB_DB
beforeAll(() => {
  process.env.QUANTA_WEB_DB = "off"
})
afterAll(() => {
  if (prevWebDb === undefined) delete process.env.QUANTA_WEB_DB
  else process.env.QUANTA_WEB_DB = prevWebDb
})

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
    if (h !== undefined) await h.stop().catch(() => undefined)
  }
})

const THREAD = "default"

/**
 * A captured-callback timer seam: the observability emitter calls `setInterval`
 * once per connection during `open()`. We stash the callback so the test can
 * drive ticks as explicit barriers (the FIRST tick is always the snapshot; later
 * ticks emit deltas when the live ports differ). No wall-clock dependence.
 */
const captureTimer = (): {
  timer: NonNullable<ObservabilityPorts["timer"]>
  /** Drive every captured connection's tick once. */
  tickAll: () => void
} => {
  const cbs: (() => void)[] = []
  return {
    timer: {
      setInterval(cb: () => void): unknown {
        cbs.push(cb)
        return cbs.length
      },
      clearInterval(): void {
        // no-op: the test owns tick cadence
      },
    },
    tickAll: () => {
      for (const cb of [...cbs]) cb()
    },
  }
}

/** Seed real closed ports so a snapshot/delta carries observable content. */
const buildLivePorts = (timer: NonNullable<ObservabilityPorts["timer"]>): {
  ports: ObservabilityPorts
  ledger: ReturnType<typeof createRunLedger>
  approvals: ReturnType<typeof createApprovalStateMachine>
  objective: ReturnType<typeof createObjectiveStore>
} => {
  const ledger = createRunLedger()
  const approvals = createApprovalStateMachine()
  const objective = createObjectiveStore()
  // Seed state BEFORE the first connection so the snapshot is non-empty.
  ledger.start({ id: "run-1", kind: "exec", owner: THREAD, title: "build the thing" })
  objective.set(THREAD, { goal: "ship W4", successCriteria: ["frames reach the client"] })
  const ports: ObservabilityPorts = {
    objective,
    runLedger: ledger,
    approvalSM: approvals,
    threadId: THREAD,
    timer,
  }
  return { ports, ledger, approvals, objective }
}

const agentStatePortsFor = (
  source: ReturnType<typeof createAgentStateSource>,
): AgentStatePorts => ({ source })

/** A real WebSocket whose observability frames are collected (decoded). */
const connect = (
  handle: WebDaemonHandle,
): {
  ws: WebSocket
  observability: ObservabilityMessage[]
  agentState: AgentStateMessage[]
  /** Resolve when at least one frame matching `pred` has been observed. */
  waitObservability: (
    pred: (m: ObservabilityMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<ObservabilityMessage>
  waitAgentState: (
    pred: (m: AgentStateMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<AgentStateMessage>
  open: Promise<void>
} => {
  const ws = new WebSocket(`ws://${handle.hostname}:${handle.port}/`)
  sockets.push(ws)
  const observability: ObservabilityMessage[] = []
  const agentState: AgentStateMessage[] = []
  type Waiter<T> = { pred: (m: T) => boolean; resolve: (m: T) => void; timer: ReturnType<typeof setTimeout> }
  const obsWaiters = new Set<Waiter<ObservabilityMessage>>()
  const asWaiters = new Set<Waiter<AgentStateMessage>>()

  ws.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return
    const obs = decodeObservabilityFrame(event.data)
    if (obs !== null) {
      observability.push(obs)
      for (const w of [...obsWaiters]) {
        if (w.pred(obs)) {
          clearTimeout(w.timer)
          obsWaiters.delete(w)
          w.resolve(obs)
        }
      }
      return
    }
    const as = decodeAgentStateFrame(event.data)
    if (as !== null) {
      agentState.push(as)
      for (const w of [...asWaiters]) {
        if (w.pred(as)) {
          clearTimeout(w.timer)
          asWaiters.delete(w)
          w.resolve(as)
        }
      }
    }
  })

  const open = new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true })
  })

  const waitObservability = (
    pred: (m: ObservabilityMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<ObservabilityMessage> => {
    const existing = observability.find(pred)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise<ObservabilityMessage>((resolve, reject) => {
      const w: Waiter<ObservabilityMessage> = {
        pred,
        resolve,
        timer: setTimeout(() => {
          obsWaiters.delete(w)
          reject(new Error("waitObservability: timed out"))
        }, timeoutMs),
      }
      obsWaiters.add(w)
    })
  }
  const waitAgentState = (
    pred: (m: AgentStateMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<AgentStateMessage> => {
    const existing = agentState.find(pred)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise<AgentStateMessage>((resolve, reject) => {
      const w: Waiter<AgentStateMessage> = {
        pred,
        resolve,
        timer: setTimeout(() => {
          asWaiters.delete(w)
          reject(new Error("waitAgentState: timed out"))
        }, timeoutMs),
      }
      asWaiters.add(w)
    })
  }

  return { ws, observability, agentState, waitObservability, waitAgentState, open }
}

const boot = async (
  extra: Partial<WebDaemonServerConfig>,
): Promise<WebDaemonHandle> => {
  const { factory } = createStubRuntimeFactory()
  const handle = await startWebDaemon({
    port: 0,
    bind: "127.0.0.1",
    authToken: undefined,
    runtimeFactory: factory,
    sessionConfig: {},
    ...extra,
  })
  handles.push(handle)
  return handle
}

// A short barrier to let Bun's `open()` handler finish wiring the per-connection
// sinks before we drive ticks / push captures. This is an ORDERING barrier (let
// the event loop turn), not a timing assertion on event latency.
const yieldLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

describe("W4 — observability + agent-state through the REAL daemon WS", () => {
  test("(1) fresh connection's FIRST observability frame is a snapshot with seeded state", async () => {
    const { timer, tickAll } = captureTimer()
    const { ports } = buildLivePorts(timer)
    const handle = await boot({ observabilityPorts: ports })

    const client = connect(handle)
    await client.open
    await yieldLoop() // open() has attached the emitter + captured the timer cb

    // Drive the first tick — the emitter contract: first emit is ALWAYS a snapshot.
    tickAll()

    const snap = await client.waitObservability((m) => m.kind === "observability.snapshot")
    expect(snap.kind).toBe("observability.snapshot")
    if (snap.kind !== "observability.snapshot") throw new Error("narrow")
    // The snapshot carries the seeded run, objective, and (empty) approvals — the
    // run/approval/objective STATE the prompt requires on a fresh connection.
    expect(snap.runs.map((r) => r.id)).toContain("run-1")
    expect(snap.objective?.goal).toBe("ship W4")
    expect(Array.isArray(snap.approvals)).toBe(true)
  })

  test("(2) a ledger/approval mutation reaches the client as an observability.delta", async () => {
    const { timer, tickAll } = captureTimer()
    const { ports, ledger, approvals } = buildLivePorts(timer)
    const handle = await boot({ observabilityPorts: ports })

    const client = connect(handle)
    await client.open
    await yieldLoop()

    // First tick = snapshot (consumes the seeded baseline as "lastSent").
    tickAll()
    await client.waitObservability((m) => m.kind === "observability.snapshot")

    // Mutate the live ports: a new run + a pending approval.
    ledger.start({ id: "run-2", kind: "exec", owner: THREAD, title: "second run" })
    approvals.request({
      threadId: THREAD,
      kind: "tool",
      reason: "needs confirmation",
      proposedAction: "rm -rf nothing",
      resumeStep: "after approval",
    })

    // Next tick diffs against lastSent ⇒ a delta frame for the mutation.
    tickAll()
    const delta = await client.waitObservability((m) => m.kind === "observability.delta")
    expect(delta.kind).toBe("observability.delta")
    if (delta.kind !== "observability.delta") throw new Error("narrow")
    const runIds = (delta.runChanges ?? []).map((c) => c.id)
    const approvalCount = (delta.approvalChanges ?? []).length
    // The mutation surfaced on the wire (run-2 added and/or an approval appeared).
    expect(runIds.includes("run-2") || approvalCount > 0).toBe(true)
  })

  test("(3) agentState events arrive as decoded AgentStateMessages of the matching kind", async () => {
    const source = createAgentStateSource()
    const handle = await boot({ agentStatePorts: agentStatePortsFor(source) })

    const client = connect(handle)
    await client.open
    await yieldLoop() // open() has subscribed this socket to the source

    // Push three representative agent-state observations through the REAL source.
    // (Mirrors what `wireAgentStateTap` hands the sink when the loop emits.)
    source.sink.capture({ type: "plan_created", plan: { id: "p", name: "P", version: 1, todos: [] } })
    source.sink.capture({ type: "mode_changed", from: "default", to: "plan" })
    source.sink.capture({ type: "tool_progress", id: "call-9", name: "shell", message: "go" })

    const plan = await client.waitAgentState((m) => m.kind === "plan.created")
    const mode = await client.waitAgentState((m) => m.kind === "mode.changed")
    const prog = await client.waitAgentState((m) => m.kind === "tool.progress")
    expect(plan.kind).toBe("plan.created")
    expect(mode.kind).toBe("mode.changed")
    expect(prog.kind).toBe("tool.progress")
    // The mapper RENAME survives the real wire (id → toolCallId, name → toolName).
    if (prog.kind === "tool.progress") {
      expect(prog.toolCallId).toBe("call-9")
      expect(prog.toolName).toBe("shell")
    }
  })

  test("(4) fault isolation: a DEAD sibling socket does NOT block a healthy connection", async () => {
    const source = createAgentStateSource()
    const handle = await boot({ agentStatePorts: agentStatePortsFor(source) })

    // A doomed connection that we close immediately after open — its forwarder's
    // `ws.send` will throw on the dead socket. The source's per-handler try/catch
    // must contain that so the healthy sibling still receives every frame.
    const doomed = connect(handle)
    await doomed.open
    await yieldLoop()

    const healthy = connect(handle)
    await healthy.open
    await yieldLoop()

    doomed.ws.close()
    await yieldLoop() // let the close settle so its socket is truly dead

    // Capture AFTER the sibling died: the fan-out must not throw and the healthy
    // connection must still receive the frame.
    expect(() => {
      source.sink.capture({ type: "mode_changed", from: "plan", to: "default" })
    }).not.toThrow()

    const mode = await healthy.waitAgentState((m) => m.kind === "mode.changed")
    expect(mode.kind).toBe("mode.changed")
  })

  test("(5) gate-OFF byte-identical: NO ports ⇒ NO observability/agentState frame", async () => {
    // No observabilityPorts, no agentStatePorts — the legacy daemon surface.
    const source = createAgentStateSource()
    const handle = await boot({})

    const client = connect(handle)
    await client.open
    await yieldLoop()

    // Even if the composition root's source captures (it isn't wired here), and
    // even after a generous barrier, the client sees ZERO out-of-band frames.
    source.sink.capture({ type: "mode_changed", from: "default", to: "plan" })
    await yieldLoop()
    await yieldLoop()

    expect(client.observability).toHaveLength(0)
    expect(client.agentState).toHaveLength(0)
  })
})

/**
 * red-on-injection proof. This block carries a deliberately BROKEN daemon config:
 * `observabilityPorts` is omitted, so `attachObservabilitySink` returns null and
 * NO snapshot is ever sent. It asserts the snapshot ARRIVES — which it cannot —
 * so this test is RED. Keeping it `test.skip` documents the teeth: flip `.skip`
 * to `.only`-style and watch case (1)'s assertion fail when the sink is severed.
 *
 * (Left skipped so the suite is GREEN; it is the executable evidence that the
 * snapshot-on-connect assertion in case (1) is not vacuous.)
 */
describe("W4 — red-on-injection evidence (severed sink ⇒ no snapshot)", () => {
  test.skip("INJECTION: omit observabilityPorts ⇒ snapshot never arrives (case 1 would go RED)", async () => {
    const { timer, tickAll } = captureTimer()
    buildLivePorts(timer) // build ports but DELIBERATELY do not pass them
    const handle = await boot({}) // ← severed: no observabilityPorts

    const client = connect(handle)
    await client.open
    await yieldLoop()
    tickAll() // no emitter was attached ⇒ no callback captured ⇒ no-op

    // This await MUST time out (no snapshot is ever sent) ⇒ the test is RED,
    // proving case (1)'s `waitObservability(snapshot)` has real teeth.
    await client.waitObservability((m) => m.kind === "observability.snapshot", 300)
  })
})
