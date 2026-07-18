/**
 * `approval.respond` mid-turn through the WEB DAEMON runtime path (W1).
 *
 * SEALS the ADR-0512 P3 bug: "웹 approve가 lease만 걸고 turn.run이 없어 재실행 안 됨"
 * — a web approval that ONLY calls `session.approval.respond` (sets the host's
 * single-use approval LEASE) but never dispatches the follow-up `turn.run`
 * never re-executes the tool, so the agent stalls forever holding a granted-but-
 * unused approval. There was NO web-daemon integration regression proving the
 * continuation (only the unit `session-turn-driver-escalation-respond.test.ts`
 * checking the respond contract in isolation).
 *
 * This drives the SAME runtime the daemon builds
 * (`createRuntimeFromAgentConfigBase` + `buildInteractiveTurnAssembler`, the
 * web-daemon runtime-factory pair) with the LIVE approval protocol wired
 * (`approvalProtocol.confirmSlot`, exactly the CLI comp-root rails the web
 * surface inherits): a mutating tool under `default` mode trips the gate → the
 * protocol's `onConfirm` throws `RuntimeApprovalRequiredError` → the turn
 * suspends with `status: awaiting_approval` + a `pendingApproval` view RELEASING
 * the kernel single-writer lease → `approval.respond` lands (NOT blocked by a
 * held lease) → and ONLY because the driver dispatches a continuation `turn.run`
 * does the tool actually run.
 *
 * Core invariants:
 *   - approve ⇒ tool runs AND the turn completes (continuation, not lease-only).
 *   - `approval.respond` is dispatchable mid-turn (the suspend already released
 *     the lease — a held lease would make the respond throw / hang).
 *   - The pending-approval view reaches a session SUBSCRIBER (the channel the WS
 *     `approval.requested` frame rides) WHILE the turn is suspended.
 *   - deny + steer (escalation) ⇒ RECOVERABLE: the loop re-runs, the model gets a
 *     declined/steered tool_result, the turn completes (no abort throw).
 *   - default path (no approval-required tool) ⇒ untouched: one turn, no respond.
 *
 * RED-ON-INJECTION: a `noContinuationDriver` that performs `approval.respond` but
 * SKIPS the follow-up `turn.run` (the exact reverted bug) leaves the tool
 * UNINVOKED — asserted directly, so the continuation wire is load-bearing.
 *
 * Hermetic + offline (ScriptedLLM, no network). Synchronised on channel events /
 * the turn payload's `approvalRequest` barrier — NO timing assertions.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { ConfirmDecision } from "@/agent/confirm-decision"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import { setupApprovalContinuation } from "@/apps/web-daemon/server/approval-continuation"
import type { SessionTransport, SessionTransportMessage } from "@/ipc/session"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext, ToolAction } from "@/permission"
import type { PendingApprovalView, SessionCommand, SessionEvent } from "@/protocol/session"
import { continuationCommandIdForApproval } from "@/protocol/session"
import { driveSessionTurn } from "@/runner/orchestrate"
import { createRuntimeFromAgentConfigBase, type RuntimeSession } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

/** Scripted LLM: each `stream()` call serves the next script. Turn 1 calls the
 *  mutating tool (⇒ gate ⇒ approval). The continuation turn re-runs the SAME
 *  call (the loop re-invokes the model after the approval grant); we serve the
 *  call again, then a terminal text turn. */
class ScriptedLLM implements LLMPort {
  readonly model = "stub-web-approval"
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const ev of this.scripts.shift() ?? [{ type: "message_stop", stop_reason: "end_turn" }])
      yield ev
  }
}

const callTool = (id: string, name = "danger"): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input: {} },
  { type: "message_stop", stop_reason: "tool_use" },
]
const endText: StreamEvent[] = [
  { type: "text_delta", delta: "done" },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A mutating tool that records each real execution. `pre-approval-ok` =
 *  the ordinary mutating tier: under `default` the gate ASKS (⇒ our protocol
 *  `onConfirm` throws an approval-required), and only an approval grant lets the
 *  re-run dispatch it. */
const mutatingTool = (counts: { n: number }): Tool => ({
  name: "danger",
  description: "danger",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(): AsyncIterable<ToolEvent> {
    counts.n += 1
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})

/** The web daemon's live permission proxy (runtime-factory.ts shape). */
const liveProxy = (mode: PermissionContext["mode"] = "default"): PermissionContext => {
  let m = mode
  return {
    get mode() {
      return m
    },
    set mode(next) {
      m = next
    },
  }
}

/** Build the web-daemon-shaped runtime with the LIVE approval protocol wired (a
 *  `confirmSlot` whose `current` is the surface `onConfirm`). This is what makes
 *  a mutating tool's gate-ask suspend the turn into an `approvalRequest` instead
 *  of resolving inline — exactly the production CLI/web rails. */
const buildWebRuntime = async (args: {
  readonly llm: LLMPort
  readonly registry: ToolRegistry
  readonly permission: PermissionContext
  readonly surfaceOnConfirm?: (action: ToolAction) => Promise<boolean | ConfirmDecision>
  /** ADR-0540 W1-B — mirror of the daemon composition's gate-ON base flag
   *  (`runtime-factory.ts` sets it when `QUANTA_INLINE_APPROVAL_RESOLVER` is
   *  on): stamps the `serverAutoContinues` capability bit on the manifest. */
  readonly serverAutoContinues?: true
}) => {
  const abort = new AbortController()
  // The surface onConfirm is normally the live TTY/web prompt; here it should
  // NEVER be called (the protocol controller's throwing onConfirm replaces it
  // inside `runWithProtocol`). A throwing default would expose any accidental
  // inline-confirm path.
  const confirmSlot = {
    current:
      args.surfaceOnConfirm ??
      (async (): Promise<boolean> => {
        throw new Error("surface onConfirm must not be reached under the approval protocol")
      }),
  }
  const base = {
    llm: args.llm,
    registry: args.registry,
    stream: new StdoutStream(),
    permission: args.permission,
    messages: [],
    system: "system",
    cwd: "/tmp/quanta-web-approval-mid-turn",
    maxTurns: 6,
    signal: abort.signal,
    hitl: { enabled: true }, // mirror the web daemon's security config
    onConfirm: async (action: ToolAction) => confirmSlot.current(action),
    // The throw-based mid-turn approval is LIVE only when the confirmSlot is
    // present — the web/CLI comp-root rail.
    approvalProtocol: { confirmSlot },
    ...(args.serverAutoContinues === true ? { serverAutoContinues: true } : {}),
  }
  const { runtime } = await createRuntimeFromAgentConfigBase({
    base: base as Parameters<typeof createRuntimeFromAgentConfigBase>[0]["base"],
    turnAssembler: buildInteractiveTurnAssembler(),
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  return runtime
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe("approval.respond mid-turn → turn.run continuation (web-daemon e2e)", () => {
  test("approve mid-turn is NOT lease-blocked and the continuation turn.run runs the tool", async () => {
    const counts = { n: 0 }
    const runtime = await buildWebRuntime({
      // Turn 1 = call danger (⇒ approval). Continuation = call danger again
      // (now approved ⇒ runs) → end.
      llm: new ScriptedLLM([callTool("t1"), callTool("t1b"), endText]),
      registry: new ToolRegistry([mutatingTool(counts)]),
      permission: liveProxy("default"),
    })
    const session: RuntimeSession = await runtime.createSession({
      cwd: "/tmp/quanta-web-approval-mid-turn",
      permissionMode: "default",
    })
    cleanup = async () => {
      await session.close()
      await runtime.close()
    }

    // The pending-approval view must reach a SUBSCRIBER (the channel the WS
    // `approval.requested` frame rides) WHILE the turn is suspended — not only
    // the synchronous turn payload.
    const channelApprovals: PendingApprovalView[] = []
    let sawAwaitingApproval = false
    const unsub = session.subscribe((event: SessionEvent) => {
      if (event.type === "approval.requested") channelApprovals.push(event.approval)
      if (event.type === "session.state.updated" && event.state.status === "awaiting_approval") {
        sawAwaitingApproval = true
      }
    })

    let approvedId: string | undefined
    // Drive through the REAL surface-agnostic driver: it runs
    // `append → turn.run → (approvalRequest) respond → loop`. The `respond`
    // lands mid-turn (the suspend already released the kernel lease) and the
    // loop's follow-up `turn.run` is the continuation under test.
    const result = await driveSessionTurn({
      env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
      session,
      text: "do the dangerous thing",
      turnSignal: new AbortController().signal,
      resolveApproval: async (approval) => {
        approvedId = approval.approvalId
        return "approve"
      },
    })
    unsub()

    // Continuation actually ran the tool — NOT lease-only.
    expect(counts.n).toBe(1)
    // The turn reached terminal completion (the loop drained the approval).
    expect(result.outcome.reason).toBe("completed")
    // An approval was genuinely surfaced + resolved (the suspend really happened).
    expect(approvedId).toBeDefined()
    // The pending view reached the out-of-band subscriber channel.
    expect(channelApprovals.length).toBeGreaterThan(0)
    expect(channelApprovals[0]?.approvalId).toBe(approvedId)
    expect(sawAwaitingApproval).toBe(true)
  })

  test("RED-ON-INJECTION: respond WITHOUT the continuation turn.run leaves the tool UNINVOKED", async () => {
    // This reproduces the reverted ADR-0512 P3 bug directly: a driver that lands
    // the approval LEASE (`approval.respond`) but never dispatches the follow-up
    // `turn.run`. The lease is set, yet the tool never re-executes — proving the
    // continuation wire (the loop's second `turn.run`) is load-bearing. If a
    // regression silently re-ran the tool from `respond` alone, this would go RED.
    const counts = { n: 0 }
    const runtime = await buildWebRuntime({
      llm: new ScriptedLLM([callTool("t1"), callTool("t1b"), endText]),
      registry: new ToolRegistry([mutatingTool(counts)]),
      permission: liveProxy("default"),
    })
    const session = await runtime.createSession({
      cwd: "/tmp/quanta-web-approval-mid-turn",
      permissionMode: "default",
    })
    cleanup = async () => {
      await session.close()
      await runtime.close()
    }

    await session.input.append("do the dangerous thing")
    const first = await session.turn.run()
    const approval = first.turn?.approvalRequest
    expect(approval).toBeDefined()
    // Tool has NOT run yet — the turn suspended on the gate.
    expect(counts.n).toBe(0)

    // Land the lease but DELIBERATELY skip the continuation `turn.run`.
    const respond = await session.approval.respond(
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above
      approval!.approvalId,
      "approve",
    )
    // The respond was dispatchable mid-turn (NOT blocked by a held lease).
    expect(respond.revision).toBeGreaterThan(first.revision)
    // ...but with no continuation turn.run, the tool stays UNINVOKED.
    expect(counts.n).toBe(0)

    // And the continuation DOES run it once dispatched — the wire that the
    // driver loop supplies. This is the positive half of the same invariant.
    await session.turn.run()
    expect(counts.n).toBe(1)
  })

  test("deny mid-turn: respond lands (lease-free), tool stays UNINVOKED, normal deny aborts the turn", async () => {
    // The contrast to approve: a NORMAL approval deny is dispatchable mid-turn
    // (again proving no held lease blocks the respond) but sets NO grant lease,
    // so the continuation never runs the tool — and a normal deny is a turn
    // ABORT (byte-identical legacy, the driver throws). The mutating side-effect
    // never happens.
    const counts = { n: 0 }
    const runtime = await buildWebRuntime({
      llm: new ScriptedLLM([callTool("t1"), callTool("t1b"), endText]),
      registry: new ToolRegistry([mutatingTool(counts)]),
      permission: liveProxy("default"),
    })
    const session = await runtime.createSession({
      cwd: "/tmp/quanta-web-approval-mid-turn",
      permissionMode: "default",
    })
    cleanup = async () => {
      await session.close()
      await runtime.close()
    }

    let sawApproval = false
    let threw = false
    try {
      await driveSessionTurn({
        env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
        session,
        text: "do the dangerous thing",
        turnSignal: new AbortController().signal,
        resolveApproval: async () => {
          sawApproval = true
          return "deny"
        },
      })
    } catch {
      // A normal deny aborts the turn — the driver surfaces it as a throw.
      threw = true
    }

    // The approval was surfaced (the turn really suspended on the gate).
    expect(sawApproval).toBe(true)
    // Normal deny ⇒ turn aborts (byte-identical legacy).
    expect(threw).toBe(true)
    // The mutating side-effect was DECLINED — the tool body never ran.
    expect(counts.n).toBe(0)
  })

  test("default path: a turn with NO approval-required tool completes in one turn, no respond", async () => {
    // Byte-identical default: a read-only / no-gated-tool turn never suspends, so
    // the approval continuation machinery is inert (no approvalRequest, the
    // resolver is never invoked).
    let resolverCalls = 0
    const runtime = await buildWebRuntime({
      llm: new ScriptedLLM([endText]),
      registry: new ToolRegistry([]),
      permission: liveProxy("default"),
    })
    const session = await runtime.createSession({
      cwd: "/tmp/quanta-web-approval-mid-turn",
      permissionMode: "default",
    })
    cleanup = async () => {
      await session.close()
      await runtime.close()
    }

    const result = await driveSessionTurn({
      env: {}, // ADR-0528 — env threaded; empty ⇒ crash-resume marker gate-off (deterministic).
      session,
      text: "just say hi",
      turnSignal: new AbortController().signal,
      resolveApproval: async () => {
        resolverCalls += 1
        return "approve"
      },
    })
    expect(result.outcome.reason).toBe("completed")
    expect(resolverCalls).toBe(0)
  })
})

/* ------------------------------------------------------------------------- */
/* ADR-0540 W1-B — daemon-owned post-approval continuation                    */
/* ------------------------------------------------------------------------- */

/** In-memory duplex SessionTransport pair (mirrors the conformance harness in
 *  `tests/unit/ipc/session-transport.test.ts`): `client.send` delivers to the
 *  server handlers AND AWAITS them — so awaiting a command send observes the
 *  full bridge dispatch of that command (deterministic sequencing, no sleeps). */
const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
  const clientHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const build = (
    local: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(m: SessionTransportMessage) => void | Promise<void>>,
  ): SessionTransport => ({
    async send(message) {
      for (const handler of [...remote]) await handler(message)
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      local.clear()
    },
  })
  return {
    client: build(clientHandlers, serverHandlers),
    server: build(serverHandlers, clientHandlers),
  }
}

/** Client-side frame tap with a BOUNDED wait (the bound is a failure diagnostic,
 *  not a timing assertion — every sequencing claim rides the dispatch queue). */
const tapTransport = (transport: SessionTransport) => {
  const messages: SessionTransportMessage[] = []
  let notify: Array<() => void> = []
  transport.onMessage((m) => {
    messages.push(m)
    const waiters = notify
    notify = []
    for (const wake of waiters) wake()
  })
  const waitUntil = async <T>(
    pick: (msgs: readonly SessionTransportMessage[]) => T | undefined,
    label: string,
  ): Promise<T> => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const hit = pick(messages)
      if (hit !== undefined) return hit
      if (Date.now() > deadline) {
        const seen = messages
          .map((m) => (m.kind === "event" ? `event:${m.event.type}` : m.kind))
          .join(", ")
        throw new Error(`timed out waiting for ${label}; frames seen: [${seen}]`)
      }
      await new Promise<void>((resolve) => {
        notify.push(resolve)
        setTimeout(resolve, 25)
      })
    }
  }
  const eventsOfType = (type: SessionEvent["type"]): SessionEvent[] =>
    messages.flatMap((m) => (m.kind === "event" && m.event.type === type ? [m.event] : []))
  return { messages, waitUntil, eventsOfType }
}

/** Wire-shaped client commands (fresh commandId per frame, like the browser). */
const frame = (command: SessionCommand): SessionTransportMessage => ({ kind: "command", command })
const clientCommand = (
  sessionId: string,
  type: "turn.run" | "turn.cancel",
): SessionCommand & { commandId: string } => ({
  sessionId,
  commandId: crypto.randomUUID(),
  issuedAt: new Date().toISOString(),
  type,
})

/** Boot the web-daemon-shaped runtime + a wire client, with the W1-B
 *  continuation wiring installed under the given env (the daemon comp seam). */
const bootWireHarness = async (args: {
  readonly counts: { n: number }
  readonly env: Record<string, string | undefined>
  readonly serverAutoContinues?: true
}) => {
  const runtime = await buildWebRuntime({
    llm: new ScriptedLLM([callTool("t1"), callTool("t1b"), endText]),
    registry: new ToolRegistry([mutatingTool(args.counts)]),
    permission: liveProxy("default"),
    ...(args.serverAutoContinues === true ? { serverAutoContinues: true as const } : {}),
  })
  const session: RuntimeSession = await runtime.createSession({
    cwd: "/tmp/quanta-web-approval-mid-turn",
    permissionMode: "default",
  })
  const continuation = setupApprovalContinuation(session, args.env)
  const pair = createTransportPair()
  const tap = tapTransport(pair.client)
  await session.attachSessionTransport(pair.server)
  // Complete the connect handshake so commands are accepted and live events
  // fan out to this peer (the bridge gates both on `peer.connected`).
  await pair.client.send({ kind: "connect", sessionId: session.sessionId })
  const teardown = async (): Promise<void> => {
    continuation.unsub?.()
    await session.close()
    await runtime.close()
  }
  const sendCommand = async (command: SessionCommand): Promise<void> => {
    await pair.client.send(frame(command))
  }
  const startApprovalTurn = async (): Promise<{ approvalId: string; sentIds: string[] }> => {
    const sentIds: string[] = []
    const now = new Date().toISOString()
    const append: SessionCommand = {
      sessionId: session.sessionId,
      commandId: crypto.randomUUID(),
      issuedAt: now,
      type: "input.append",
      text: "do the dangerous thing",
    }
    sentIds.push(append.commandId)
    await sendCommand(append)
    const run = clientCommand(session.sessionId, "turn.run")
    sentIds.push(run.commandId)
    await sendCommand(run)
    const requested = await tap.waitUntil(
      (msgs) =>
        msgs.find(
          (m): m is SessionTransportMessage & { kind: "event" } =>
            m.kind === "event" && m.event.type === "approval.requested",
        ),
      "approval.requested",
    )
    const approvalId = (requested.event as SessionEvent & { type: "approval.requested" }).approval
      .approvalId
    return { approvalId, sentIds }
  }
  const respond = async (approvalId: string, decision: "approve" | "deny"): Promise<string> => {
    const command: SessionCommand = {
      sessionId: session.sessionId,
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      type: "approval.respond",
      approvalId,
      decision,
    }
    await sendCommand(command)
    return command.commandId
  }
  /** Deterministic quiescence probe: a benign command CHAINS BEHIND anything the
   *  daemon may have enqueued on the same dispatch tail — once its state echo
   *  arrives, every earlier continuation (if any) has already started+settled. */
  const probeQuiescent = async (): Promise<void> => {
    const probe: SessionCommand = {
      sessionId: session.sessionId,
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      type: "session.permission.set",
      mode: "default",
    }
    await sendCommand(probe)
    await tap.waitUntil(
      (msgs) =>
        msgs.find(
          (m) =>
            m.kind === "event" &&
            m.event.type === "session.state.updated" &&
            m.event.causedByCommandId === probe.commandId,
        ),
      "quiescence probe state echo",
    )
  }
  return {
    runtime,
    session,
    tap,
    teardown,
    sendCommand,
    startApprovalTurn,
    respond,
    probeQuiescent,
  }
}

describe("ADR-0540 W1-B: daemon-owned continuation (web leak sealed server-side)", () => {
  test("gate ON: approve WITHOUT any client turn.run re-issue — the DAEMON re-issues, the tool dispatches, the turn completes", async () => {
    const counts = { n: 0 }
    const harness = await bootWireHarness({
      counts,
      env: { QUANTA_INLINE_APPROVAL_RESOLVER: "1" },
      serverAutoContinues: true,
    })
    cleanup = harness.teardown

    const { approvalId, sentIds } = await harness.startApprovalTurn()
    expect(counts.n).toBe(0) // suspended on the gate — not yet dispatched

    // The ONLY client action: answer the approval. No follow-up turn.run frame.
    const respondId = await harness.respond(approvalId, "approve")
    sentIds.push(respondId)

    // The daemon-owned continuation must complete the turn.
    await harness.tap.waitUntil(
      (msgs) => msgs.find((m) => m.kind === "event" && m.event.type === "turn.completed"),
      "turn.completed via daemon re-issue",
    )
    expect(counts.n).toBe(1)

    // The continuation `turn.run` was DAEMON-MINTED: the second `turn.started`
    // is caused by a commandId this client never sent.
    const started = harness.tap.eventsOfType("turn.started")
    expect(started.length).toBe(2)
    const continuationCause = started[1]?.causedByCommandId
    expect(continuationCause).toBeDefined()
    expect(sentIds).not.toContain(continuationCause)

    // B-MED-7 — the daemon minted the continuation's commandId DETERMINISTICALLY
    // from the originating approvalId (`continuationCommandIdForApproval`), so a
    // marker-aware wire client can PREDICT it from the `approval.resolved` event
    // alone and adopt EXACTLY this turn (never a foreign peer's interleaved
    // turn.started — the multi-peer 승인 입양 정확화 fix). This is the load-bearing
    // daemon wire the correlator's precise-adoption arm keys on.
    expect(continuationCause).toBe(continuationCommandIdForApproval(approvalId))

    // The resolution reached the wire exactly once.
    expect(harness.tap.eventsOfType("approval.resolved").length).toBe(1)
  })

  test("gate ON: capability manifest declares serverAutoContinues=true (wire snapshot carrier + in-proc session.created)", async () => {
    const counts = { n: 0 }
    const harness = await bootWireHarness({
      counts,
      env: { QUANTA_INLINE_APPROVAL_RESOLVER: "1" },
      serverAutoContinues: true,
    })
    cleanup = harness.teardown

    // The connect handshake replied with a snapshot — the marker rides it.
    // The snapshot is the SOLE wire carrier of the manifest (see the ticket
    // docs/tickets/jul-16-session-created-tail-filter-drop.md, fixed as B:
    // the per-attach `session.created` is an in-proc notification only and
    // is never published to the transport bridge).
    const snapshot = await harness.tap.waitUntil(
      (msgs) =>
        msgs.find(
          (m): m is SessionTransportMessage & { kind: "snapshot" } => m.kind === "snapshot",
        ),
      "connect snapshot",
    )
    expect(snapshot.snapshot.capabilities.serverAutoContinues).toBe(true)

    // And the per-attach session.created IN-PROC notification carries the
    // SAME manifest (captured via `session.subscribe`, NOT the wire tap).
    const created: SessionEvent[] = []
    const unsub = harness.session.subscribe((event) => {
      if (event.type === "session.created") created.push(event)
    })
    const pair2 = createTransportPair()
    const connected = await harness.session.attachSessionTransport(pair2.client)
    unsub()
    await connected.close()
    const createdEvent = created[0]
    if (createdEvent?.type !== "session.created") throw new Error("expected session.created")
    expect(createdEvent.capabilityManifest.serverAutoContinues).toBe(true)

    // POSITIVE wire-absence pin: no `session.created` frame ever reached this
    // client's wire — not from its own attach (pre-fix: tail-filter +
    // handshake-gate drop) and not from the second attach above (pre-fix:
    // dup-seq noise fan-out to already-connected peers — removed by fix B).
    expect(harness.tap.eventsOfType("session.created").length).toBe(0)
  })

  test("gate OFF (explicit): respond alone does NOT auto-continue — tool stays uninvoked, manifest declares false", async () => {
    const counts = { n: 0 }
    const harness = await bootWireHarness({ counts, env: {} })
    cleanup = harness.teardown

    const snapshot = await harness.tap.waitUntil(
      (msgs) =>
        msgs.find(
          (m): m is SessionTransportMessage & { kind: "snapshot" } => m.kind === "snapshot",
        ),
      "connect snapshot",
    )
    // OFF ⇒ the additive marker normalizes to false (never undefined/true).
    expect(snapshot.snapshot.capabilities.serverAutoContinues).toBe(false)

    const { approvalId } = await harness.startApprovalTurn()
    await harness.respond(approvalId, "approve")

    // Deterministic (queue-ordered) proof of NO daemon continuation: a probe
    // command chains behind any would-be re-issue; when its echo arrives, no
    // second turn has started and the tool remains uninvoked. (The legacy
    // client re-issue path is what continues this flow — untouched here.)
    await harness.probeQuiescent()
    expect(counts.n).toBe(0)
    expect(harness.tap.eventsOfType("turn.started").length).toBe(1)
    expect(harness.tap.eventsOfType("turn.completed").length).toBe(0)
  })

  test("gate ON: deny settles idle — tool stays uninvoked, no second turn (result pin: a re-issue is unobservable here because deny clears the draft, so it could only reject empty_turn_input)", async () => {
    const counts = { n: 0 }
    const harness = await bootWireHarness({
      counts,
      env: { QUANTA_INLINE_APPROVAL_RESOLVER: "1" },
      serverAutoContinues: true,
    })
    cleanup = harness.teardown

    const { approvalId } = await harness.startApprovalTurn()
    await harness.respond(approvalId, "deny")

    await harness.probeQuiescent()
    // No continuation was enqueued: one turn.started (the original), no second.
    expect(harness.tap.eventsOfType("turn.started").length).toBe(1)
    expect(counts.n).toBe(0)
    const snap = await harness.session.snapshot()
    expect(snap.state.status).toBe("idle")
    expect(snap.pendingApproval).toBeNull()
  })

  test("gate ON pin (old-client protection): a duplicate bare turn.run after approve is BENIGN — exactly one execution, duplicate rejected empty_turn_input", async () => {
    // 2c investigation, pinned: the kernel reducer requires draft input for
    // `turn.run` (`empty_turn_input` otherwise) and the dispatch tail serializes
    // transport commands — so a non-marker-aware client that ALSO re-issues after
    // approve produces NO double tool run and NO double LLM turn. The duplicate
    // dispatches only after the daemon-continued turn completed (draft consumed)
    // and is deterministically rejected. No absorb layer is needed.
    const counts = { n: 0 }
    const harness = await bootWireHarness({
      counts,
      env: { QUANTA_INLINE_APPROVAL_RESOLVER: "1" },
      serverAutoContinues: true,
    })
    cleanup = harness.teardown

    const { approvalId } = await harness.startApprovalTurn()
    await harness.respond(approvalId, "approve")
    // Old-client behavior: re-issue a bare turn.run right after the respond.
    // Queue order is deterministic: respond → daemon turn.run → this duplicate.
    const dup = clientCommand(harness.session.sessionId, "turn.run")
    await harness.sendCommand(dup)

    await harness.probeQuiescent()
    // Exactly ONE execution and one completed continuation turn.
    expect(counts.n).toBe(1)
    expect(harness.tap.eventsOfType("turn.started").length).toBe(2)
    expect(harness.tap.eventsOfType("turn.completed").length).toBe(1)
    // The continuation that ran was the DAEMON's, not the duplicate: the
    // duplicate chained BEHIND the daemon re-issue on the dispatch tail, found
    // the draft consumed, and was rejected (`empty_turn_input`) — never started.
    const started = harness.tap.eventsOfType("turn.started")
    expect(started[1]?.causedByCommandId).toBeDefined()
    expect(started[1]?.causedByCommandId).not.toBe(dup.commandId)
    // The duplicate produced no third turn and the session settled idle.
    const snap = await harness.session.snapshot()
    expect(snap.state.status).toBe("idle")
    expect(snap.state.draftInput).toBe("")
  })

  test("gate ON (audit M-1): a DIRECT in-proc respond (no wire, no enqueue) still lands the continuation — enqueue chains behind the in-flight dispatch", async () => {
    // The adversarial audit proved the trap: a NON-queued respond still holds
    // the single-writer lease when the subscriber's enqueued continuation was
    // chained onto an EMPTY tail — without the engine's `activeDispatch` wait
    // the continuation starts inside the respond's own await window, rejects
    // `single_writer_lease_held`, and the approved tool is NEVER dispatched
    // (silent warn). This pins the deterministic fix.
    const counts = { n: 0 }
    const harness = await bootWireHarness({
      counts,
      env: { QUANTA_INLINE_APPROVAL_RESOLVER: "1" },
      serverAutoContinues: true,
    })
    cleanup = harness.teardown

    const { approvalId, sentIds } = await harness.startApprovalTurn()
    expect(counts.n).toBe(0)

    // DIRECT in-proc respond via the session verb — bypasses the transport
    // queue entirely (the exact M-1 producer class: future in-proc callers).
    await harness.session.approval.respond(approvalId, "approve")

    await harness.tap.waitUntil(
      (msgs) => msgs.find((m) => m.kind === "event" && m.event.type === "turn.completed"),
      "turn.completed via daemon re-issue after a DIRECT respond",
    )
    expect(counts.n).toBe(1)
    // Daemon-minted continuation: caused by a commandId this client never sent.
    const started = harness.tap.eventsOfType("turn.started")
    expect(started.length).toBe(2)
    expect(started[1]?.causedByCommandId).toBeDefined()
    expect(sentIds).not.toContain(started[1]?.causedByCommandId)
  })
})
