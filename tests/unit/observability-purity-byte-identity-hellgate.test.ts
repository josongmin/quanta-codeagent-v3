/**
 * Hellgate — DEFAULT-ON SAFETY audit for the two "pure-observational" features:
 *   1. item-stream-fine-grained (QUANTA_ITEM_STREAM)
 *   2. passive-vcs-classify    (QUANTA_PASSIVE_VCS)
 *
 * The sibling suites prove the projector/classifier LOGIC and the ON-path
 * fan-out. THIS suite pins the load-bearing DEFAULT-ON claim the sibling suites
 * only touch at the first event: turning either feature ON must ADD to an
 * OBSERVABILITY sink WITHOUT mutating the BASE agent-event stream — proven over a
 * WHOLE multi-event turn sequence (not just `seen[0]`), including the S2
 * plan-suppression seam which re-routes plan state INSIDE the observability
 * plane only.
 *
 * The distinction this suite makes explicit (and which the DEFAULT-ON verdict
 * turns on):
 *   - item-stream: extra events land on a SEPARATE sink (`onAgentState`); the
 *     base `stream` the loop emits onto is byte-identical ON vs OFF. Re-routing
 *     the plan trio (S2) happens purely on the observability sink, never on the
 *     base stream.
 *   - passive-vcs: extra `recovery`/`vcs_event` events land ON the base
 *     `AgentEvent` stream itself (documented additive). This suite proves the
 *     stream is a pure OUTPUT fan-out (StreamPort = `emit(): void`, no read-back)
 *     and that these events are ADDITIVE-ONLY: every pre-existing event is
 *     carried verbatim + in-order, the feature only APPENDS.
 *
 * RED-on-injection: a projector arm that mutated a base event, or a wire that
 * dropped/re-ordered a base event, turns these red.
 */
import { describe, expect, test } from "bun:test"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { AgentConfig } from "@/agent/types"
import { createPassiveVcsStreamSink } from "@/host/runtime/agent-config-assembler"
import type { LLMPort } from "@/llm"
import type { AgentStateObservation } from "@/protocol/agent-state"
import type { AgentEvent, StreamPort } from "@/stream"

// A canonical, realistic turn: reasoning → a bash tool call+progress+result →
// a plan snapshot+update → a final answer → done. Exercises EVERY projector arm
// (reasoning / tool / plan / turn boundary) in one sequence.
const TURN: readonly AgentEvent[] = [
  { type: "assistant_thinking", delta: "let me " },
  { type: "assistant_thinking", delta: "think" },
  { type: "tool_call", id: "t1", name: "bash" },
  { type: "tool_progress", id: "t1", message: "running" },
  { type: "tool_result", id: "t1" } as AgentEvent,
  { type: "plan_created", plan: { id: "p1", name: "n", version: 1, todos: [] } } as AgentEvent,
  {
    type: "plan_updated",
    delta: { kind: "todo_status_changed", todoId: "x", fromStatus: "pending", toStatus: "done" },
    version: 2,
  } as AgentEvent,
  { type: "assistant_text", text: "here is the answer" } as AgentEvent,
  { type: "done" } as AgentEvent,
]

const capturingStream = (): { stream: StreamPort; seen: AgentEvent[] } => {
  const seen: AgentEvent[] = []
  return { stream: { emit: (e) => void seen.push(e) }, seen }
}

const baseWith = (
  stream: StreamPort,
  onAgentState?: { capture(e: AgentStateObservation): void },
): AgentConfig =>
  ({
    llm: { model: "m" } as unknown as LLMPort,
    signal: new AbortController().signal,
    stream,
    ...(onAgentState !== undefined ? { onAgentState } : {}),
  }) as unknown as AgentConfig

const drive = (out: AgentConfig): void => {
  for (const ev of TURN) out.stream.emit(ev)
}

/* ================================================================== */
/*  1. item-stream — base stream byte-identical, extra to a SIDE sink  */
/* ================================================================== */

describe("item-stream — NON-BEHAVIORAL base-stream byte-identity over a whole turn", () => {
  test("base stream is BYTE-IDENTICAL ON vs OFF (extra events go to onAgentState, not the base)", () => {
    // OFF reference: no gate. Base stream captures the canonical sequence.
    const off = capturingStream()
    drive(wireOptionalAgentPorts(baseWith(off.stream), {}))

    // ON: item-stream + web-agent-state gates on, a sink present.
    const on = capturingStream()
    const captured: AgentStateObservation[] = []
    const onCfg = wireOptionalAgentPorts(
      baseWith(on.stream, { capture: (e) => void captured.push(e) }),
      { QUANTA_ITEM_STREAM: "1", QUANTA_WEB_AGENT_STATE: "1" },
    )
    drive(onCfg)

    // THE base-stream byte-identity: the loop's own event stream is carried
    // verbatim + in-order + same length whether or not the feature is on.
    expect(on.seen).toEqual(off.seen)
    expect(on.seen).toEqual([...TURN])

    // Not vacuous: the ON run DID additively feed the separate observability
    // sink with item.* cores (the fan-out actually happened).
    const itemObs = captured.filter((o) => o.type === "item_stream")
    expect(itemObs.length).toBeGreaterThan(0)
  })

  test("S2 plan re-routing happens ONLY on the observability sink — base stream unchanged", () => {
    // When item-stream owns plan, the plan.* host-mirror observation is
    // suppressed and plan flows as item.* cores. Prove that re-routing NEVER
    // touches the base stream: the plan_created/plan_updated events are still
    // carried verbatim on the base stream, and are the SUPPRESSED ones on the
    // sink (moved to item.*), i.e. no plan_* mirror observation, but plan item
    // cores present.
    const on = capturingStream()
    const captured: AgentStateObservation[] = []
    drive(
      wireOptionalAgentPorts(baseWith(on.stream, { capture: (e) => void captured.push(e) }), {
        QUANTA_ITEM_STREAM: "1",
        QUANTA_WEB_AGENT_STATE: "1",
      }),
    )
    // Base stream still carries the raw plan events (never suppressed there).
    expect(on.seen.filter((e) => e.type === "plan_created")).toHaveLength(1)
    expect(on.seen.filter((e) => e.type === "plan_updated")).toHaveLength(1)
    // Sink: plan is on item.* only, NOT double-carried as a plan_* mirror.
    const planMirror = captured.filter(
      (o) => o.type === "plan_created" || o.type === "plan_updated" || o.type === "plan_snapshot",
    )
    expect(planMirror).toHaveLength(0)
    const planItems = captured.filter(
      (o) => o.type === "item_stream" && o.item.itemType === "plan",
    )
    expect(planItems.length).toBeGreaterThan(0)
  })

  test("a throwing observability sink can NEVER perturb the base stream", () => {
    const on = capturingStream()
    const hostile = {
      capture: () => {
        throw new Error("hostile sink")
      },
    }
    const cfg = wireOptionalAgentPorts(baseWith(on.stream, hostile), {
      QUANTA_ITEM_STREAM: "1",
      QUANTA_WEB_AGENT_STATE: "1",
    })
    expect(() => drive(cfg)).not.toThrow()
    // Base stream is STILL byte-identical even though every sink call threw.
    expect(on.seen).toEqual([...TURN])
  })
})

/* ================================================================== */
/*  2. passive-vcs — StreamPort is a pure OUTPUT fan-out; ADDITIVE     */
/* ================================================================== */

describe("passive-vcs — the base stream is a pure OUTPUT fan-out (no read-back into decisions)", () => {
  test("the sink adapter only ever APPENDS a recovery/vcs_event — pre-existing events verbatim", () => {
    // Emit a normal turn onto the base stream, THEN let the passive-vcs adapter
    // append its classified event. Prove: (a) the adapter emits exactly ONE
    // additive `recovery`/`vcs_event` event, (b) it NEVER mutates or drops any
    // pre-existing event (the whole prefix is byte-identical to the raw turn).
    const seen: AgentEvent[] = []
    const stream: StreamPort = { emit: (e) => void seen.push(e) }
    for (const ev of TURN) stream.emit(ev)
    const prefix = [...seen]

    const sink = createPassiveVcsStreamSink(stream)
    sink.emit({ commit: { kind: "commit", sha: "abc1234" } })

    // Every pre-existing event is carried verbatim + in-order (additive-only).
    expect(seen.slice(0, prefix.length)).toEqual(prefix)
    // Exactly ONE additive event was appended, and it is a recovery/vcs_event.
    expect(seen.length).toBe(prefix.length + 1)
    const appended = seen[seen.length - 1]
    expect(appended?.type).toBe("recovery")
    expect((appended as { reason?: string }).reason).toBe("vcs_event")
  })

  test("a dead base stream can NEVER poison the bash turn (adapter is no-throw)", () => {
    const deadStream: StreamPort = {
      emit: () => {
        throw new Error("dead stream")
      },
    }
    const sink = createPassiveVcsStreamSink(deadStream)
    // The adapter swallows the throw — a broken observability stream must never
    // break the bash turn that produced the event.
    expect(() => sink.emit({ pr: { number: 7 } })).not.toThrow()
  })
})
