/**
 * Hellgate — S2 unified-observability (jul-03): the plan + subagent models FOLD
 * into the ONE item-stream, on BOTH wire planes, WITHOUT forking a 4th path.
 *
 * The disjoint pre-S2 models:
 *   - plan state flowed as `plan.*` host-mirror messages (agent-state channel)
 *   - subagent lifecycle flowed as activity-spine `subagent` L0 roots
 * S2 folds `plan_created` / `plan_updated` / `plan_snapshot` / `subagent_cancel`
 * onto co-equal {@link ItemStreamCore}s via the SINGLE {@link ItemStreamProjector}.
 *
 * Invariants (RED-on-injection — a dropped projector arm or a drifted transport
 * field turns these red):
 *   1. plan_created / plan_snapshot ⇒ a `plan` item core is emitted (NOT `[]`).
 *   2. plan_updated ⇒ a `plan` delta core (deltaKind = plan.patch).
 *   3. subagent_cancel ⇒ a `subagent` item core.
 *   4. the DAG rides the payload: blockedBy = dependencies, owner = assignee,
 *      a `blocked` todo status is carried INSIDE the plan (not a 5th itemType).
 *   5. BOTH wire planes (session.v1 `item.*`, web agent-state `item.*`) carry the
 *      new-typed cores byte-identically (they pass `itemType` verbatim).
 *   6. NO 4th path: when the item-stream OWNS plan, the `plan.*` host-mirror
 *      observation is suppressed so the web plane does not double-carry plan
 *      state on both `plan.*` AND `item.*`.
 */
import { describe, expect, test } from "bun:test"
import { fleetToItemStream, pumpFleetRowsToItemStream } from "@/activity"
import {
  projectAgentEventToItemStreamObservationsGated,
  wireOptionalAgentPorts,
} from "@/agent/optional-ports"
import type { AgentConfig } from "@/agent/types"
import type { AgentFleetRow } from "@/apps/cli/agents-fleet-panel"
import { BUILTINS, runSlashCommand } from "@/apps/cli/slash-commands"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { createKernelSessionState } from "@/kernel/session"
import { projectSessionHostTurnEvent } from "@/kernel/session/session-host-turn-event-projection"
import type { LLMPort } from "@/llm"
import type { AgentStateMessage, AgentStateObservation } from "@/protocol/agent-state"
import { itemCoreToAgentStateMessage } from "@/protocol/agent-state"
import type { SessionEvent } from "@/protocol/session"
import type { ItemStreamCore, ItemStreamSink } from "@/shared"
import type { AgentEvent, PlanReadonlyMirror, StreamPort } from "@/stream"
import { ItemStreamProjector } from "@/stream"

const manifest = {
  approvals: "operator" as const,
  tools: true,
  memory: false,
  artifacts: true,
  subagents: true,
  automation: false,
  shellSnapshot: false,
  transport: "inproc" as const,
}

const PLAN: PlanReadonlyMirror = {
  id: "plan-1",
  name: "ship it",
  version: 1,
  todos: [
    { id: "a", title: "root", status: "in_progress", assignee: "scout", activeForm: "Rooting" },
    { id: "b", title: "dependent", status: "blocked", dependencies: ["a"], assignee: "builder" },
  ],
}

const planCreated: AgentEvent = { type: "plan_created", plan: PLAN }
const planSnapshot: AgentEvent = { type: "plan_snapshot", plan: PLAN }
const planUpdated: AgentEvent = {
  type: "plan_updated",
  delta: {
    kind: "todo_status_changed",
    todoId: "b",
    fromStatus: "blocked",
    toStatus: "in_progress",
  },
  version: 2,
}
const subagentCancel: AgentEvent = {
  type: "subagent_cancel",
  subagentId: "sub-9",
  outcome: "stopped",
  source: "submission_op",
}

const collect = (events: readonly AgentEvent[]): ItemStreamCore[] => {
  const p = new ItemStreamProjector()
  const out: ItemStreamCore[] = []
  for (const ev of events) out.push(...p.project(ev))
  return out
}

describe("S2 fold — plan events become plan item cores", () => {
  test("plan_created emits a `plan` item core (not dropped by default arm)", () => {
    const cores = collect([planCreated])
    expect(cores.length).toBeGreaterThan(0)
    expect(cores.every((c) => c.itemType === "plan")).toBe(true)
    const completed = cores.find((c) => c.phase === "completed")
    expect(completed).toBeDefined()
    // The DAG rides the completed body as JSON: blockedBy=dependencies,
    // owner=assignee, a `blocked` status carried INSIDE the plan payload.
    const body = JSON.parse((completed as { text: string }).text) as PlanReadonlyMirror
    expect(body.todos.find((t) => t.id === "b")?.dependencies).toEqual(["a"])
    expect(body.todos.find((t) => t.id === "b")?.status).toBe("blocked")
    expect(body.todos.find((t) => t.id === "a")?.assignee).toBe("scout")
    expect(body.todos.find((t) => t.id === "a")?.activeForm).toBe("Rooting")
  })

  test("plan_snapshot emits a `plan` item core", () => {
    const cores = collect([planSnapshot])
    expect(cores.some((c) => c.itemType === "plan")).toBe(true)
  })

  test("plan_updated emits a `plan` delta core with deltaKind plan.patch", () => {
    // Open the plan item first, then update it.
    const cores = collect([planCreated, planUpdated])
    const delta = cores.find((c) => c.phase === "delta" && c.itemType === "plan")
    expect(delta).toBeDefined()
    expect((delta as { deltaKind: string }).deltaKind).toBe("plan.patch")
  })
})

describe("S2 fold — subagent_cancel becomes a subagent item core", () => {
  test("subagent_cancel emits a `subagent` item core carrying the outcome", () => {
    const cores = collect([subagentCancel])
    expect(cores.length).toBeGreaterThan(0)
    expect(cores.some((c) => c.itemType === "subagent")).toBe(true)
    const completed = cores.find((c) => c.phase === "completed" && c.itemType === "subagent")
    expect(completed).toBeDefined()
    expect((completed as { text?: string }).text).toContain("stopped")
  })
})

/** The item-identifying fields a transport MUST carry (normalized). */
const coreFields = (item: ItemStreamCore): Record<string, unknown> => ({
  phase: item.phase,
  itemId: item.itemId,
  itemType: item.itemType,
  ...(item.phase === "started" ? { index: item.index } : {}),
  ...(item.phase === "delta" ? { deltaKind: item.deltaKind, delta: item.delta } : {}),
  ...(item.phase === "completed" ? { text: item.text } : {}),
})

const sessionEventFields = (e: SessionEvent): Record<string, unknown> => {
  if (e.type === "item.started") {
    return { phase: "started", itemId: e.itemId, itemType: e.itemType, index: e.itemIndex }
  }
  if (e.type === "item.delta") {
    return {
      phase: "delta",
      itemId: e.itemId,
      itemType: e.itemType,
      deltaKind: e.deltaKind,
      delta: e.delta,
    }
  }
  if (e.type === "item.completed") {
    return {
      phase: "completed",
      itemId: e.itemId,
      itemType: e.itemType,
      ...(e.text !== undefined ? { text: e.text } : { text: undefined }),
    }
  }
  throw new Error(`not an item event: ${e.type}`)
}

const agentStateFields = (m: AgentStateMessage): Record<string, unknown> => {
  if (m.kind === "item.started") {
    return { phase: "started", itemId: m.itemId, itemType: m.itemType, index: m.itemIndex }
  }
  if (m.kind === "item.delta") {
    return {
      phase: "delta",
      itemId: m.itemId,
      itemType: m.itemType,
      deltaKind: m.deltaKind,
      delta: m.delta,
    }
  }
  if (m.kind === "item.completed") {
    return {
      phase: "completed",
      itemId: m.itemId,
      itemType: m.itemType,
      ...(m.text !== undefined ? { text: m.text } : { text: undefined }),
    }
  }
  throw new Error(`not an item message: ${m.kind}`)
}

describe("S2 dual-plane — plan + subagent cores carry byte-identically on BOTH planes", () => {
  test("session plane === agent-state plane for every folded core", () => {
    const cores = collect([planCreated, planUpdated, subagentCancel])
    // Not vacuous: the new item types actually appear.
    expect(cores.some((c) => c.itemType === "plan")).toBe(true)
    expect(cores.some((c) => c.itemType === "subagent")).toBe(true)

    const state = createKernelSessionState({
      sessionId: "s2-drift",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    for (const core of cores) {
      const sessionEvent = projectSessionHostTurnEvent({
        state,
        commandId: "c1",
        emittedAt: "2026-07-03T00:00:00.000Z",
        event: { type: "item.stream", item: core },
      }).emitted
      const message = itemCoreToAgentStateMessage(core, 1234)
      const expected = coreFields(core)
      expect(sessionEventFields(sessionEvent)).toEqual(expected)
      expect(agentStateFields(message)).toEqual(expected)
    }
  })
})

describe("S2 progressCard — taxonomy-only, NO projector arm (byte-safe inert)", () => {
  test("a progress_update event produces NO item core (progressCard has no producer)", () => {
    // The `progressCard` itemType + `progressCard.step` deltaKind are additive
    // taxonomy ONLY — S2 shipped no projector arm for them. A `progress_update`
    // AgentEvent must therefore fall to the default arm and emit nothing. If a
    // future edit adds an unguarded producer arm, this goes red (visible, not a
    // silent 4th surface path).
    const p = new ItemStreamProjector()
    const progressUpdate: AgentEvent = { type: "progress_update", currentStep: "step 1", turn: 0 }
    expect(p.project(progressUpdate)).toEqual([])
  })

  test("progress_update interleaved in a reasoning run does NOT split it (transient)", () => {
    const p = new ItemStreamProjector()
    p.project({ type: "assistant_thinking", delta: "a" })
    const progressUpdate: AgentEvent = { type: "progress_update", currentStep: "mid" }
    expect(p.project(progressUpdate)).toEqual([])
    const more = p.project({ type: "assistant_thinking", delta: "b" })
    // Same reasoning run — a delta only, no fresh `started` (progress_update did
    // not close reasoning), proving the default arm is truly inert.
    expect(more.map((c) => c.phase)).toEqual(["delta"])
  })
})

describe("S2 fleet bridge — ActivityStore subagent snapshot folds into a subagent item core", () => {
  test("a running row is an OPEN subagent item (started only, live spinner)", () => {
    const cores = fleetToItemStream([
      { id: "s1", description: "scout", status: "running", startedAt: 1 },
    ])
    expect(cores.length).toBe(1)
    expect(cores[0]?.phase).toBe("started")
    expect(cores[0]?.itemType).toBe("subagent")
  })

  test("a settled row completes with L0->L2 drilldown detail in the body", () => {
    const cores = fleetToItemStream([
      {
        id: "s2",
        description: "builder",
        agentType: "coder",
        status: "completed",
        startedAt: 1,
        endedAt: 9,
        result: { ok: true, finalText: "done", turns: 4 },
      },
    ])
    const completed = cores.find((c) => c.phase === "completed" && c.itemType === "subagent")
    expect(completed).toBeDefined()
    const detail = JSON.parse((completed as { text: string }).text) as Record<string, unknown>
    expect(detail.id).toBe("s2") // L0
    expect(detail.agentType).toBe("coder") // L0
    expect(detail.status).toBe("done") // L1 (mapped into SSOT vocab)
    expect(detail.turns).toBe(4) // L2
    expect(detail.finalText).toBe("done") // L2
  })

  test("monotonic index across the fleet snapshot", () => {
    const cores = fleetToItemStream([
      { id: "a", description: "x", status: "running", startedAt: 1 },
      { id: "b", description: "y", status: "running", startedAt: 1 },
    ])
    const starts = cores.filter((c) => c.phase === "started")
    expect((starts[1] as { index: number }).index).toBeGreaterThan(
      (starts[0] as { index: number }).index,
    )
  })

  // The fleet bridge is currently an INERT producer — no production caller feeds
  // its cores onto the wire yet (only this suite exercises it). It is a leaf
  // producer awaiting a consumer, so we pin the CONTRACT it must honour: the two
  // subagent producers (the projector's `subagent_cancel` arm and this fleet
  // bridge) MUST mint the SAME `item-subagent-<id>` itemId so a surface joins the
  // fleet row to its cancel/L0 root on ONE item taxonomy (the "unify" claim). If
  // either producer's id scheme drifts, the join silently breaks — red here.
  test("fleet bridge + subagent_cancel arm agree on the item-subagent-<id> join key", () => {
    const [fleetStart] = fleetToItemStream([
      { id: "sub-9", description: "scout", status: "running", startedAt: 1 },
    ])
    const cancelCores = collect([
      {
        type: "subagent_cancel",
        subagentId: "sub-9",
        outcome: "stopped",
        source: "submission_op",
      } as AgentEvent,
    ])
    expect(fleetStart?.itemId).toBe("item-subagent-sub-9")
    expect(cancelCores.every((c) => c.itemId === "item-subagent-sub-9")).toBe(true)
    expect(fleetStart?.itemType).toBe("subagent")
    expect(cancelCores.every((c) => c.itemType === "subagent")).toBe(true)
  })
})

describe("S2 no-4th-path — plan.* host-mirror is suppressed when item-stream owns plan", () => {
  test("with QUANTA_ITEM_STREAM on, plan events do NOT ALSO emit a plan.* observation (unify, not add)", () => {
    // When item-stream is the owner, the gated agent-state observation projector
    // must NOT re-emit the plan trio as `plan.*` (which would double-carry plan
    // state on both channels). subagent_cancel was never a plan.* observation.
    const owned = { QUANTA_ITEM_STREAM: "1" }
    for (const ev of [planCreated, planUpdated, planSnapshot]) {
      const obs = projectAgentEventToItemStreamObservationsGated(ev, owned)
      // The plan trio is now OWNED by the item-stream ⇒ the plan.* mirror is
      // suppressed (returns null for these when the gate owns them).
      expect(obs).toBeNull()
    }
  })

  test("with QUANTA_ITEM_STREAM off, the legacy plan.* host-mirror still flows (byte-identical legacy)", () => {
    const off = {}
    for (const ev of [planCreated, planUpdated, planSnapshot]) {
      const obs = projectAgentEventToItemStreamObservationsGated(ev, off)
      expect(obs).not.toBeNull()
    }
  })
})

/**
 * S2 no-4th-path AT THE LIVE WIRE (audit jul-03) — the isolated-function tests
 * above prove `projectAgentEventToItemStreamObservationsGated` returns null, but
 * do NOT prove the composition seam (`wireAgentStateTap` inside
 * `wireOptionalAgentPorts`) actually CALLS the gated projector. A de-wire at that
 * seam (reverting to the raw `projectAgentEventToAgentStateObservation`) leaves
 * both the isolated function AND the reasoning-only tap-wire test green while the
 * web plane silently double-carries plan on BOTH `plan.*` AND `item.*` — the 4th
 * path this feature forbids. These tests drive a plan event THROUGH the fully
 * composed stream and assert the plane split by BEHAVIOUR.
 */
const wiredCapture = (
  env: Record<string, string | undefined>,
): { stream: StreamPort; captured: AgentStateObservation[] } => {
  const captured: AgentStateObservation[] = []
  const base = {
    llm: { model: "m" } as unknown as LLMPort,
    signal: new AbortController().signal,
    stream: { emit: () => {} },
    onAgentState: { capture: (e: AgentStateObservation) => void captured.push(e) },
  } as unknown as AgentConfig
  const out = wireOptionalAgentPorts(base, env)
  return { stream: out.stream as StreamPort, captured }
}

describe("S2 no-4th-path — WIRED: the composition seam actually enforces the split", () => {
  test("gate ON ⇒ plan flows as item_stream cores AND NO plan.* observation reaches the sink", () => {
    const { stream, captured } = wiredCapture({
      QUANTA_ITEM_STREAM: "1",
      QUANTA_WEB_AGENT_STATE: "1",
    })
    stream.emit(planCreated)
    stream.emit(planUpdated)

    const itemObs = captured.filter((o) => o.type === "item_stream")
    // Not vacuous — plan folded onto item cores DID reach the item plane.
    expect(itemObs.length).toBeGreaterThan(0)
    expect(
      itemObs.every((o) => (o.type === "item_stream" ? o.item.itemType === "plan" : false)),
    ).toBe(true)
    // THE no-4th-path invariant: the raw plan.* host-mirror observation is
    // suppressed at the LIVE seam, so plan never double-carries.
    const planMirror = captured.filter(
      (o) => o.type === "plan_created" || o.type === "plan_updated" || o.type === "plan_snapshot",
    )
    expect(planMirror.length).toBe(0)
  })

  test("gate OFF ⇒ the legacy plan.* host-mirror DOES flow at the wire (byte-identical legacy)", () => {
    // WEB_AGENT_STATE on, ITEM_STREAM off: the item-stream does not own plan, so
    // the host-mirror plan.* observation must still reach the sink unchanged.
    const { stream, captured } = wiredCapture({ QUANTA_WEB_AGENT_STATE: "1" })
    stream.emit(planCreated)
    const planMirror = captured.filter((o) => o.type === "plan_created")
    expect(planMirror.length).toBe(1)
    expect(captured.some((o) => o.type === "item_stream")).toBe(false)
  })
})

/**
 * S2 fleet PUMP (jul-03 deferred-wiring closure) — the production bridge
 * `pumpFleetRowsToItemStream` makes the fleet (subagent) side of the unification
 * REACHABLE. Before this, `fleetToItemStream` had NO production caller (the audit
 * flagged it INERT). These tests pin the gate contract of the pump itself + the
 * fail-silent posture, RED-on-injection.
 */
const rows = (): AgentFleetRow[] => [
  { id: "s1", description: "scout", status: "running", startedAt: 1 },
  {
    id: "s2",
    description: "builder",
    status: "completed",
    startedAt: 1,
    endedAt: 9,
    result: { ok: true, finalText: "done", turns: 3 },
  },
]

const collectSink = (): { sink: ItemStreamSink; got: ItemStreamCore[] } => {
  const got: ItemStreamCore[] = []
  return { sink: { capture: (item) => void got.push(item) }, got }
}

describe("S2 fleet PUMP — the production bridge gates + reaches the item wire", () => {
  test("gate ON (env) ⇒ fleet rows are pumped onto the sink as subagent item cores", () => {
    const { sink, got } = collectSink()
    const n = pumpFleetRowsToItemStream(rows(), sink, { QUANTA_ITEM_STREAM: "1" })
    // Not vacuous: the pump minted cores AND they landed on the sink.
    expect(n).toBeGreaterThan(0)
    expect(got.length).toBe(n)
    expect(got.every((c) => c.itemType === "subagent")).toBe(true)
    // The running row is an OPEN item; the settled row completes with detail.
    expect(got.some((c) => c.phase === "started" && c.itemId === "item-subagent-s1")).toBe(true)
    expect(got.some((c) => c.phase === "completed" && c.itemId === "item-subagent-s2")).toBe(true)
  })

  test("gate OFF (env) ⇒ NO core is minted and the sink is NEVER touched (byte-identical)", () => {
    const { sink, got } = collectSink()
    // Mutation guard: dropping the `env !== undefined && !enabled` gate turns this
    // red (the pump would fire with the flag off).
    expect(pumpFleetRowsToItemStream(rows(), sink, {})).toBe(0)
    expect(got.length).toBe(0)
  })

  test("absent sink ⇒ no-op (a surface with no wire plane; presence-gate byte-identical)", () => {
    // env says ON, but the composition root threaded no sink ⇒ nothing happens.
    expect(pumpFleetRowsToItemStream(rows(), undefined, { QUANTA_ITEM_STREAM: "1" })).toBe(0)
  })

  test("presence-gated caller (no env arg) ⇒ pump fires (the CLI /activity path)", () => {
    // The CLI seam presence-gates the sink at the composition root, so it calls
    // the pump WITHOUT an env arg; a non-undefined sink is the proof the gate
    // already passed. Mutation guard: making the `env === undefined` branch skip
    // the pump turns this red.
    const { sink, got } = collectSink()
    const n = pumpFleetRowsToItemStream(rows(), sink)
    expect(n).toBeGreaterThan(0)
    expect(got.length).toBe(n)
  })

  test("throwing sink is fail-silent (never breaks the caller's activity render)", () => {
    const boom: ItemStreamSink = {
      capture: () => {
        throw new Error("sink blew up")
      },
    }
    // No throw escapes; the count still reflects the cores it attempted.
    let n = -1
    expect(() => {
      n = pumpFleetRowsToItemStream(rows(), boom, { QUANTA_ITEM_STREAM: "1" })
    }).not.toThrow()
    expect(n).toBeGreaterThan(0)
  })

  test("pump preserves the item-subagent-<id> join key (cross-producer contract)", () => {
    // The pumped fleet core and the projector's subagent_cancel arm MUST agree on
    // the join key so a surface stitches the fleet row to its cancel on ONE id.
    const { sink, got } = collectSink()
    pumpFleetRowsToItemStream(
      [{ id: "sub-9", description: "x", status: "running", startedAt: 1 }],
      sink,
      { QUANTA_ITEM_STREAM: "1" },
    )
    const cancelCores = collect([
      {
        type: "subagent_cancel",
        subagentId: "sub-9",
        outcome: "stopped",
        source: "submission_op",
      } as AgentEvent,
    ])
    expect(got[0]?.itemId).toBe("item-subagent-sub-9")
    expect(cancelCores.every((c) => c.itemId === "item-subagent-sub-9")).toBe(true)
  })
})

/**
 * S2 fleet PUMP AT THE LIVE `/activity` SEAM (jul-03) — the isolated pump tests
 * above prove the function gates, but do NOT prove the `/activity` command
 * actually CALLS it at the fleet→tree seam. De-wiring the `pumpFleetRowsToItemStream`
 * call in `activityCmd` leaves the whole pump suite green while the fleet never
 * reaches the wire — the exact INERT state this closure removes. These drive a
 * fleet snapshot THROUGH `runSlashCommand("/activity")` and assert by BEHAVIOUR.
 */
const baseActivityCtx = (out: string[]): SlashContext =>
  ({
    out: (s: string) => void out.push(s),
    err: () => {},
    cwd: "/tmp",
    now: () => 1000,
    agents: (): readonly AgentFleetRow[] => [
      { id: "sub-live", description: "live scout", status: "running", startedAt: 1 },
    ],
  }) as unknown as SlashContext

describe("S2 fleet PUMP — WIRED: /activity actually pumps the fleet onto the sink", () => {
  test("sink present ⇒ /activity pumps the live fleet as a subagent item core", async () => {
    const out: string[] = []
    const got: ItemStreamCore[] = []
    const ctx = {
      ...baseActivityCtx(out),
      itemStreamSink: { capture: (i: ItemStreamCore) => void got.push(i) },
    } as unknown as SlashContext
    const code = await runSlashCommand("/activity", ctx)
    expect(code).toBe(0)
    // The tree still rendered (byte-identical render path).
    expect(out.join("")).toContain("live scout")
    // AND the live subagent surfaced as a co-equal item core on the wire.
    expect(got.length).toBeGreaterThan(0)
    expect(got[0]?.itemType).toBe("subagent")
    expect(got[0]?.itemId).toBe("item-subagent-sub-live")
  })

  test("sink ABSENT ⇒ /activity renders identically and touches NO wire (byte-identical OFF)", async () => {
    const outWith: string[] = []
    const outWithout: string[] = []
    // Same fleet, one ctx with the sink slot present-but-omitted (default-OFF).
    const ctxOff = baseActivityCtx(outWithout)
    const codeOff = await runSlashCommand("/activity", ctxOff)
    expect(codeOff).toBe(0)

    // Control: the render is IDENTICAL whether or not a sink is threaded — the
    // pump is a pure side-channel; it never perturbs the /activity output.
    const got: ItemStreamCore[] = []
    const ctxOn = {
      ...baseActivityCtx(outWith),
      itemStreamSink: { capture: (i: ItemStreamCore) => void got.push(i) },
    } as unknown as SlashContext
    await runSlashCommand("/activity", ctxOn)
    expect(outWith.join("")).toBe(outWithout.join(""))
    // And with no sink, nothing was captured (there is nowhere to capture TO).
    expect(got.length).toBeGreaterThan(0) // sanity: the ON path DID capture
  })
})

describe("S2 fleet PUMP — dual-plane: fleet-produced cores carry byte-identically", () => {
  test("a fleet completed core round-trips identically on session.v1 AND agent-state", () => {
    // The pump emits the SAME ItemStreamCore shape both wire transports carry
    // verbatim. Prove the fleet-produced core (a JSON drilldown body — NOT the
    // cancel arm) is byte-identical across planes, closing the audit's
    // "drift on both planes" for the SUBAGENT-via-fleet path specifically.
    const cores = fleetToItemStream([
      {
        id: "sX",
        description: "b",
        agentType: "coder",
        status: "completed",
        startedAt: 1,
        endedAt: 9,
        result: { ok: true, finalText: "ok", turns: 2 },
      },
    ])
    expect(cores.some((c) => c.itemType === "subagent")).toBe(true)
    const state = createKernelSessionState({
      sessionId: "s2-fleet-drift",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    for (const core of cores) {
      const sessionEvent = projectSessionHostTurnEvent({
        state,
        commandId: "c1",
        emittedAt: "2026-07-03T00:00:00.000Z",
        event: { type: "item.stream", item: core },
      }).emitted
      const message = itemCoreToAgentStateMessage(core, 1)
      const expected = coreFields(core)
      expect(sessionEventFields(sessionEvent)).toEqual(expected)
      expect(agentStateFields(message)).toEqual(expected)
    }
  })
})

// Registry hygiene: /activity is still a registered surface builtin (the wiring
// did not drop or rename it).
describe("S2 fleet PUMP — /activity remains a registered builtin", () => {
  test("/activity is in BUILTINS", () => {
    expect(BUILTINS.map((c) => c.name)).toContain("/activity")
  })
})
