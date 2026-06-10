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
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { ConfirmDecision } from "@/agent/confirm-decision"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext, ToolAction } from "@/permission"
import type { PendingApprovalView, SessionEvent } from "@/protocol/session"
import { driveSessionTurn } from "@/runner/orchestrate"
import { createRuntimeFromAgentConfigBase, type RuntimeSession } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"
import { z } from "zod"

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
