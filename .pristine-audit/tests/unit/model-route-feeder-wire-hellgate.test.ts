/**
 * RFC02-3 (A8, FEEDER) — operator-`/retry-with` + scheduler-reroute route-sink
 * FEEDER WIRE hellgate.
 *
 * The prior A8 wire hellgate (`model-route-sink-wire-hellgate`) pinned the
 * PROVIDER-FALLBACK feeder: the gated forwarder is handed to `deps.buildLlm`, so
 * a real `FallbackLLM` swap emits `model_route_changed`. But the OTHER two route
 * causes — an operator `/retry-with` model swap and a scheduler reroute onto a
 * fallback — had their `onModelReroute` CALL sites + adapters proven only with a
 * TEST-wired sink. NOTHING in production attached the forwarder sink to those
 * slots, so those two causes NEVER reached the live stream.
 *
 * This gate pins the FEEDER wire that closes the gap:
 *
 *   1. `buildRetryState` (the `/retry-with` state factory) attaches the SAME
 *      gated forwarder sink to `RetryWithSessionState.onModelReroute` when (and
 *      only when) the host forwarded one. Driving the REAL `retryWithCmd`
 *      against the produced state emits `model_route_changed` onto the sink.
 *   2. `buildAutomationRerouteDeps` attaches the SAME sink to the scheduler's
 *      `assembleAutomation` `onModelReroute`. Driving the REAL handler with a
 *      preferred-model-DOWN fire emits the scheduler-owned transition.
 *   3. Gate-OFF (sink absent): BOTH omit `onModelReroute` ⇒ the swap/reroute is
 *      byte-identical (no route observation) — proven by asserting the behavior
 *      still happens while ZERO events are seen.
 *   4. Red-on-injection: DROP the sink from the attach ⇒ the event is gone.
 *   5. Sink-throw isolation: a throwing forwarder sink never breaks the retry
 *      swap (retry surfaces stream errors, but NOT the sink's own throw).
 *
 * The SAME `buildRouteEventForwarder` (production) is the sink under test in the
 * gate-ON arms, so the feeder rides the EXACT deferred forwarder the FallbackLLM
 * path uses — one sink, three causes.
 */

import { describe, expect, test } from "bun:test"
import { buildRouteEventForwarder } from "@/host/bootstrap/bootstrap-session"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { EngineAutomation } from "@/scheduler/automation-engine"
import { AUTOMATION_ENV_FLAG, assembleAutomation } from "@/scheduler/runtime-wire"
import type { AgentLoopPort, ModelAvailabilityPort, RRule } from "@/scheduler/types"
import type { AgentEvent } from "@/stream"
import { buildAutomationRerouteDeps } from "../../src/apps/cli/repl/session-loop/bootstrap"
import { buildRetryState } from "../../src/apps/cli/repl/surface-compose/dispatch-compose"
import { retryWithCmd } from "../../src/apps/cli/retry-with"
import type { SlashContext } from "../../src/apps/cli/slash-commands"

// ── shared scaffolding ──────────────────────────────────────────────────────

class ScriptedLLM implements LLMPort {
  public calls = 0
  constructor(
    public readonly model: string,
    private readonly events: StreamEvent[],
  ) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    for (const ev of this.events) yield ev
  }
}

const asstMsg = (text: string, id: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  id,
})
const userMsg = (text: string, id: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  id,
})

const twoCandidates = () => [
  { id: "sonnet", port: new ScriptedLLM("sonnet", []) },
  {
    id: "opus",
    port: new ScriptedLLM("opus", [
      { type: "text_delta", delta: "swapped" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]),
  },
]

const emptyStreamInput: StreamInput = { messages: [], tools: [] }

/** Wire a RetryWithSessionState onto a fresh SlashContext + drive the real
 *  slash command, returning the exit code + captured stdout/stderr. */
const runRetry = async (
  state: ReturnType<typeof buildRetryState>,
  args: string[],
): Promise<{ code: number; out: string; err: string }> => {
  let out = ""
  let err = ""
  const ctx: SlashContext = {
    out: (s) => {
      out += s
    },
    err: (s) => {
      err += s
    },
    cwd: "/tmp",
    ...(state !== undefined ? { retry: state } : {}),
  }
  const code = await retryWithCmd.run(args, ctx)
  return { code, out, err }
}

// ── scheduler scaffolding ───────────────────────────────────────────────────

const RULE: RRule = { freq: "DAILY", interval: 1 }
const availabilityOf = (up: ReadonlySet<string>): ModelAvailabilityPort => ({
  isAvailable: async (m) => up.has(m),
})
const makeEnv = (o: Record<string, string>): { get: (k: string) => string | undefined } => {
  const m = new Map(Object.entries(o))
  return { get: (k) => m.get(k) }
}
const automationOf = (over: Partial<EngineAutomation>): EngineAutomation => ({
  id: "a1",
  title: "t",
  rule: RULE,
  prompt: "do it",
  nextRunAt: 0,
  status: "scheduled",
  createdAt: 0,
  fireCount: 0,
  ...over,
})
const noopEnqueue: Parameters<typeof buildAutomationRerouteDeps>[0]["enqueueUserMessage"] =
  async () => {}

// ═══════════════════════════════════════════════════════════════════════════
// 1. /retry-with feeder wire — buildRetryState attaches the forwarder sink
// ═══════════════════════════════════════════════════════════════════════════

describe("RFC02-3 A8 feeder — /retry-with attaches the gated forwarder sink", () => {
  test("[crown] gate ON: a real /retry-with swap emits model_route_changed onto the bound forwarder", async () => {
    const forwarder = buildRouteEventForwarder({ QUANTA_MODEL_REROUTE_EVENT: "1" })
    const emitted: AgentEvent[] = []
    // Bind the deferred forwarder to a live sink — exactly the host mechanism.
    forwarder.bind?.((ev) => emitted.push(ev))

    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const state = buildRetryState({
      streamInput: emptyStreamInput,
      retryEnabled: true,
      candidates: twoCandidates(),
      currentModelId: "sonnet",
      messages,
      signal: new AbortController().signal,
      onEvent: () => {},
      ...(forwarder.sink !== undefined ? { routeEventSink: forwarder.sink } : {}),
    })
    // The factory MUST have attached the sink.
    expect(state?.onModelReroute).toBeDefined()

    const { code } = await runRetry(state, ["opus"])
    expect(code).toBe(0)
    const route = emitted.find((e) => e.type === "model_route_changed")
    expect(route).toMatchObject({
      type: "model_route_changed",
      fromModel: "sonnet",
      toModel: "opus",
      reason: "operator_requested",
      routeKind: "operator_retry",
    })
  })

  test("[byte-identical] gate OFF: sink absent ⇒ onModelReroute OMITTED ⇒ swap still works, ZERO observation", async () => {
    const forwarder = buildRouteEventForwarder({}) // gate off ⇒ sink undefined
    expect(forwarder.sink).toBeUndefined()
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const state = buildRetryState({
      streamInput: emptyStreamInput,
      retryEnabled: true,
      candidates: twoCandidates(),
      currentModelId: "sonnet",
      messages,
      signal: new AbortController().signal,
      onEvent: () => {},
      ...(forwarder.sink !== undefined ? { routeEventSink: forwarder.sink } : {}),
    })
    // The state IS a live retry state (NOT undefined) — else the `?.` below would
    // pass vacuously. Only the route hook is omitted.
    expect(state).toBeDefined()
    expect(state?.onModelReroute).toBeUndefined()
    // The swap itself STILL happens: assistant dropped, exit 0.
    const { code } = await runRetry(state, ["opus"])
    expect(code).toBe(0)
    expect(messages.map((m) => m.role)).toEqual(["user"])
  })

  test("[red-on-injection] gate ON but the attach is DROPPED ⇒ swap works, NO event", async () => {
    const forwarder = buildRouteEventForwarder({ QUANTA_MODEL_REROUTE_EVENT: "1" })
    const emitted: AgentEvent[] = []
    forwarder.bind?.((ev) => emitted.push(ev))
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    // INJECTION: build the state WITHOUT forwarding the sink (drop the attach).
    const state = buildRetryState({
      streamInput: emptyStreamInput,
      retryEnabled: true,
      candidates: twoCandidates(),
      currentModelId: "sonnet",
      messages,
      signal: new AbortController().signal,
      onEvent: () => {},
      // routeEventSink deliberately omitted.
    })
    expect(state).toBeDefined()
    expect(state?.onModelReroute).toBeUndefined()
    const { code } = await runRetry(state, ["opus"])
    expect(code).toBe(0)
    // The forwarder IS live-bound (emitted would capture) — the DROP is the only
    // reason no event flows, not a dead forwarder.
    expect(emitted.some((e) => e.type === "model_route_changed")).toBe(false)
  })

  test("[isolation] a THROWING forwarder target never breaks the retry swap", async () => {
    const forwarder = buildRouteEventForwarder({ QUANTA_MODEL_REROUTE_EVENT: "1" })
    // Bind a target that throws — the retry emit path must not leak it.
    forwarder.bind?.(() => {
      throw new Error("sink boom")
    })
    const messages: Message[] = [userMsg("q", "u1"), asstMsg("a", "a1")]
    const state = buildRetryState({
      streamInput: emptyStreamInput,
      retryEnabled: true,
      candidates: twoCandidates(),
      currentModelId: "sonnet",
      messages,
      signal: new AbortController().signal,
      onEvent: () => {},
      ...(forwarder.sink !== undefined ? { routeEventSink: forwarder.sink } : {}),
    })
    let thrown: unknown
    try {
      await runRetry(state, ["opus"])
    } catch (e) {
      thrown = e
    }
    const msg = thrown instanceof Error ? thrown.message : String(thrown ?? "")
    expect(msg).not.toContain("sink boom")
    // The swap still completed.
    expect(messages.map((m) => m.role)).toEqual(["user"])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. scheduler feeder wire — buildAutomationRerouteDeps attaches the sink
// ═══════════════════════════════════════════════════════════════════════════

describe("RFC02-3 A8 feeder — scheduler attaches the gated forwarder sink", () => {
  const driveReroute = async (deps: Parameters<typeof assembleAutomation>[1]): Promise<void> => {
    const slot = assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "on" }), {
      ...deps,
      modelAvailability: availabilityOf(new Set(["gpt-5.4"])), // preference DOWN
      now: () => 1234,
    })
    if (slot === null) throw new Error("unreachable")
    await slot.handler(automationOf({ model: "gpt-5.5", modelFallbacks: ["gpt-5.4", "gpt-5"] }))
  }

  test("[crown] gate ON: a preferred-DOWN fire emits scheduler_reroute onto the bound forwarder", async () => {
    const forwarder = buildRouteEventForwarder({ QUANTA_MODEL_REROUTE_EVENT: "1" })
    const emitted: AgentEvent[] = []
    forwarder.bind?.((ev) => emitted.push(ev))
    const deps = buildAutomationRerouteDeps({
      enqueueUserMessage: noopEnqueue,
      ...(forwarder.sink !== undefined ? { routeEventSink: forwarder.sink } : {}),
    })
    expect(deps.onModelReroute).toBeDefined()
    await driveReroute(deps)
    expect(emitted).toEqual([
      {
        type: "model_route_changed",
        fromModel: "gpt-5.5",
        toModel: "gpt-5.4",
        reason: "preferred_unavailable",
        routeKind: "scheduler_reroute",
        at: 1234,
      },
    ])
  })

  test("[byte-identical] gate OFF: sink absent ⇒ onModelReroute OMITTED ⇒ reroute still dispatches, ZERO observation", async () => {
    const forwarder = buildRouteEventForwarder({}) // gate off
    expect(forwarder.sink).toBeUndefined()
    const dispatched: Array<string | undefined> = []
    const loop: AgentLoopPort = {
      enqueueUserMessage: async (_m, opts) => {
        dispatched.push(opts?.modelOverride)
      },
    }
    const deps = buildAutomationRerouteDeps({
      enqueueUserMessage: loop.enqueueUserMessage,
      ...(forwarder.sink !== undefined ? { routeEventSink: forwarder.sink } : {}),
    })
    expect(deps.onModelReroute).toBeUndefined()
    await driveReroute(deps)
    // The reroute DID happen (fallback dispatched) — byte-identical behavior.
    expect(dispatched).toEqual(["gpt-5.4"])
  })

  test("[red-on-injection] gate ON but the attach is DROPPED ⇒ reroute dispatches, NO event", async () => {
    const forwarder = buildRouteEventForwarder({ QUANTA_MODEL_REROUTE_EVENT: "1" })
    const emitted: AgentEvent[] = []
    forwarder.bind?.((ev) => emitted.push(ev))
    // INJECTION: build deps WITHOUT the sink (drop the attach).
    const deps = buildAutomationRerouteDeps({ enqueueUserMessage: noopEnqueue })
    expect(deps.onModelReroute).toBeUndefined()
    await driveReroute(deps)
    expect(emitted.some((e) => e.type === "model_route_changed")).toBe(false)
  })
})
